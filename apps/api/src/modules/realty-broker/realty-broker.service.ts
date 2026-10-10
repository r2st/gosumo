import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type {
  realty_approvals,
  realty_account_settings,
  realty_broker_alerts,
  realty_conversation_control,
} from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  ApprovalStatus,
  AutonomyLevel,
  ConversationOwner,
  BrokerAlertType,
  LeadStage,
  LeadTemperature,
} from '@gosumo/shared';
import type {
  HotLeadDossier,
  MorningBriefing,
  BriefingItem,
  BrokerConsoleMetrics,
  RealtyLeadHotEvent,
  RealtyBrokerAlertEvent,
  RealtyApprovalCreatedEvent,
  RealtyApprovalResolvedEvent,
  RealtyConversationTakenOverEvent,
} from '@gosumo/shared';
import { RealtyBrokerRepository } from './realty-broker.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import type { LeadResponseDto } from '../realty-leads/realty-leads.service';
import { RealtyCadenceService } from '../realty-cadence/realty-cadence.service';
import {
  CreateApprovalDto,
  ResolveApprovalDto,
  UpdateSettingsDto,
} from './dto';

// ─────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────

export interface ApprovalResponseDto {
  id: string;
  leadId: string;
  conversationId: string | null;
  draftText: string;
  editedText: string | null;
  confidence: number;
  intent: string | null;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reason: string | null;
  createdAt: Date;
}

export interface SettingsResponseDto {
  autonomyLevel: string;
  autoApproveThreshold: number;
  killSwitch: boolean;
  briefingEnabled: boolean;
  briefingHour: number;
  briefingMinute: number;
  hotAlertWhatsapp: string | null;
}

export interface AlertResponseDto {
  id: string;
  type: string;
  leadId: string | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  isRead: boolean;
  readAt: Date | null;
  createdAt: Date;
}

export interface ControlResponseDto {
  conversationId: string;
  owner: string;
  takenOverBy: string | null;
  takenOverAt: Date | null;
  releasedAt: Date | null;
}

export interface AutonomyDecision {
  autoSend: boolean;
  reason: string;
}

/**
 * RealtyBrokerService — the broker surface (blueprint §16): hot-lead alerts, the
 * morning briefing, the AI-draft approval queue, the takeover protocol, the
 * autonomy dial, and the broker-console metrics.
 */
@Injectable()
export class RealtyBrokerService {
  private readonly logger = new Logger(RealtyBrokerService.name);

  constructor(
    private readonly repository: RealtyBrokerRepository,
    private readonly leadsService: RealtyLeadsService,
    private readonly cadenceService: RealtyCadenceService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // ACCOUNT SETTINGS / AUTONOMY DIAL
  // ─────────────────────────────────────────────

  /** Fetch settings, lazily creating the single per-business row on first read. */
  async getSettings(businessId: string): Promise<realty_account_settings> {
    const existing = await this.repository.findSettings(businessId);
    if (existing) return existing;
    return this.repository.createSettings(businessId);
  }

  async getSettingsDto(businessId: string): Promise<SettingsResponseDto> {
    return this.mapSettings(await this.getSettings(businessId));
  }

  async updateSettings(businessId: string, dto: UpdateSettingsDto): Promise<SettingsResponseDto> {
    await this.getSettings(businessId); // ensure row exists
    const d: Record<string, unknown> = {};
    if (dto.autonomyLevel !== undefined) d['autonomy_level'] = dto.autonomyLevel;
    if (dto.autoApproveThreshold !== undefined) d['auto_approve_threshold'] = dto.autoApproveThreshold;
    if (dto.killSwitch !== undefined) d['kill_switch'] = dto.killSwitch;
    if (dto.briefingEnabled !== undefined) d['briefing_enabled'] = dto.briefingEnabled;
    if (dto.briefingHour !== undefined) d['briefing_hour'] = dto.briefingHour;
    if (dto.briefingMinute !== undefined) d['briefing_minute'] = dto.briefingMinute;
    if (dto.hotAlertWhatsapp !== undefined) d['hot_alert_whatsapp'] = dto.hotAlertWhatsapp;
    const updated = await this.repository.updateSettings(businessId, d);
    this.logger.log(`Updated broker settings for ${businessId} (autonomy=${updated.autonomy_level})`);
    return this.mapSettings(updated);
  }

  /**
   * The autonomy dial in one call: may the AI auto-send a reply at `confidence`?
   * The kill switch and an active human takeover both force a hard no.
   */
  async evaluateAutonomy(
    businessId: string,
    confidence: number,
    conversationId?: string,
  ): Promise<AutonomyDecision> {
    const settings = await this.getSettings(businessId);
    if (settings.kill_switch) return { autoSend: false, reason: 'kill_switch' };

    if (conversationId) {
      const control = await this.repository.findControl(businessId, conversationId);
      if (control && control.owner === ConversationOwner.HUMAN) {
        return { autoSend: false, reason: 'human_owned' };
      }
    }

    if (settings.autonomy_level === AutonomyLevel.SUGGEST) {
      return { autoSend: false, reason: 'suggest_mode' };
    }
    if (confidence >= settings.auto_approve_threshold) {
      return { autoSend: true, reason: 'confidence_ok' };
    }
    return { autoSend: false, reason: 'below_threshold' };
  }

  // ─────────────────────────────────────────────
  // EVIDENCE READS (consumed by the Phase-8 autonomy dial + launch gate)
  // ─────────────────────────────────────────────

  /**
   * Approval-queue accuracy evidence: how many drafts have been resolved, and
   * of those how many were approved verbatim (the AI got it exactly right).
   */
  async getApprovalStats(businessId: string): Promise<{ resolved: number; approvedVerbatim: number }> {
    const counts = await this.repository.approvalStatusCounts(businessId);
    const approvedVerbatim = counts[ApprovalStatus.APPROVED] ?? 0;
    const resolved =
      approvedVerbatim + (counts[ApprovalStatus.EDITED] ?? 0) + (counts[ApprovalStatus.REJECTED] ?? 0);
    return { resolved, approvedVerbatim };
  }

  /**
   * Share of hot-lead alerts acted on (marked read) within 30 minutes — the
   * KPI proxy for hot-alert responsiveness. Returns null when there are none.
   */
  async getHotAlertActionRate(businessId: string, since?: Date): Promise<number | null> {
    const alerts = await this.repository.findHotAlerts(businessId, since);
    if (alerts.length === 0) return null;
    const THIRTY_MIN_MS = 30 * 60 * 1000;
    const acted = alerts.filter(
      (a) => a.read_at != null && a.read_at.getTime() - a.created_at.getTime() <= THIRTY_MIN_MS,
    ).length;
    return acted / alerts.length;
  }

  /** Percentage of asserted conversations the AI still owns (vs human takeover). */
  async getAiHandledPct(businessId: string): Promise<number> {
    const control = await this.repository.countControlByOwner(businessId);
    const total = control.ai + control.human;
    return total === 0 ? 100 : Math.round((control.ai / total) * 100);
  }

  // ─────────────────────────────────────────────
  // APPROVAL QUEUE
  // ─────────────────────────────────────────────

  async createApproval(businessId: string, dto: CreateApprovalDto): Promise<ApprovalResponseDto> {
    const approval = await this.repository.createApproval({
      businessId,
      leadId: dto.leadId,
      conversationId: dto.conversationId,
      draftText: dto.draftText,
      confidence: dto.confidence,
      intent: dto.intent,
    });

    this.emit<RealtyApprovalCreatedEvent>('realty.approval.created', {
      ...this.baseEvent(businessId),
      type: 'realty.approval.created',
      approvalId: approval.id,
      leadId: dto.leadId,
      conversationId: dto.conversationId,
      confidence: dto.confidence,
    });

    await this.pushAlert(businessId, {
      type: BrokerAlertType.APPROVAL_PENDING,
      leadId: dto.leadId,
      title: 'AI draft awaiting your review',
      body: dto.draftText.slice(0, 160),
      payload: { approvalId: approval.id, confidence: dto.confidence },
    });

    return this.mapApproval(approval);
  }

  async listApprovals(
    businessId: string,
    filters: { status?: string; leadId?: string },
  ): Promise<ApprovalResponseDto[]> {
    const rows = await this.repository.listApprovals(businessId, filters);
    return rows.map((a) => this.mapApproval(a));
  }

  async getApproval(businessId: string, id: string): Promise<ApprovalResponseDto> {
    return this.mapApproval(await this.mustFindApproval(businessId, id));
  }

  /**
   * Resolve a queued draft — approve verbatim, approve with edits, or reject.
   * A resolved draft's final text is emitted for the sender to dispatch.
   */
  async resolveApproval(
    businessId: string,
    id: string,
    dto: ResolveApprovalDto,
    reviewedBy?: string,
  ): Promise<ApprovalResponseDto> {
    const approval = await this.mustFindApproval(businessId, id);
    if (approval.status !== ApprovalStatus.PENDING) {
      throw new BadRequestException(`Approval ${id} is already ${approval.status}`);
    }
    if (dto.status === ApprovalStatus.EDITED && !dto.editedText?.trim()) {
      throw new BadRequestException('editedText is required when status = EDITED');
    }
    if (![ApprovalStatus.APPROVED, ApprovalStatus.EDITED, ApprovalStatus.REJECTED].includes(dto.status)) {
      throw new BadRequestException('status must be APPROVED, EDITED, or REJECTED');
    }

    const updated = await this.repository.updateApproval(businessId, id, {
      status: dto.status,
      edited_text: dto.status === ApprovalStatus.EDITED ? dto.editedText : null,
      reason: dto.reason ?? null,
      reviewed_by: reviewedBy ?? null,
      reviewed_at: new Date(),
    });

    this.emit<RealtyApprovalResolvedEvent>('realty.approval.resolved', {
      ...this.baseEvent(businessId),
      type: 'realty.approval.resolved',
      approvalId: id,
      leadId: approval.lead_id,
      outcome: dto.status,
      reviewedBy,
    });
    this.logger.log(`Approval ${id} resolved: ${dto.status}`);
    return this.mapApproval(updated);
  }

  // ─────────────────────────────────────────────
  // NOTIFICATION CENTRE (alerts)
  // ─────────────────────────────────────────────

  async listAlerts(
    businessId: string,
    filters: { unreadOnly?: boolean; type?: string },
  ): Promise<{ alerts: AlertResponseDto[]; unread: number }> {
    const [rows, unread] = await Promise.all([
      this.repository.listAlerts(businessId, filters),
      this.repository.countUnreadAlerts(businessId),
    ]);
    return { alerts: rows.map((a) => this.mapAlert(a)), unread };
  }

  async markAlertRead(businessId: string, id: string): Promise<AlertResponseDto> {
    const alert = await this.repository.findAlertById(businessId, id);
    if (!alert) throw new NotFoundException('Alert not found');
    return this.mapAlert(await this.repository.markAlertRead(businessId, id));
  }

  async markAllAlertsRead(businessId: string): Promise<{ marked: number }> {
    return { marked: await this.repository.markAllAlertsRead(businessId) };
  }

  /** Create an alert and emit the broker.alert event (used across the surface). */
  private async pushAlert(
    businessId: string,
    input: {
      type: BrokerAlertType;
      leadId?: string | null;
      title: string;
      body?: string | null;
      payload?: Record<string, unknown>;
    },
  ): Promise<realty_broker_alerts> {
    const alert = await this.repository.createAlert({
      businessId,
      type: input.type as realty_broker_alerts['type'],
      leadId: input.leadId,
      title: input.title,
      body: input.body,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
    });
    this.emit<RealtyBrokerAlertEvent>('realty.broker.alert', {
      ...this.baseEvent(businessId),
      type: 'realty.broker.alert',
      alertId: alert.id,
      alertType: input.type,
      leadId: input.leadId ?? undefined,
      title: input.title,
    });
    return alert;
  }

  // ─────────────────────────────────────────────
  // TAKEOVER PROTOCOL
  // ─────────────────────────────────────────────

  /** Hand a conversation to a human — the AI stops sending autonomously. */
  async takeOver(
    businessId: string,
    conversationId: string,
    userId?: string,
    leadId?: string,
  ): Promise<ControlResponseDto> {
    const control = await this.repository.upsertControl(businessId, conversationId, {
      owner: ConversationOwner.HUMAN as realty_conversation_control['owner'],
      leadId: leadId ?? null,
      takenOverBy: userId ?? null,
      takenOverAt: new Date(),
      releasedAt: null,
    });
    this.emit<RealtyConversationTakenOverEvent>('realty.conversation.taken_over', {
      ...this.baseEvent(businessId),
      type: 'realty.conversation.taken_over',
      conversationId,
      leadId,
      owner: ConversationOwner.HUMAN,
      takenOverBy: userId,
    });
    await this.pushAlert(businessId, {
      type: BrokerAlertType.TAKEOVER,
      leadId: leadId ?? null,
      title: 'You took over a conversation',
      body: `Conversation ${conversationId} is now human-handled.`,
      payload: { conversationId },
    });
    this.logger.log(`Conversation ${conversationId} taken over by ${userId ?? 'broker'}`);
    return this.mapControl(control);
  }

  /** Return control to the AI. */
  async release(businessId: string, conversationId: string): Promise<ControlResponseDto> {
    const control = await this.repository.upsertControl(businessId, conversationId, {
      owner: ConversationOwner.AI as realty_conversation_control['owner'],
      releasedAt: new Date(),
      takenOverBy: null,
      takenOverAt: null,
    });
    this.emit<RealtyConversationTakenOverEvent>('realty.conversation.taken_over', {
      ...this.baseEvent(businessId),
      type: 'realty.conversation.taken_over',
      conversationId,
      owner: ConversationOwner.AI,
    });
    return this.mapControl(control);
  }

  async getControl(businessId: string, conversationId: string): Promise<ControlResponseDto> {
    const control = await this.repository.findControl(businessId, conversationId);
    if (control) return this.mapControl(control);
    // No row yet ⇒ the AI owns it by default.
    return {
      conversationId,
      owner: ConversationOwner.AI,
      takenOverBy: null,
      takenOverAt: null,
      releasedAt: null,
    };
  }

  // ─────────────────────────────────────────────
  // MORNING BRIEFING (7:30 AM)
  // ─────────────────────────────────────────────

  /** Build the broker's daily digest (pure read — does not push an alert). */
  async buildBriefing(businessId: string, now: Date = new Date()): Promise<MorningBriefing> {
    const [leadsPage, pipeline, pendingApprovals] = await Promise.all([
      this.leadsService.listLeads(businessId, { limit: 100 }),
      this.leadsService.getBoard(businessId),
      this.repository.countApprovals(businessId, ApprovalStatus.PENDING),
    ]);
    const leads = leadsPage.data as LeadResponseDto[];
    const endOfDay = this.endOfDay(now);

    const hotLeads: BriefingItem[] = leads
      .filter((l) => l.temperature === LeadTemperature.HOT)
      .slice(0, 10)
      .map((l) => ({ leadId: l.id, name: l.name, detail: this.bltcSummary(l) }));

    const visitsToday: BriefingItem[] = leads
      .filter((l) => l.stage === LeadStage.VISIT_BOOKED)
      .slice(0, 20)
      .map((l) => ({ leadId: l.id, name: l.name, detail: this.bltcSummary(l) }));

    const followupsDue: BriefingItem[] = leads
      .filter((l) => l.nextFollowupAt != null && new Date(l.nextFollowupAt) <= endOfDay && !l.optOut)
      .slice(0, 20)
      .map((l) => ({
        leadId: l.id,
        name: l.name,
        detail: `Follow-up due · ${this.bltcSummary(l)}`,
      }));

    return {
      date: this.istDateString(now),
      hotLeads,
      visitsToday,
      followupsDue,
      pendingApprovals,
      pipeline,
      generatedAt: now.toISOString(),
    };
  }

  /** Build the briefing AND push it to the notification centre (the 7:30 job). */
  async generateAndPushBriefing(businessId: string, now: Date = new Date()): Promise<MorningBriefing> {
    const settings = await this.getSettings(businessId);
    const briefing = await this.buildBriefing(businessId, now);
    if (settings.briefing_enabled) {
      await this.pushAlert(businessId, {
        type: BrokerAlertType.MORNING_BRIEFING,
        title: `Morning briefing — ${briefing.date}`,
        body:
          `${briefing.hotLeads.length} hot · ${briefing.visitsToday.length} visits · ` +
          `${briefing.followupsDue.length} follow-ups · ${briefing.pendingApprovals} to approve`,
        payload: briefing as unknown as Record<string, unknown>,
      });
    }
    return briefing;
  }

  // ─────────────────────────────────────────────
  // BROKER CONSOLE METRICS
  // ─────────────────────────────────────────────

  async getConsoleMetrics(businessId: string): Promise<BrokerConsoleMetrics> {
    const [board, hotPage, pendingApprovals, settings, control, enrollments, briefing] =
      await Promise.all([
        this.leadsService.getBoard(businessId),
        this.leadsService.listLeads(businessId, { temperature: LeadTemperature.HOT, limit: 1 }),
        this.repository.countApprovals(businessId, ApprovalStatus.PENDING),
        this.getSettings(businessId),
        this.repository.countControlByOwner(businessId),
        this.cadenceService.listEnrollments(businessId, { status: 'ACTIVE' }),
        this.buildBriefing(businessId),
      ]);

    const closedStages = new Set<string>([LeadStage.CLOSED_WON, LeadStage.CLOSED_LOST]);
    const activeLeads = board
      .filter((b) => !closedStages.has(b.stage))
      .reduce((sum, b) => sum + b.count, 0);

    const totalControlled = control.ai + control.human;
    const aiHandledPct = totalControlled === 0 ? 100 : Math.round((control.ai / totalControlled) * 100);

    return {
      activeLeads,
      hotLeads: hotPage.total,
      pendingApprovals,
      followupsDueToday: briefing.followupsDue.length,
      activeCadences: enrollments.length,
      autonomyLevel: settings.autonomy_level,
      aiHandledPct,
    };
  }

  // ─────────────────────────────────────────────
  // EVENT LISTENERS
  // ─────────────────────────────────────────────

  /** A lead just turned HOT — build and push the dossier instantly (blueprint §16). */
  @OnEvent('realty.lead.hot')
  async onLeadHot(event: RealtyLeadHotEvent): Promise<void> {
    try {
      const lead = await this.leadsService.getLead(event.businessId, event.leadId);
      const dossier = this.buildDossier(lead);
      await this.pushAlert(event.businessId, {
        type: BrokerAlertType.HOT_LEAD,
        leadId: event.leadId,
        title: `🔥 Hot lead: ${lead.name ?? lead.whatsappPhone} (score ${lead.qualScore})`,
        body: this.bltcSummary(lead),
        payload: dossier as unknown as Record<string, unknown>,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to build hot-lead dossier for ${event.leadId}: ${message}`);
    }
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private buildDossier(lead: LeadResponseDto): HotLeadDossier {
    return {
      leadId: lead.id,
      name: lead.name,
      whatsappPhone: lead.whatsappPhone,
      qualScore: lead.qualScore,
      temperature: lead.temperature,
      stage: lead.stage,
      source: lead.source,
      bltcSummary: this.bltcSummary(lead),
      matchedUnitIds: lead.matchedUnitIds ?? [],
      conversationId: lead.conversationId,
      assignedAgentId: lead.assignedAgentId,
    };
  }

  /** A compact one-line BLTC summary for cards and alerts. */
  private bltcSummary(lead: LeadResponseDto): string {
    const bits: string[] = [];
    if (lead.bltc.config) bits.push(lead.bltc.config);
    if (lead.bltc.localities?.length) bits.push(lead.bltc.localities[0]!);
    const { budgetMinPaise, budgetMaxPaise } = lead.bltc;
    if (budgetMinPaise != null || budgetMaxPaise != null) {
      const fmt = (p: number) => `₹${(p / 100 / 100000).toFixed(1)}L`;
      if (budgetMinPaise != null && budgetMaxPaise != null) {
        bits.push(`${fmt(budgetMinPaise)}–${fmt(budgetMaxPaise)}`);
      } else {
        bits.push(fmt((budgetMaxPaise ?? budgetMinPaise)!));
      }
    }
    if (lead.bltc.timelineMonths != null) bits.push(`${lead.bltc.timelineMonths}mo`);
    return bits.length ? bits.join(' · ') : 'No requirement captured yet';
  }

  private endOfDay(now: Date): Date {
    const d = new Date(now);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  private istDateString(now: Date): string {
    // IST is UTC+5:30; the briefing is a per-day digest keyed to the IST date.
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(0, 10);
  }

  private async mustFindApproval(businessId: string, id: string): Promise<realty_approvals> {
    const a = await this.repository.findApprovalById(businessId, id);
    if (!a) throw new NotFoundException('Approval not found');
    return a;
  }

  private mapApproval(a: realty_approvals): ApprovalResponseDto {
    return {
      id: a.id,
      leadId: a.lead_id,
      conversationId: a.conversation_id,
      draftText: a.draft_text,
      editedText: a.edited_text,
      confidence: a.confidence,
      intent: a.intent,
      status: a.status,
      reviewedBy: a.reviewed_by,
      reviewedAt: a.reviewed_at,
      reason: a.reason,
      createdAt: a.created_at,
    };
  }

  private mapSettings(s: realty_account_settings): SettingsResponseDto {
    return {
      autonomyLevel: s.autonomy_level,
      autoApproveThreshold: s.auto_approve_threshold,
      killSwitch: s.kill_switch,
      briefingEnabled: s.briefing_enabled,
      briefingHour: s.briefing_hour,
      briefingMinute: s.briefing_minute,
      hotAlertWhatsapp: s.hot_alert_whatsapp,
    };
  }

  private mapAlert(a: realty_broker_alerts): AlertResponseDto {
    return {
      id: a.id,
      type: a.type,
      leadId: a.lead_id,
      title: a.title,
      body: a.body,
      payload: (a.payload ?? {}) as Record<string, unknown>,
      isRead: a.is_read,
      readAt: a.read_at,
      createdAt: a.created_at,
    };
  }

  private mapControl(c: realty_conversation_control): ControlResponseDto {
    return {
      conversationId: c.conversation_id,
      owner: c.owner,
      takenOverBy: c.taken_over_by,
      takenOverAt: c.taken_over_at,
      releasedAt: c.released_at,
    };
  }

  private baseEvent(businessId: string) {
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
    };
  }

  private emit<T>(name: string, payload: T): void {
    this.eventEmitter.emit(name, payload);
  }
}
