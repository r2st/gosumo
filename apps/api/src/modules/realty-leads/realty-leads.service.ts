import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { realty_leads } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  LeadStage,
  LeadSource,
} from '@gosumo/shared';
import type {
  BltcProfile,
  LeadMemoryEntry,
  LeadScoreResult,
  RealtyLeadCreatedEvent,
  RealtyLeadQualifiedEvent,
  RealtyLeadStageChangedEvent,
  RealtyLeadHotEvent,
  RealtyLeadOptedOutEvent,
  MessageReceivedEvent,
} from '@gosumo/shared';
import { RealtyLeadsRepository } from './realty-leads.repository';
import type { UpdateLeadData } from './realty-leads.repository';
import {
  scoreLead,
  isBltcComplete,
  HOT_SCORE_THRESHOLD,
} from './lead-scoring.util';
import {
  CreateLeadDto,
  UpdateLeadDto,
  BltcUpdateDto,
  TransitionStageDto,
  CaptureMemoryDto,
  ListLeadsQueryDto,
} from './dto';

// ─────────────────────────────────────────────
// Response + helper types
// ─────────────────────────────────────────────

export interface LeadResponseDto {
  id: string;
  businessId: string;
  assignedAgentId: string | null;
  conversationId: string | null;
  clientId: string | null;
  whatsappPhone: string;
  altPhone: string | null;
  email: string | null;
  name: string | null;
  languagePref: string;
  source: string;
  subSource: string | null;
  listingRef: string | null;
  firstTouchAt: Date;
  bltc: BltcProfile;
  qualScore: number;
  temperature: string;
  stage: string;
  matchedUnitIds: string[];
  extractedFacts: LeadMemoryEntry[];
  objections: LeadMemoryEntry[];
  promises: LeadMemoryEntry[];
  optOut: boolean;
  shareConsent: boolean;
  exchangeStatus: string;
  nextFollowupAt: Date | null;
  lastActivityAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BltcUpdateResult {
  lead: LeadResponseDto;
  /** Slots whose existing value differed from the incoming one (not overwritten unless forced). */
  contradictions: Array<{ slot: string; existing: unknown; incoming: unknown }>;
  score: LeadScoreResult;
  qualified: boolean;
}

// ─────────────────────────────────────────────
// Money helpers (rupees Decimal ↔ paise integer at the boundary)
// ─────────────────────────────────────────────

function paiseToDecimal(paise: number): Prisma.Decimal {
  return new Prisma.Decimal(paise).div(100);
}

function decimalToPaise(d: Prisma.Decimal | null): number | null {
  if (d === null || d === undefined) return null;
  return new Prisma.Decimal(d).mul(100).round().toNumber();
}

/**
 * RealtyLeadsService — the AI Lead Manager's system of record (blueprint §5).
 *
 * Owns lead capture with attribution, conversational BLTC qualification with
 * contradiction detection, scoring + temperature, pipeline stage transitions,
 * permanent memory (facts/objections/promises), opt-out, and hot-lead alerts.
 */
@Injectable()
export class RealtyLeadsService {
  private readonly logger = new Logger(RealtyLeadsService.name);

  constructor(
    private readonly repository: RealtyLeadsRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // CAPTURE
  // ─────────────────────────────────────────────

  async createLead(businessId: string, dto: CreateLeadDto): Promise<LeadResponseDto> {
    // One buyer, one history: merge on E.164 phone (blueprint §15).
    const existing = await this.repository.findByPhone(businessId, dto.whatsappPhone);
    if (existing) {
      throw new ConflictException(
        `A lead with phone ${dto.whatsappPhone} already exists (${existing.id})`,
      );
    }

    const lead = await this.repository.create({
      businessId,
      whatsappPhone: dto.whatsappPhone,
      source: dto.source,
      name: dto.name,
      email: dto.email,
      altPhone: dto.altPhone,
      languagePref: dto.languagePref,
      subSource: dto.subSource,
      listingRef: dto.listingRef,
      assignedAgentId: dto.assignedAgentId,
      conversationId: dto.conversationId,
      clientId: dto.clientId,
    });

    this.emit<RealtyLeadCreatedEvent>('realty.lead.created', {
      ...this.baseEvent(businessId),
      type: 'realty.lead.created',
      leadId: lead.id,
      source: lead.source,
      whatsappPhone: lead.whatsapp_phone,
      listingRef: lead.listing_ref ?? undefined,
      conversationId: lead.conversation_id ?? undefined,
    });

    this.logger.log(`Captured lead ${lead.id} (${lead.source}) for business ${businessId}`);
    return this.mapResponse(lead);
  }

  async getLead(businessId: string, leadId: string): Promise<LeadResponseDto> {
    const lead = await this.mustFind(businessId, leadId);
    return this.mapResponse(lead);
  }

  async updateLead(
    businessId: string,
    leadId: string,
    dto: UpdateLeadDto,
  ): Promise<LeadResponseDto> {
    await this.mustFind(businessId, leadId);
    const data: UpdateLeadData = { lastActivityAt: new Date() };
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.altPhone !== undefined) data.altPhone = dto.altPhone;
    if (dto.languagePref !== undefined) data.languagePref = dto.languagePref;
    if (dto.assignedAgentId !== undefined) data.assignedAgentId = dto.assignedAgentId;
    const updated = await this.repository.update(businessId, leadId, data);
    return this.mapResponse(updated);
  }

  async deleteLead(businessId: string, leadId: string): Promise<void> {
    await this.mustFind(businessId, leadId);
    await this.repository.softDelete(businessId, leadId);
    this.logger.log(`Soft-deleted lead ${leadId} for business ${businessId}`);
  }

  async listLeads(businessId: string, query: ListLeadsQueryDto) {
    const result = await this.repository.list(businessId, {
      stage: query.stage,
      temperature: query.temperature,
      source: query.source,
      assignedAgentId: query.assignedAgentId,
      search: query.search,
      page: query.page,
      limit: query.limit,
    });
    return {
      data: result.data.map((l) => this.mapResponse(l)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  /** Pipeline board: counts per stage in canonical order. */
  async getBoard(businessId: string): Promise<Array<{ stage: string; count: number }>> {
    const counts = await this.repository.countByStage(businessId);
    return Object.values(LeadStage).map((stage) => ({ stage, count: counts[stage] ?? 0 }));
  }

  // ─────────────────────────────────────────────
  // BLTC QUALIFICATION
  // ─────────────────────────────────────────────

  /**
   * Merge a partial BLTC update into the lead's requirement profile.
   * A slot that already holds a value is NOT overwritten unless `force` is set —
   * the mismatch is surfaced as a contradiction (blueprint §16.2: contradictions
   * are surfaced, not silently overwritten). Re-scores and may auto-qualify.
   */
  async applyBltcUpdate(
    businessId: string,
    leadId: string,
    dto: BltcUpdateDto,
  ): Promise<BltcUpdateResult> {
    const lead = await this.mustFind(businessId, leadId);
    const current = this.readBltc(lead);
    const next: BltcProfile = { ...current };
    const contradictions: BltcUpdateResult['contradictions'] = [];

    const setSlot = <K extends keyof BltcProfile>(
      slot: K,
      incoming: BltcProfile[K],
      isFilled: (v: BltcProfile[K]) => boolean,
      differs: (a: BltcProfile[K], b: BltcProfile[K]) => boolean,
    ): void => {
      if (incoming === undefined) return;
      const existing = current[slot];
      if (isFilled(existing) && differs(existing, incoming) && !dto.force) {
        contradictions.push({ slot: String(slot), existing, incoming });
        return; // surface, do not overwrite
      }
      next[slot] = incoming;
    };

    if (dto.budgetMinPaise !== undefined) {
      setSlot('budgetMinPaise', dto.budgetMinPaise, (v) => v != null, (a, b) => a !== b);
    }
    if (dto.budgetMaxPaise !== undefined) {
      setSlot('budgetMaxPaise', dto.budgetMaxPaise, (v) => v != null, (a, b) => a !== b);
    }
    if (dto.localities !== undefined) {
      setSlot(
        'localities',
        dto.localities,
        (v) => Array.isArray(v) && v.length > 0,
        (a, b) => JSON.stringify(a) !== JSON.stringify(b),
      );
    }
    if (dto.timelineMonths !== undefined) {
      setSlot('timelineMonths', dto.timelineMonths, (v) => v != null, (a, b) => a !== b);
    }
    if (dto.config !== undefined) {
      setSlot('config', dto.config, (v) => v != null, (a, b) => a !== b);
    }
    if (dto.purpose !== undefined) {
      setSlot('purpose', dto.purpose, (v) => v != null, (a, b) => a !== b);
    }
    if (dto.financing !== undefined) {
      setSlot('financing', dto.financing, (v) => v != null, (a, b) => a !== b);
    }

    const engagementTurns =
      dto.engagementTurns ??
      ((lead.metadata as Record<string, unknown>)?.['engagementTurns'] as number | undefined) ??
      0;

    const score = scoreLead(next, engagementTurns);
    const complete = isBltcComplete(next);
    const reachable = Boolean(lead.whatsapp_phone) && !lead.opt_out;
    const shouldQualify =
      complete && reachable && this.stageRank(lead.stage) < this.stageRank(LeadStage.QUALIFIED);

    const metadata = {
      ...(lead.metadata as Record<string, unknown>),
      engagementTurns,
      ...(contradictions.length ? { lastContradictions: contradictions } : {}),
    };

    const updated = await this.repository.update(businessId, leadId, {
      budgetMin: next.budgetMinPaise != null ? paiseToDecimal(next.budgetMinPaise) : null,
      budgetMax: next.budgetMaxPaise != null ? paiseToDecimal(next.budgetMaxPaise) : null,
      localities: next.localities,
      timelineMonths: next.timelineMonths,
      config: next.config,
      purpose: next.purpose as realty_leads['purpose'],
      financing: next.financing as realty_leads['financing'],
      qualScore: score.score,
      temperature: score.temperature as realty_leads['temperature'],
      stage: shouldQualify ? (LeadStage.QUALIFIED as realty_leads['stage']) : undefined,
      lastActivityAt: new Date(),
      metadata: metadata as Prisma.InputJsonValue,
    });

    if (shouldQualify) {
      this.emit<RealtyLeadQualifiedEvent>('realty.lead.qualified', {
        ...this.baseEvent(businessId),
        type: 'realty.lead.qualified',
        leadId,
        qualScore: score.score,
        temperature: score.temperature,
      });
      this.emit<RealtyLeadStageChangedEvent>('realty.lead.stage_changed', {
        ...this.baseEvent(businessId),
        type: 'realty.lead.stage_changed',
        leadId,
        fromStage: lead.stage,
        toStage: LeadStage.QUALIFIED,
      });
    }

    // Hot-lead dossier alert once the lead crosses the hot threshold.
    if (score.score >= HOT_SCORE_THRESHOLD && lead.qual_score < HOT_SCORE_THRESHOLD) {
      this.emit<RealtyLeadHotEvent>('realty.lead.hot', {
        ...this.baseEvent(businessId),
        type: 'realty.lead.hot',
        leadId,
        qualScore: score.score,
        assignedAgentId: updated.assigned_agent_id ?? undefined,
        matchedUnitIds: updated.matched_unit_ids ?? [],
      });
    }

    return {
      lead: this.mapResponse(updated),
      contradictions,
      score,
      qualified: shouldQualify,
    };
  }

  // ─────────────────────────────────────────────
  // STAGE / MEMORY / ASSIGNMENT / OPT-OUT
  // ─────────────────────────────────────────────

  async transitionStage(
    businessId: string,
    leadId: string,
    dto: TransitionStageDto,
  ): Promise<LeadResponseDto> {
    const lead = await this.mustFind(businessId, leadId);
    if (lead.stage === dto.stage) return this.mapResponse(lead);

    const updated = await this.repository.update(businessId, leadId, {
      stage: dto.stage as realty_leads['stage'],
      lastActivityAt: new Date(),
    });

    this.emit<RealtyLeadStageChangedEvent>('realty.lead.stage_changed', {
      ...this.baseEvent(businessId),
      type: 'realty.lead.stage_changed',
      leadId,
      fromStage: lead.stage,
      toStage: dto.stage,
    });
    this.logger.log(`Lead ${leadId}: ${lead.stage} → ${dto.stage}`);
    return this.mapResponse(updated);
  }

  /** Append to the lead's permanent memory — facts, objections, promises. */
  async captureMemory(
    businessId: string,
    leadId: string,
    dto: CaptureMemoryDto,
  ): Promise<LeadResponseDto> {
    const lead = await this.mustFind(businessId, leadId);
    const at = new Date().toISOString();
    const toEntries = (arr?: string[]): LeadMemoryEntry[] =>
      (arr ?? []).map((text) => ({ text, at, messageId: dto.messageId }));

    const facts = [...this.readMemory(lead.extracted_facts), ...toEntries(dto.facts)];
    const objections = [...this.readMemory(lead.objections), ...toEntries(dto.objections)];
    const promises = [...this.readMemory(lead.promises), ...toEntries(dto.promises)];

    const updated = await this.repository.update(businessId, leadId, {
      extractedFacts: facts as unknown as Prisma.InputJsonValue,
      objections: objections as unknown as Prisma.InputJsonValue,
      promises: promises as unknown as Prisma.InputJsonValue,
      lastActivityAt: new Date(),
    });
    return this.mapResponse(updated);
  }

  async assignAgent(
    businessId: string,
    leadId: string,
    agentId: string,
  ): Promise<LeadResponseDto> {
    await this.mustFind(businessId, leadId);
    const updated = await this.repository.update(businessId, leadId, {
      assignedAgentId: agentId,
      lastActivityAt: new Date(),
    });
    return this.mapResponse(updated);
  }

  /** Honor an opt-out: halt automation and emit so cadence engines stop sending. */
  async setOptOut(businessId: string, leadId: string): Promise<LeadResponseDto> {
    const lead = await this.mustFind(businessId, leadId);
    const consentLog = [
      ...this.readMemory(lead.consent_log),
      { text: 'opted_out', at: new Date().toISOString() },
    ];
    const updated = await this.repository.update(businessId, leadId, {
      optOut: true,
      nextFollowupAt: null,
      consentLog: consentLog as unknown as Prisma.InputJsonValue,
      lastActivityAt: new Date(),
    });
    this.emit<RealtyLeadOptedOutEvent>('realty.lead.opted_out', {
      ...this.baseEvent(businessId),
      type: 'realty.lead.opted_out',
      leadId,
      whatsappPhone: lead.whatsapp_phone,
    });
    this.logger.warn(`Lead ${leadId} opted out — automation halted`);
    return this.mapResponse(updated);
  }

  /** Record the AI's matched units on the lead (called by the matching flow). */
  async setMatchedUnits(
    businessId: string,
    leadId: string,
    unitIds: string[],
  ): Promise<LeadResponseDto> {
    await this.mustFind(businessId, leadId);
    const updated = await this.repository.update(businessId, leadId, {
      matchedUnitIds: unitIds,
      lastActivityAt: new Date(),
    });
    return this.mapResponse(updated);
  }

  // ─────────────────────────────────────────────
  // EVENT LISTENERS — ingest from the messaging spine
  // ─────────────────────────────────────────────

  /**
   * Auto-capture a lead when an inbound WhatsApp message arrives for a phone
   * we haven't seen. Idempotent: existing leads are only touched (last activity).
   */
  @OnEvent('message.received')
  async handleMessageReceived(event: MessageReceivedEvent): Promise<void> {
    const phone = event.senderExternalId;
    if (!phone) return;
    try {
      const existing = await this.repository.findByPhone(event.businessId, phone);
      if (existing) {
        await this.repository.update(event.businessId, existing.id, {
          conversationId: existing.conversation_id ?? event.conversationId,
          lastActivityAt: new Date(),
        });
        return;
      }
      await this.createLead(event.businessId, {
        whatsappPhone: phone,
        source: LeadSource.CTWA,
        conversationId: event.conversationId,
        clientId: event.clientId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to ingest lead from message ${event.messageId}: ${message}`);
    }
  }

  // ─────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────

  private async mustFind(businessId: string, leadId: string): Promise<realty_leads> {
    const lead = await this.repository.findById(businessId, leadId);
    if (!lead) throw new NotFoundException(`Lead ${leadId} not found`);
    return lead;
  }

  private readBltc(lead: realty_leads): BltcProfile {
    return {
      budgetMinPaise: decimalToPaise(lead.budget_min),
      budgetMaxPaise: decimalToPaise(lead.budget_max),
      localities: lead.localities ?? [],
      timelineMonths: lead.timeline_months,
      config: lead.config,
      purpose: (lead.purpose as BltcProfile['purpose']) ?? null,
      financing: (lead.financing as BltcProfile['financing']) ?? null,
    };
  }

  private readMemory(value: unknown): LeadMemoryEntry[] {
    return Array.isArray(value) ? (value as LeadMemoryEntry[]) : [];
  }

  private stageRank(stage: string): number {
    return Object.values(LeadStage).indexOf(stage as LeadStage);
  }

  private baseEvent(businessId: string): {
    id: string;
    timestamp: string;
    businessId: string;
    correlationId: string;
  } {
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

  private mapResponse(lead: realty_leads): LeadResponseDto {
    return {
      id: lead.id,
      businessId: lead.business_id,
      assignedAgentId: lead.assigned_agent_id,
      conversationId: lead.conversation_id,
      clientId: lead.client_id,
      whatsappPhone: lead.whatsapp_phone,
      altPhone: lead.alt_phone,
      email: lead.email,
      name: lead.name,
      languagePref: lead.language_pref,
      source: lead.source,
      subSource: lead.sub_source,
      listingRef: lead.listing_ref,
      firstTouchAt: lead.first_touch_at,
      bltc: this.readBltc(lead),
      qualScore: lead.qual_score,
      temperature: lead.temperature,
      stage: lead.stage,
      matchedUnitIds: lead.matched_unit_ids ?? [],
      extractedFacts: this.readMemory(lead.extracted_facts),
      objections: this.readMemory(lead.objections),
      promises: this.readMemory(lead.promises),
      optOut: lead.opt_out,
      shareConsent: lead.share_consent,
      exchangeStatus: lead.exchange_status,
      nextFollowupAt: lead.next_followup_at,
      lastActivityAt: lead.last_activity_at,
      createdAt: lead.created_at,
      updatedAt: lead.updated_at,
    };
  }
}
