/**
 * ComplianceRepository unit tests — the Prisma access layer for the DPDPA surface.
 *
 * The dominant concern here is tenant isolation (root rule #1, "cross-tenant
 * leakage is a full-stop defect"): EVERY tenant-table query must carry
 * `business_id` in its WHERE clause. These tests mock PrismaService and assert
 * the exact filters, the anonymization payloads (name/phone/email scrubbed), and
 * the retention-candidate predicate.
 */

import { ConsentType } from '@prisma/client';
import type { realty_leads } from '@prisma/client';
import { ComplianceRepository } from './compliance.repository';
import { ANONYMIZED_NAME, anonymizeEmail, anonymizePhone } from './dpdpa.util';
import { REDACTED_FILENAME } from './compliance.constants';

const BIZ = '00000000-0000-4000-a000-00000000000a';
const PHONE = '+919876543210';
const NOW = new Date('2026-07-03T00:00:00Z');

function prismaMock() {
  return {
    consent_logs: {
      create: jest.fn().mockResolvedValue({ id: 'c-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    realty_compliance_settings: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    realty_leads: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    messages: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    file_uploads: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    businesses: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Acme Realty' }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function leadRow(over: Partial<realty_leads> = {}): realty_leads {
  return {
    id: 'lead-1',
    business_id: BIZ,
    name: 'Ravi Kumar',
    whatsapp_phone: PHONE,
    alt_phone: '+919000000000',
    email: 'ravi@example.com',
    metadata: { note: 'keep' },
    ...over,
  } as realty_leads;
}

describe('ComplianceRepository', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let repo: ComplianceRepository;

  beforeEach(() => {
    prisma = prismaMock();
    repo = new ComplianceRepository(prisma as never);
  });

  // ── Consent ledger ────────────────────────────────────────────────────────────

  describe('createConsent', () => {
    it('writes a granted row with revoked_at null', async () => {
      await repo.createConsent({
        businessId: BIZ,
        phone: PHONE,
        consentType: ConsentType.PROCESSING,
        channel: 'WHATSAPP',
        granted: true,
      });
      const data = prisma.consent_logs.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        business_id: BIZ,
        phone: PHONE,
        consent_type: ConsentType.PROCESSING,
        channel: 'WHATSAPP',
        revoked_at: null,
      });
    });

    it('stamps revoked_at immediately when granted=false', async () => {
      await repo.createConsent({
        businessId: BIZ,
        phone: PHONE,
        consentType: ConsentType.MARKETING,
        channel: 'SYSTEM',
        granted: false,
      });
      expect(prisma.consent_logs.create.mock.calls[0][0].data.revoked_at).toBeInstanceOf(Date);
    });

    it('defaults messageId and source to null', async () => {
      await repo.createConsent({
        businessId: BIZ,
        phone: PHONE,
        consentType: ConsentType.PROCESSING,
        channel: 'SYSTEM',
        granted: true,
      });
      const data = prisma.consent_logs.create.mock.calls[0][0].data;
      expect(data.message_id).toBeNull();
      expect(data.source).toBeNull();
    });
  });

  describe('findActiveConsent', () => {
    it('filters by business, phone, type, and non-revoked; newest first', async () => {
      await repo.findActiveConsent(BIZ, PHONE, ConsentType.PROCESSING);
      expect(prisma.consent_logs.findFirst).toHaveBeenCalledWith({
        where: { business_id: BIZ, phone: PHONE, consent_type: ConsentType.PROCESSING, revoked_at: null },
        orderBy: { granted_at: 'desc' },
      });
    });
  });

  describe('findConsentBySource', () => {
    it('scopes by business + phone + source', async () => {
      await repo.findConsentBySource(BIZ, PHONE, 'first_contact_notice');
      expect(prisma.consent_logs.findFirst).toHaveBeenCalledWith({
        where: { business_id: BIZ, phone: PHONE, source: 'first_contact_notice' },
        orderBy: { granted_at: 'desc' },
      });
    });
  });

  describe('listConsents', () => {
    it('scopes to the business + phone', async () => {
      await repo.listConsents(BIZ, PHONE);
      expect(prisma.consent_logs.findMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, phone: PHONE },
        orderBy: { granted_at: 'desc' },
      });
    });
  });

  describe('revokeAllConsents', () => {
    it('revokes all active consents for a phone and returns the count', async () => {
      prisma.consent_logs.updateMany.mockResolvedValueOnce({ count: 3 });
      const n = await repo.revokeAllConsents(BIZ, PHONE);
      expect(n).toBe(3);
      const where = prisma.consent_logs.updateMany.mock.calls[0][0].where;
      expect(where).toMatchObject({ business_id: BIZ, phone: PHONE, revoked_at: null });
      expect(where.consent_type).toBeUndefined();
    });

    it('narrows to a single type when supplied', async () => {
      await repo.revokeAllConsents(BIZ, PHONE, ConsentType.MARKETING);
      expect(prisma.consent_logs.updateMany.mock.calls[0][0].where.consent_type).toBe(
        ConsentType.MARKETING,
      );
    });
  });

  // ── Settings ────────────────────────────────────────────────────────────────

  describe('findSettings', () => {
    it('looks up settings by business_id', async () => {
      await repo.findSettings(BIZ);
      expect(prisma.realty_compliance_settings.findUnique).toHaveBeenCalledWith({
        where: { business_id: BIZ },
      });
    });
  });

  describe('upsertSettings', () => {
    it('stamps data_processor_agreed_at only when the agreement flips true', async () => {
      await repo.upsertSettings(BIZ, { dataProcessorAgreement: true });
      const call = prisma.realty_compliance_settings.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ business_id: BIZ });
      expect(call.create.data_processor_agreed_at).toBeInstanceOf(Date);
      expect(call.update.data_processor_agreed_at).toBeInstanceOf(Date);
    });

    it('does not stamp the agreement timestamp when only retention changes', async () => {
      await repo.upsertSettings(BIZ, { retentionMonths: 12 });
      const call = prisma.realty_compliance_settings.upsert.mock.calls[0][0];
      expect(call.update.retention_months).toBe(12);
      expect(call.update.data_processor_agreed_at).toBeUndefined();
    });
  });

  describe('markRetentionRun', () => {
    it('upserts last_retention_run_at scoped to the business', async () => {
      await repo.markRetentionRun(BIZ, NOW);
      const call = prisma.realty_compliance_settings.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ business_id: BIZ });
      expect(call.create.last_retention_run_at).toBe(NOW);
      expect(call.update.last_retention_run_at).toBe(NOW);
    });
  });

  // ── Lead access + erasure ─────────────────────────────────────────────────────

  describe('findLeadByPhone / findLeadById', () => {
    it('scopes the phone lookup to the business', async () => {
      await repo.findLeadByPhone(BIZ, PHONE);
      expect(prisma.realty_leads.findFirst).toHaveBeenCalledWith({
        where: { business_id: BIZ, whatsapp_phone: PHONE },
      });
    });

    it('scopes the id lookup to the business', async () => {
      await repo.findLeadById(BIZ, 'lead-1');
      expect(prisma.realty_leads.findFirst).toHaveBeenCalledWith({
        where: { business_id: BIZ, id: 'lead-1' },
      });
    });
  });

  describe('listMessagesForConversation', () => {
    it('scopes to business + conversation, newest first, bounded', async () => {
      await repo.listMessagesForConversation(BIZ, 'conv-1');
      expect(prisma.messages.findMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, conversation_id: 'conv-1' },
        orderBy: { created_at: 'desc' },
        take: 200,
      });
    });
  });

  describe('updateLead', () => {
    it('scopes the update to business + id then re-reads the row', async () => {
      prisma.realty_leads.findFirst.mockResolvedValueOnce(leadRow({ name: 'New Name' }));
      const res = await repo.updateLead(BIZ, 'lead-1', { name: 'New Name' });
      expect(prisma.realty_leads.updateMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, id: 'lead-1' },
        data: { name: 'New Name' },
      });
      expect(res.name).toBe('New Name');
    });
  });

  describe('anonymizeLead (right to erasure)', () => {
    it('scrubs name/phone/email, clears memory, opts out, and stamps erasure metadata', async () => {
      const lead = leadRow();
      prisma.realty_leads.findFirst.mockResolvedValueOnce(leadRow({ name: ANONYMIZED_NAME }));

      await repo.anonymizeLead(BIZ, lead, 'RETENTION', NOW);

      const call = prisma.realty_leads.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ business_id: BIZ, id: lead.id });
      expect(call.data.name).toBe(ANONYMIZED_NAME);
      expect(call.data.whatsapp_phone).toBe(anonymizePhone(PHONE));
      expect(call.data.alt_phone).toBe(anonymizePhone('+919000000000'));
      expect(call.data.email).toBe(anonymizeEmail('ravi@example.com'));
      expect(call.data.extracted_facts).toEqual([]);
      expect(call.data.objections).toEqual([]);
      expect(call.data.promises).toEqual([]);
      expect(call.data.opt_out).toBe(true);
      expect(call.data.next_followup_at).toBeNull();
      expect(call.data.metadata).toMatchObject({
        note: 'keep',
        erased: true,
        erasedAt: NOW.toISOString(),
        erasureReason: 'RETENTION',
      });
    });

    it('leaves alt_phone null when the lead had none', async () => {
      await repo.anonymizeLead(BIZ, leadRow({ alt_phone: null }), 'REQUEST', NOW);
      expect(prisma.realty_leads.updateMany.mock.calls[0][0].data.alt_phone).toBeNull();
    });
  });

  describe('anonymizeConversationMessages', () => {
    it('nulls sender_id + text on the CLIENT messages of a conversation and returns the count', async () => {
      prisma.messages.updateMany.mockResolvedValueOnce({ count: 4 });
      const n = await repo.anonymizeConversationMessages(BIZ, 'conv-1');
      expect(n).toBe(4);
      const call = prisma.messages.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ business_id: BIZ, conversation_id: 'conv-1', sender_type: 'CLIENT' });
      expect(call.data).toEqual({ sender_id: null, text_content: null });
    });
  });

  // ── Retention sweep ───────────────────────────────────────────────────────────

  describe('findInactiveLeads', () => {
    it('selects business-scoped, non-deleted, not-yet-erased leads inactive past the cutoff', async () => {
      const cutoff = new Date('2024-07-03T00:00:00Z');
      await repo.findInactiveLeads(BIZ, cutoff);
      const call = prisma.realty_leads.findMany.mock.calls[0][0];
      expect(call.where.business_id).toBe(BIZ);
      expect(call.where.deleted_at).toBeNull();
      expect(call.where.OR).toEqual([
        { last_activity_at: { lt: cutoff } },
        { last_activity_at: null, created_at: { lt: cutoff } },
      ]);
      expect(call.where.NOT).toEqual({ metadata: { path: ['erased'], equals: true } });
      expect(call.take).toBe(500);
    });
  });

  describe('anonymizeOldMessages', () => {
    it('scrubs CLIENT messages older than the cutoff that still carry a sender', async () => {
      const cutoff = new Date('2024-07-03T00:00:00Z');
      prisma.messages.updateMany.mockResolvedValueOnce({ count: 9 });
      const n = await repo.anonymizeOldMessages(BIZ, cutoff);
      expect(n).toBe(9);
      const call = prisma.messages.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        business_id: BIZ,
        sender_type: 'CLIENT',
        created_at: { lt: cutoff },
        sender_id: { not: null },
      });
      expect(call.data).toEqual({ sender_id: null, text_content: null });
    });
  });

  describe('anonymizeOldFileUploads', () => {
    it('clears the filename and CDN link on attachments older than the cutoff', async () => {
      // A message's text is scrubbed by `anonymizeOldMessages`, but an image or
      // document message keeps its personal data beside that row: the sender's
      // own filename and a live link to the file.
      const cutoff = new Date('2024-07-03T00:00:00Z');
      prisma.file_uploads.updateMany.mockResolvedValueOnce({ count: 4 });

      const n = await repo.anonymizeOldFileUploads(BIZ, cutoff);

      expect(n).toBe(4);
      const call = prisma.file_uploads.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        business_id: BIZ,
        created_at: { lt: cutoff },
        OR: [
          { filename: { not: REDACTED_FILENAME } },
          { cdn_url: { not: null } },
          { thumbnail_key: { not: null } },
        ],
      });
      expect(call.data).toEqual({
        filename: REDACTED_FILENAME,
        cdn_url: null,
        thumbnail_key: null,
      });
    });

    it('keeps storage_key — it is the only handle to the stored object', async () => {
      // Nulling it would strand the object permanently instead of erasing it.
      prisma.file_uploads.updateMany.mockResolvedValueOnce({ count: 1 });

      await repo.anonymizeOldFileUploads(BIZ, new Date('2024-07-03T00:00:00Z'));

      const call = prisma.file_uploads.updateMany.mock.calls[0][0];
      expect(call.data).not.toHaveProperty('storage_key');
    });

    it('is scoped to the tenant', async () => {
      prisma.file_uploads.updateMany.mockResolvedValueOnce({ count: 0 });

      await repo.anonymizeOldFileUploads(BIZ, new Date('2024-07-03T00:00:00Z'));

      expect(prisma.file_uploads.updateMany.mock.calls[0][0].where.business_id).toBe(BIZ);
    });

    it('skips rows already scrubbed, so a weekly run is idempotent', async () => {
      // The OR is the guard: an already-redacted row matches nothing, so the
      // count reports real erasures rather than rewriting history every week.
      prisma.file_uploads.updateMany.mockResolvedValueOnce({ count: 0 });

      const n = await repo.anonymizeOldFileUploads(BIZ, new Date('2024-07-03T00:00:00Z'));

      expect(n).toBe(0);
      expect(prisma.file_uploads.updateMany.mock.calls[0][0].where.OR).toContainEqual({
        filename: { not: REDACTED_FILENAME },
      });
    });
  });

  describe('getBusinessName', () => {
    it('returns the name', async () => {
      expect(await repo.getBusinessName(BIZ)).toBe('Acme Realty');
      expect(prisma.businesses.findUnique).toHaveBeenCalledWith({
        where: { id: BIZ },
        select: { name: true },
      });
    });

    it('returns null when the business is missing', async () => {
      prisma.businesses.findUnique.mockResolvedValueOnce(null);
      expect(await repo.getBusinessName(BIZ)).toBeNull();
    });
  });

  describe('listBusinessIdsWithLeads', () => {
    it('returns the distinct business ids that have leads', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ business_id: BIZ }, { business_id: 'biz-2' }]);
      const ids = await repo.listBusinessIdsWithLeads();
      expect(ids).toEqual([BIZ, 'biz-2']);
    });

    /**
     * The point of the raw query: Prisma's `distinct` de-duplicates in Node
     * after reading every lead row on the platform. This asserts the work
     * happens in Postgres, so the read stays proportional to the number of
     * tenants rather than the number of leads ever captured.
     */
    it('de-duplicates in Postgres rather than in Node', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await repo.listBusinessIdsWithLeads();

      expect(prisma.realty_leads.findMany).not.toHaveBeenCalled();
      const sql = prisma.$queryRaw.mock.calls[0][0].join('?').replace(/\s+/g, ' ');
      expect(sql).toContain('SELECT DISTINCT business_id');
    });

    it('returns an empty list when no tenant has leads', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      expect(await repo.listBusinessIdsWithLeads()).toEqual([]);
    });
  });
});
