import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ConsentType, Prisma } from '@prisma/client';
import type { realty_leads, consent_logs, messages } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  normalizeIndianPhone,
} from '@gosumo/shared';
import type {
  RealtyLeadCreatedEvent,
  RealtyLeadOptedOutEvent,
  RealtyLeadErasedEvent,
} from '@gosumo/shared';
import { ComplianceRepository } from './compliance.repository';
import { ConsentService } from './consent.service';
import {
  buildFirstContactNotice,
  DEFAULT_RETENTION_MONTHS,
} from './dpdpa.util';
import { RealtyOperationsAuditService } from '../realty-hardening/realty-operations-audit.service';
import type { AuditActor } from '../../common/services/audit-log.service';

// ─────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────

export interface DataAccessResult {
  found: boolean;
  phone: string;
  lead: {
    id: string;
    name: string | null;
    email: string | null;
    whatsappPhone: string;
    stage: string;
    source: string;
    extractedFacts: unknown;
    objections: unknown;
    promises: unknown;
    optOut: boolean;
    createdAt: Date;
  } | null;
  messages: Array<{
    id: string;
    direction: string;
    senderType: string;
    textContent: string | null;
    createdAt: Date;
  }>;
  consents: consent_logs[];
}

export interface ErasureResult {
  erased: boolean;
  leadId: string | null;
  messagesAnonymized: number;
  consentsRevoked: number;
}

export interface ComplianceSettingsDto {
  retentionMonths: number;
  dataProcessorAgreement: boolean;
  dataProcessorAgreedAt: Date | null;
  lastRetentionRunAt: Date | null;
}

export interface CorrectionInput {
  phone: string;
  name?: string;
  email?: string;
  altPhone?: string;
}

/**
 * ComplianceService — the DPDPA workflow surface (business plan §21).
 *
 * Provides the data-principal rights (access, correction, erasure), per-business
 * retention/processor settings, the first-contact processing notice, and the
 * consent cascade on opt-out. Every erasure/correction is written to the
 * append-only `audit_logs` trail (root rule #7).
 */
@Injectable()
export class ComplianceService {
  private readonly logger = new Logger(ComplianceService.name);

  constructor(
    private readonly repository: ComplianceRepository,
    private readonly consent: ConsentService,
    private readonly audit: RealtyOperationsAuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // Right of access (DPDPA §11)
  // ─────────────────────────────────────────────

  /** Return everything held for a phone: lead profile, messages, consent history. */
  async dataRequest(businessId: string, rawPhone: string): Promise<DataAccessResult> {
    const phone = normalizeIndianPhone(rawPhone) ?? rawPhone;
    // Both are keyed on the same phone and neither reads the other's result, so
    // awaiting them one after the other spent two round trips' latency to
    // collect what one costs. They are also two Postgres connections held for
    // the duration either way — running them together shortens how long, which
    // is the resource that is actually scarce on this deployment.
    const [lead, consents] = await Promise.all([
      this.repository.findLeadByPhone(businessId, phone),
      this.repository.listConsents(businessId, phone),
    ]);

    // The message history is genuinely dependent — it needs the lead's
    // conversation id — so it stays where it is.
    let msgs: messages[] = [];
    if (lead?.conversation_id) {
      msgs = await this.repository.listMessagesForConversation(businessId, lead.conversation_id);
    }

    await this.audit.record({
      businessId,
      actorType: 'API',
      action: 'EXPORT',
      resourceType: 'realty_lead',
      resourceId: lead?.id ?? null,
      description: `DPDPA data-access request for ${phone}`,
    });

    return {
      found: Boolean(lead),
      phone,
      lead: lead
        ? {
            id: lead.id,
            name: lead.name,
            email: lead.email,
            whatsappPhone: lead.whatsapp_phone,
            stage: lead.stage,
            source: lead.source,
            extractedFacts: lead.extracted_facts,
            objections: lead.objections,
            promises: lead.promises,
            optOut: lead.opt_out,
            createdAt: lead.created_at,
          }
        : null,
      messages: msgs.map((m) => ({
        id: m.id,
        direction: m.direction,
        senderType: m.sender_type,
        textContent: m.text_content,
        createdAt: m.created_at,
      })),
      consents,
    };
  }

  // ─────────────────────────────────────────────
  // Right to correction (DPDPA §12)
  // ─────────────────────────────────────────────

  async correction(businessId: string, input: CorrectionInput): Promise<realty_leads> {
    const phone = normalizeIndianPhone(input.phone) ?? input.phone;
    const lead = await this.repository.findLeadByPhone(businessId, phone);
    if (!lead) throw new NotFoundException(`No lead found for phone ${phone}`);

    const data: Prisma.realty_leadsUpdateInput = { last_activity_at: new Date() };
    if (input.name !== undefined) data.name = input.name;
    if (input.email !== undefined) data.email = input.email;
    if (input.altPhone !== undefined) data.alt_phone = input.altPhone;

    const updated = await this.repository.updateLead(businessId, lead.id, data);

    await this.audit.record({
      businessId,
      actorType: 'API',
      action: 'UPDATE',
      resourceType: 'realty_lead',
      resourceId: lead.id,
      before: { name: lead.name, email: lead.email, altPhone: lead.alt_phone },
      after: { name: updated.name, email: updated.email, altPhone: updated.alt_phone },
      description: `DPDPA correction for ${phone}`,
    });
    return updated;
  }

  // ─────────────────────────────────────────────
  // Right to erasure (DPDPA §13) — anonymize in place
  // ─────────────────────────────────────────────

  /**
   * Erase (anonymize) all PII held for a phone: name → "Anonymized", phone/email
   * hashed, memory fields cleared, opt-out set, and the lead's client messages'
   * sender info scrubbed. The anonymized transaction record is kept for business
   * reporting. Consents are revoked and the action is audited. Idempotent.
   */
  async erasure(
    businessId: string,
    rawPhone: string,
    reason = 'REQUEST',
    now: Date = new Date(),
    actor?: AuditActor,
  ): Promise<ErasureResult> {
    const phone = normalizeIndianPhone(rawPhone) ?? rawPhone;
    const lead = await this.repository.findLeadByPhone(businessId, phone);
    const consentsRevoked = await this.consent.revokeConsent(businessId, phone);

    if (!lead) {
      return { erased: false, leadId: null, messagesAnonymized: 0, consentsRevoked };
    }

    return this.eraseLead(businessId, lead, reason, now, consentsRevoked, actor);
  }

  /** Shared erasure path (used by request + retention). */
  async eraseLead(
    businessId: string,
    lead: realty_leads,
    reason: string,
    now: Date,
    consentsRevoked = 0,
    actor?: AuditActor,
  ): Promise<ErasureResult> {
    let messagesAnonymized = 0;
    if (lead.conversation_id) {
      messagesAnonymized = await this.repository.anonymizeConversationMessages(
        businessId,
        lead.conversation_id,
      );
    }

    await this.repository.anonymizeLead(businessId, lead, reason, now);

    // A retention sweep is SYSTEM. A request is a team member when the
    // controller hands one down, and API otherwise — it used to be API for
    // every request, which recorded a dashboard erasure with no actor.
    await this.audit.record({
      businessId,
      actorType: reason === 'RETENTION' ? 'SYSTEM' : actor ? 'TEAM_MEMBER' : 'API',
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      action: 'DELETE',
      resourceType: 'realty_lead',
      resourceId: lead.id,
      description: `DPDPA erasure (${reason}) — anonymized lead + ${messagesAnonymized} message(s)`,
    });

    const event: RealtyLeadErasedEvent = {
      ...this.baseEvent(businessId),
      type: 'realty.lead.erased',
      leadId: lead.id,
      reason,
      messagesAnonymized,
    };
    this.eventEmitter.emit('realty.lead.erased', event);
    this.logger.log(`Erased lead ${lead.id} (${reason}) for business ${businessId}`);

    return { erased: true, leadId: lead.id, messagesAnonymized, consentsRevoked };
  }

  // ─────────────────────────────────────────────
  // Settings (retention window + processor agreement)
  // ─────────────────────────────────────────────

  async getSettings(businessId: string): Promise<ComplianceSettingsDto> {
    const s = await this.repository.findSettings(businessId);
    return {
      retentionMonths: s?.retention_months ?? DEFAULT_RETENTION_MONTHS,
      dataProcessorAgreement: s?.data_processor_agreement ?? false,
      dataProcessorAgreedAt: s?.data_processor_agreed_at ?? null,
      lastRetentionRunAt: s?.last_retention_run_at ?? null,
    };
  }

  async updateSettings(
    businessId: string,
    patch: { retentionMonths?: number; dataProcessorAgreement?: boolean },
    actor?: AuditActor,
  ): Promise<ComplianceSettingsDto> {
    await this.repository.upsertSettings(businessId, patch);
    await this.audit.record({
      businessId,
      actorType: actor ? 'TEAM_MEMBER' : 'SYSTEM',
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      action: 'UPDATE',
      resourceType: 'realty_compliance_settings',
      description: `Updated compliance settings ${JSON.stringify(patch)}`,
    });
    return this.getSettings(businessId);
  }

  // ─────────────────────────────────────────────
  // First-contact notice (DPDPA §5)
  // ─────────────────────────────────────────────

  /** The notice text a business must include in its first message to a buyer. */
  async firstContactNotice(businessId: string): Promise<string> {
    const name = await this.repository.getBusinessName(businessId);
    return buildFirstContactNotice(name ?? 'this brokerage');
  }

  // ─────────────────────────────────────────────
  // Compliance report (for export)
  // ─────────────────────────────────────────────

  async complianceReport(businessId: string): Promise<Record<string, unknown>> {
    const settings = await this.getSettings(businessId);
    return {
      businessId,
      generatedAt: new Date().toISOString(),
      dataFiduciary: await this.repository.getBusinessName(businessId),
      dataProcessor: 'DoAide Desk',
      retentionMonths: settings.retentionMonths,
      dataProcessorAgreement: settings.dataProcessorAgreement,
      dataProcessorAgreedAt: settings.dataProcessorAgreedAt,
      lastRetentionRunAt: settings.lastRetentionRunAt,
    };
  }

  // ─────────────────────────────────────────────
  // Event listeners
  // ─────────────────────────────────────────────

  /**
   * Record the PROCESSING consent the moment a lead is captured (the legal basis
   * for the AI to engage), and flag that the first-contact notice is still owed.
   */
  @OnEvent('realty.lead.created')
  async onLeadCreated(event: RealtyLeadCreatedEvent): Promise<void> {
    try {
      await this.consent.recordConsent(event.businessId, {
        phone: event.whatsappPhone,
        consentType: ConsentType.PROCESSING,
        channel: 'WHATSAPP',
        source: 'lead_created',
      });
    } catch (err) {
      this.logger.error(
        `Failed to record processing consent for lead ${event.leadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Opt-out cascade: the lead module already halts cadences + blocks sends; here
   * we complete the DPDPA side by revoking the buyer's consents on the ledger.
   */
  @OnEvent('realty.lead.opted_out')
  async onLeadOptedOut(event: RealtyLeadOptedOutEvent): Promise<void> {
    try {
      await this.consent.revokeConsent(event.businessId, event.whatsappPhone, undefined, 'WHATSAPP');
    } catch (err) {
      this.logger.error(
        `Failed to revoke consent on opt-out for lead ${event.leadId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private baseEvent(businessId: string) {
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
    };
  }
}
