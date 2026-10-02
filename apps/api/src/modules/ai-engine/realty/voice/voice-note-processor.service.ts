import { Injectable, Logger } from '@nestjs/common';
import { generateCorrelationId } from '@gosumo/shared';
import { PrismaService } from '../../../../common/services/prisma.service';
import { escapeLikeTerm } from '../../../../common/utils/search-pattern.util';
import { RealtyLeadsService } from '../../../realty-leads/realty-leads.service';
import type { LeadResponseDto } from '../../../realty-leads/realty-leads.service';
import { RealtyInventoryService } from '../../../realty-inventory/realty-inventory.service';
import { CadenceEngineService } from '../../../realty-cadence/cadence-engine.service';
import { RealtyVisitsService } from '../../../realty-sitevisits/realty-sitevisits.service';
import { RealtyAiService, RealtyDecision } from '../realty-ai.service';
import { TranscriptionService } from './transcription.service';
import {
  VoiceCommandHistoryService,
  type VoiceCommandStatus,
} from './voice-command-history.service';
import { parseBrokerCommand, type BrokerCommand } from './broker-command.parser';
import { parseRelativeDateTime } from './relative-datetime.util';

/** The outcome of routing one broker voice command. */
export interface BrokerCommandOutcome {
  command: BrokerCommand | null;
  status: VoiceCommandStatus;
  detail: string;
}

export interface BrokerCommandContext {
  userId?: string | null;
  correlationId?: string;
  /** Clock for relative date parsing (injected for tests). */
  now?: Date;
}

export interface BuyerVoiceContext {
  conversationId?: string;
  serviceWindowOpen?: boolean;
  correlationId?: string;
}

/**
 * VoiceNoteProcessorService — the voice layer of GoSumo Realty (blueprint §5.3).
 *
 * Two flows sit on top of speech-to-text:
 *  - **Buyer voice notes** (inbound WhatsApp): transcribe, then feed the text
 *    into the grounded realty AI turn exactly as if the buyer had typed it, so
 *    BLTC extraction and the confidence router run unchanged.
 *  - **Broker voice commands** (dictated from the field): transcribe, lift a
 *    structured command out of the transcript, and route it to the cadence,
 *    inventory, lead-assignment, or site-visit service — recording every command
 *    (and its outcome) to the append-only history.
 *
 * A command that can't be understood, or whose lead/project/agent can't be
 * resolved, fails closed (nothing is guessed or applied) and is surfaced back to
 * the broker for confirmation.
 */
@Injectable()
export class VoiceNoteProcessorService {
  private readonly logger = new Logger(VoiceNoteProcessorService.name);

  constructor(
    private readonly transcription: TranscriptionService,
    private readonly realtyAi: RealtyAiService,
    private readonly leads: RealtyLeadsService,
    private readonly inventory: RealtyInventoryService,
    private readonly cadence: CadenceEngineService,
    private readonly visits: RealtyVisitsService,
    private readonly history: VoiceCommandHistoryService,
    private readonly prisma: PrismaService,
  ) {}

  // ─────────────────────────────────────────────
  // Transcription
  // ─────────────────────────────────────────────

  /** Transcribe a voice note (delegates to the STT client). */
  async transcribeVoiceNote(mediaUrl: string, mimeType: string): Promise<string> {
    return this.transcription.transcribe(mediaUrl, mimeType);
  }

  // ─────────────────────────────────────────────
  // Buyer voice note → AI turn
  // ─────────────────────────────────────────────

  /**
   * Feed a buyer's transcribed voice note into the realty AI loop as if it were
   * a text message — BLTC extraction, grounding, and confidence routing run
   * exactly as for a typed message.
   */
  async processBuyerVoiceNote(
    businessId: string,
    leadId: string,
    transcription: string,
    ctx: BuyerVoiceContext = {},
  ): Promise<RealtyDecision> {
    return this.realtyAi.processTurn(businessId, {
      leadId,
      messageText: transcription,
      conversationId: ctx.conversationId,
      serviceWindowOpen: ctx.serviceWindowOpen,
      correlationId: ctx.correlationId,
    });
  }

  // ─────────────────────────────────────────────
  // Broker voice command → routed action
  // ─────────────────────────────────────────────

  async processBrokerVoiceCommand(
    businessId: string,
    transcription: string,
    ctx: BrokerCommandContext = {},
  ): Promise<BrokerCommandOutcome> {
    const correlationId = ctx.correlationId ?? generateCorrelationId();
    const command = parseBrokerCommand(transcription);

    let outcome: BrokerCommandOutcome;
    if (!command) {
      outcome = {
        command: null,
        status: 'not_understood',
        detail: 'Could not recognise a command in the voice note.',
      };
    } else {
      try {
        outcome = await this.route(businessId, command, ctx);
      } catch (err) {
        outcome = {
          command,
          status: 'failed',
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    await this.history.record({
      businessId,
      userId: ctx.userId,
      transcription,
      command,
      status: outcome.status,
      detail: outcome.detail,
      correlationId,
    });

    this.logger.log(
      `Broker voice command [${outcome.command?.kind ?? 'UNKNOWN'}] → ${outcome.status}: ${outcome.detail}`,
    );
    return outcome;
  }

  // ─────────────────────────────────────────────
  // Command routing
  // ─────────────────────────────────────────────

  private async route(
    businessId: string,
    command: BrokerCommand,
    ctx: BrokerCommandContext,
  ): Promise<BrokerCommandOutcome> {
    switch (command.kind) {
      case 'PAUSE_FOLLOWUPS':
        return this.routePause(businessId, command);
      case 'RESUME_FOLLOWUPS':
        return this.routeResume(businessId, command);
      case 'ASSIGN_LEAD':
        return this.routeAssign(businessId, command);
      case 'BOOK_VISIT':
        return this.routeBookVisit(businessId, command, ctx.now ?? new Date());
      case 'UPDATE_PRICE':
        return this.routePriceUpdate(businessId, command);
      default: {
        const _exhaustive: never = command;
        return { command: _exhaustive, status: 'not_understood', detail: 'Unhandled command.' };
      }
    }
  }

  private async routePause(
    businessId: string,
    command: Extract<BrokerCommand, { kind: 'PAUSE_FOLLOWUPS' }>,
  ): Promise<BrokerCommandOutcome> {
    const lead = await this.resolveLead(businessId, command.leadName);
    if (!lead) return this.unresolvedLead(command, command.leadName);
    const stopped = await this.cadence.pauseForLead(businessId, lead.id);
    return {
      command,
      status: 'executed',
      detail: `Paused ${stopped} follow-up cadence(s) for ${leadLabel(lead)}.`,
    };
  }

  private async routeResume(
    businessId: string,
    command: Extract<BrokerCommand, { kind: 'RESUME_FOLLOWUPS' }>,
  ): Promise<BrokerCommandOutcome> {
    const lead = await this.resolveLead(businessId, command.leadName);
    if (!lead) return this.unresolvedLead(command, command.leadName);
    const enrollment = await this.cadence.resumeForLead(businessId, lead.id);
    return {
      command,
      status: 'executed',
      detail: enrollment
        ? `Resumed follow-ups for ${leadLabel(lead)}.`
        : `No paused cadence to resume for ${leadLabel(lead)} (already active or none configured).`,
    };
  }

  private async routeAssign(
    businessId: string,
    command: Extract<BrokerCommand, { kind: 'ASSIGN_LEAD' }>,
  ): Promise<BrokerCommandOutcome> {
    const lead = await this.resolveLead(businessId, command.leadName);
    if (!lead) return this.unresolvedLead(command, command.leadName);

    const agent = await this.prisma.team_members.findFirst({
      where: {
        business_id: businessId,
        deleted_at: null,
        OR: [
          { name: { equals: command.agentName, mode: 'insensitive' } },
          // The name is transcribed speech, so it is untrusted text like any
          // other search term — escaped so `%`/`_` cannot act as wildcards and
          // resolve the command to an arbitrary agent.
          { name: { contains: escapeLikeTerm(command.agentName), mode: 'insensitive' } },
          { email: { equals: command.agentName, mode: 'insensitive' } },
        ],
      },
    });
    if (!agent) {
      return {
        command,
        status: 'unresolved',
        detail: `Couldn't find a team member matching "${command.agentName}". Assign in the console.`,
      };
    }

    await this.leads.assignAgent(businessId, lead.id, agent.id);
    return {
      command,
      status: 'executed',
      detail: `Assigned ${leadLabel(lead)} to ${agent.name}.`,
    };
  }

  private async routeBookVisit(
    businessId: string,
    command: Extract<BrokerCommand, { kind: 'BOOK_VISIT' }>,
    now: Date,
  ): Promise<BrokerCommandOutcome> {
    const lead = await this.resolveLead(businessId, command.leadName);
    if (!lead) return this.unresolvedLead(command, command.leadName);

    const scheduledAt = parseRelativeDateTime(command.when, now);
    if (!scheduledAt) {
      return {
        command,
        status: 'unresolved',
        detail: `Understood "book visit for ${command.leadName}" but couldn't parse the time "${command.when}". Please confirm.`,
      };
    }
    if (scheduledAt.getTime() <= now.getTime()) {
      return {
        command,
        status: 'unresolved',
        detail: `The visit time "${command.when}" is in the past — please dictate a future time.`,
      };
    }

    // A site visit needs a project; derive it from the lead's top matched unit.
    const unitId = lead.matchedUnitIds?.[0];
    if (!unitId) {
      return {
        command,
        status: 'unresolved',
        detail: `No matched property for ${leadLabel(lead)} yet — match a unit first, then book.`,
      };
    }
    const unit = await this.inventory.getUnit(businessId, unitId);

    const visit = await this.visits.bookVisit(businessId, {
      leadId: lead.id,
      projectId: unit.projectId,
      unitId: unit.id,
      scheduledAt: scheduledAt.toISOString(),
      notes: 'Booked via broker voice command',
    });
    return {
      command,
      status: 'executed',
      detail: `Booked a visit for ${leadLabel(lead)} at ${scheduledAt.toISOString()} (visit ${visit.id.slice(0, 8)}).`,
    };
  }

  private async routePriceUpdate(
    businessId: string,
    command: Extract<BrokerCommand, { kind: 'UPDATE_PRICE' }>,
  ): Promise<BrokerCommandOutcome> {
    const projects = await this.inventory.listProjects(businessId, {});
    const needle = command.project.toLowerCase();
    const project =
      projects.find((p) => p.name.toLowerCase() === needle) ??
      projects.find((p) => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase()));
    if (!project) {
      return {
        command,
        status: 'unresolved',
        detail: `Couldn't find a project matching "${command.project}".`,
      };
    }

    const units = await this.inventory.listUnits(businessId, project.id);
    const unit = units.find((u) => u.config.replace(/\s+/g, '').toUpperCase() === command.config);
    if (!unit) {
      return {
        command,
        status: 'unresolved',
        detail: `No ${command.config} unit found in ${project.name}.`,
      };
    }

    await this.inventory.updateUnit(businessId, unit.id, { allInPricePaise: command.pricePaise });
    return {
      command,
      status: 'executed',
      detail: `Updated ${project.name} ${command.config} price to ${paiseLabel(command.pricePaise)}.`,
    };
  }

  // ─────────────────────────────────────────────
  // Resolution helpers
  // ─────────────────────────────────────────────

  /** Resolve a lead by a dictated name (exact match preferred, else first hit). */
  private async resolveLead(businessId: string, name: string): Promise<LeadResponseDto | null> {
    const page = await this.leads.listLeads(businessId, { search: name, limit: 10 });
    const rows = page.data as LeadResponseDto[];
    if (rows.length === 0) return null;
    const lower = name.toLowerCase();
    return rows.find((l) => (l.name ?? '').toLowerCase() === lower) ?? rows[0]!;
  }

  private unresolvedLead(command: BrokerCommand, name: string): BrokerCommandOutcome {
    return {
      command,
      status: 'unresolved',
      detail: `Couldn't find a lead matching "${name}".`,
    };
  }
}

function leadLabel(lead: LeadResponseDto): string {
  return lead.name ?? lead.whatsappPhone;
}

function paiseLabel(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 1e7) return `₹${Math.round((rupees / 1e7) * 100) / 100} Cr`;
  if (rupees >= 1e5) return `₹${Math.round((rupees / 1e5) * 100) / 100} L`;
  return `₹${Math.round(rupees)}`;
}
