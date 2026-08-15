import { Injectable } from '@nestjs/common';
import { Prisma, ConsentType } from '@prisma/client';
import type {
  consent_logs,
  realty_compliance_settings,
  realty_leads,
  messages,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';
import { anonymizeEmail, anonymizePhone, ANONYMIZED_NAME } from './dpdpa.util';
import { REDACTED_FILENAME } from './compliance.constants';

export interface CreateConsentData {
  businessId: string;
  phone: string;
  consentType: ConsentType;
  channel: string;
  messageId?: string | null;
  source?: string | null;
  granted: boolean;
}

export interface ComplianceSettingsPatch {
  retentionMonths?: number;
  dataProcessorAgreement?: boolean;
}

/**
 * ComplianceRepository — Prisma access for the DPDPA surface. Compliance is a
 * cross-cutting concern (like the hardening module): it reads/writes
 * `consent_logs`, `realty_compliance_settings`, and — for access/erasure/retention
 * — `realty_leads` and `messages`. Every query is scoped by `business_id`.
 */
@Injectable()
export class ComplianceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Consent ledger ──────────────────────────────────────────────────────────

  async createConsent(data: CreateConsentData): Promise<consent_logs> {
    return this.prisma.consent_logs.create({
      data: {
        business_id: data.businessId,
        phone: data.phone,
        consent_type: data.consentType,
        channel: data.channel,
        message_id: data.messageId ?? null,
        source: data.source ?? null,
        granted_at: new Date(),
        revoked_at: data.granted ? null : new Date(),
      },
    });
  }

  /** Latest active (non-revoked) consent of a type for a phone, if any. */
  async findActiveConsent(
    businessId: string,
    phone: string,
    consentType: ConsentType,
  ): Promise<consent_logs | null> {
    return this.prisma.consent_logs.findFirst({
      where: {
        business_id: businessId,
        phone,
        consent_type: consentType,
        revoked_at: null,
      },
      orderBy: { granted_at: 'desc' },
    });
  }

  /** A consent-ledger row for a phone with a given provenance `source`, if any. */
  async findConsentBySource(
    businessId: string,
    phone: string,
    source: string,
  ): Promise<consent_logs | null> {
    return this.prisma.consent_logs.findFirst({
      where: { business_id: businessId, phone, source },
      orderBy: { granted_at: 'desc' },
    });
  }

  /** Full consent history for a phone (newest first). */
  async listConsents(businessId: string, phone: string): Promise<consent_logs[]> {
    return this.prisma.consent_logs.findMany({
      where: { business_id: businessId, phone },
      orderBy: { granted_at: 'desc' },
    });
  }

  /** Stamp every active consent for a phone as revoked. Returns the count revoked. */
  async revokeAllConsents(
    businessId: string,
    phone: string,
    consentType?: ConsentType,
  ): Promise<number> {
    const res = await this.prisma.consent_logs.updateMany({
      where: {
        business_id: businessId,
        phone,
        revoked_at: null,
        ...(consentType ? { consent_type: consentType } : {}),
      },
      data: { revoked_at: new Date() },
    });
    return res.count;
  }

  // ── Compliance settings ───────────────────────────────────────────────────────

  async findSettings(businessId: string): Promise<realty_compliance_settings | null> {
    return this.prisma.realty_compliance_settings.findUnique({
      where: { business_id: businessId },
    });
  }

  async upsertSettings(
    businessId: string,
    patch: ComplianceSettingsPatch,
  ): Promise<realty_compliance_settings> {
    const dpaTimestamp =
      patch.dataProcessorAgreement === true ? { data_processor_agreed_at: new Date() } : {};
    return this.prisma.realty_compliance_settings.upsert({
      where: { business_id: businessId },
      create: {
        business_id: businessId,
        ...(patch.retentionMonths !== undefined ? { retention_months: patch.retentionMonths } : {}),
        ...(patch.dataProcessorAgreement !== undefined
          ? { data_processor_agreement: patch.dataProcessorAgreement }
          : {}),
        ...dpaTimestamp,
      },
      update: {
        ...(patch.retentionMonths !== undefined ? { retention_months: patch.retentionMonths } : {}),
        ...(patch.dataProcessorAgreement !== undefined
          ? { data_processor_agreement: patch.dataProcessorAgreement }
          : {}),
        ...dpaTimestamp,
      },
    });
  }

  async markRetentionRun(businessId: string, at: Date): Promise<void> {
    await this.prisma.realty_compliance_settings.upsert({
      where: { business_id: businessId },
      create: { business_id: businessId, last_retention_run_at: at },
      update: { last_retention_run_at: at },
    });
  }

  // ── Lead access + erasure ─────────────────────────────────────────────────────

  async findLeadByPhone(businessId: string, phone: string): Promise<realty_leads | null> {
    return this.prisma.realty_leads.findFirst({
      where: { business_id: businessId, whatsapp_phone: phone },
    });
  }

  async findLeadById(businessId: string, leadId: string): Promise<realty_leads | null> {
    return this.prisma.realty_leads.findFirst({
      where: { business_id: businessId, id: leadId },
    });
  }

  /** Messages tied to a lead's conversation (newest first). */
  async listMessagesForConversation(
    businessId: string,
    conversationId: string,
    limit = 200,
  ): Promise<messages[]> {
    return this.prisma.messages.findMany({
      where: { business_id: businessId, conversation_id: conversationId },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  }

  /** Apply a correction to a lead's personal data. */
  async updateLead(
    businessId: string,
    leadId: string,
    data: Prisma.realty_leadsUpdateInput,
  ): Promise<realty_leads> {
    return this.prisma.realty_leads.updateMany({
      where: { business_id: businessId, id: leadId },
      data,
    }).then(() => this.findLeadById(businessId, leadId) as Promise<realty_leads>);
  }

  /**
   * Anonymize a lead in place (right to erasure): replace name, hash phone/email,
   * clear the memory fields, halt automation, and stamp erasure metadata. Keeps
   * the (now anonymized) row so transaction/reporting records survive.
   */
  async anonymizeLead(
    businessId: string,
    lead: realty_leads,
    reason: string,
    now: Date,
  ): Promise<realty_leads> {
    const metadata = {
      ...((lead.metadata as Record<string, unknown>) ?? {}),
      erased: true,
      erasedAt: now.toISOString(),
      erasureReason: reason,
    };
    await this.prisma.realty_leads.updateMany({
      where: { business_id: businessId, id: lead.id },
      data: {
        name: ANONYMIZED_NAME,
        whatsapp_phone: anonymizePhone(lead.whatsapp_phone),
        alt_phone: lead.alt_phone ? anonymizePhone(lead.alt_phone) : null,
        email: anonymizeEmail(lead.email),
        extracted_facts: [],
        objections: [],
        promises: [],
        opt_out: true,
        next_followup_at: null,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
    return this.findLeadById(businessId, lead.id) as Promise<realty_leads>;
  }

  /**
   * Anonymize the sender info on a lead's client messages (DPDPA erasure). The
   * message rows are retained for auditability; only PII (sender id + denormalized
   * search text) is scrubbed. Returns the number of rows anonymized.
   */
  async anonymizeConversationMessages(
    businessId: string,
    conversationId: string,
  ): Promise<number> {
    const res = await this.prisma.messages.updateMany({
      where: {
        business_id: businessId,
        conversation_id: conversationId,
        sender_type: 'CLIENT',
      },
      data: {
        sender_id: null,
        text_content: null,
      },
    });
    return res.count;
  }

  // ── Retention sweep ───────────────────────────────────────────────────────────

  /**
   * Leads that are inactive past the cutoff and not already erased/soft-deleted —
   * the candidates for auto-anonymization.
   */
  async findInactiveLeads(
    businessId: string,
    cutoff: Date,
    limit = 500,
  ): Promise<realty_leads[]> {
    return this.prisma.realty_leads.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
        OR: [
          { last_activity_at: { lt: cutoff } },
          { last_activity_at: null, created_at: { lt: cutoff } },
        ],
        NOT: { metadata: { path: ['erased'], equals: true } },
      },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
  }

  /**
   * Anonymize sender info on all client messages older than the cutoff for a
   * business. Returns the number of rows anonymized.
   */
  async anonymizeOldMessages(businessId: string, cutoff: Date): Promise<number> {
    const res = await this.prisma.messages.updateMany({
      where: {
        business_id: businessId,
        sender_type: 'CLIENT',
        created_at: { lt: cutoff },
        sender_id: { not: null },
      },
      data: { sender_id: null, text_content: null },
    });
    return res.count;
  }

  /**
   * Scrub the personal data on media attachments past the retention window.
   *
   * `anonymizeOldMessages` clears a message's `text_content`, but an image or
   * document message carries its content *beside* the row it anonymizes: a
   * `file_uploads` row whose `filename` is whatever the sender's device called
   * it — "Aadhaar-Ramesh.pdf", "salary-slip-march.jpg" — and whose `cdn_url` is
   * a live link to the file itself. Anonymizing the message and leaving that
   * behind erases the caption and keeps the document.
   *
   * `storage_key` is deliberately kept. It is the only handle to the stored
   * object, so nulling it would strand the object permanently instead of
   * erasing it — the same reason the knowledge-deletion path drops vectors
   * before the metadata row that points at them. When an object-purge exists,
   * this is the column it reads.
   *
   * The `OR` is what makes the sweep idempotent: an already-scrubbed row
   * matches nothing, so a weekly run rewrites (and counts) only rows that still
   * hold something.
   */
  async anonymizeOldFileUploads(businessId: string, cutoff: Date): Promise<number> {
    const res = await this.prisma.file_uploads.updateMany({
      where: {
        business_id: businessId,
        created_at: { lt: cutoff },
        OR: [
          { filename: { not: REDACTED_FILENAME } },
          { cdn_url: { not: null } },
          { thumbnail_key: { not: null } },
        ],
      },
      data: { filename: REDACTED_FILENAME, cdn_url: null, thumbnail_key: null },
    });
    return res.count;
  }

  /** The business's display name (for the first-contact notice). */
  async getBusinessName(businessId: string): Promise<string | null> {
    const biz = await this.prisma.businesses.findUnique({
      where: { id: businessId },
      select: { name: true },
    });
    return biz?.name ?? null;
  }

  /**
   * Every business that has a compliance-relevant footprint (drives the sweep).
   *
   * Raw, because Prisma's `distinct` is not a SQL DISTINCT. For this query it
   * emits `SELECT id, business_id FROM realty_leads` — every lead row on the
   * platform, across every tenant — and de-duplicates in Node, adding `id` to
   * the projection to do it. The result is a handful of uuids; the read to
   * produce them grew with the total number of leads ever captured.
   *
   * `SELECT DISTINCT` lets Postgres answer from a business_id-leading index
   * instead of the heap. No `deleted_at` filter, matching the previous
   * behaviour deliberately: a soft-deleted lead still holds the personal data
   * the retention sweep exists to erase, so its tenant must stay in the list.
   */
  async listBusinessIdsWithLeads(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ business_id: string }>>`
      SELECT DISTINCT business_id FROM realty_leads
    `;
    return rows.map((r) => r.business_id);
  }
}
