/**
 * ComplianceService unit tests — the DPDPA workflow surface (business plan §21).
 *
 * Covers the data-principal rights (access, correction, erasure), settings,
 * the first-contact notice, and the two event listeners (consent-on-create,
 * revoke-on-opt-out). Every erasure/correction must hit the append-only audit
 * trail (root rule #7) and emit its domain event. Cross-tenant isolation is
 * asserted throughout: no repository call may cross a business boundary.
 */

import { NotFoundException } from '@nestjs/common';
import { ConsentType } from '@prisma/client';
import type { realty_leads, messages } from '@prisma/client';
import { ComplianceService } from './compliance.service';
import { buildFirstContactNotice, DEFAULT_RETENTION_MONTHS } from './dpdpa.util';

const BIZ_A = '00000000-0000-4000-a000-00000000000a';
const BIZ_B = '00000000-0000-4000-a000-00000000000b';
const LEAD_ID = '00000000-0000-4000-a000-000000000010';
const RAW_PHONE = '9876543210';
const NORM_PHONE = '+919876543210';
const NOW = new Date('2026-07-03T00:00:00Z');

function lead(over: Partial<realty_leads> = {}): realty_leads {
  return {
    id: LEAD_ID,
    business_id: BIZ_A,
    name: 'Ravi Kumar',
    email: 'ravi@example.com',
    whatsapp_phone: NORM_PHONE,
    alt_phone: null,
    stage: 'NEW',
    source: 'WHATSAPP',
    extracted_facts: [],
    objections: [],
    promises: [],
    opt_out: false,
    conversation_id: 'conv-1',
    created_at: new Date('2026-01-01T00:00:00Z'),
    last_activity_at: new Date('2026-06-01T00:00:00Z'),
    next_followup_at: null,
    deleted_at: null,
    metadata: {},
    ...over,
  } as realty_leads;
}

function message(over: Partial<messages> = {}): messages {
  return {
    id: 'msg-1',
    business_id: BIZ_A,
    conversation_id: 'conv-1',
    direction: 'INBOUND',
    sender_type: 'CLIENT',
    text_content: 'Interested in Baner',
    created_at: new Date('2026-05-01T00:00:00Z'),
    ...over,
  } as messages;
}

type RepoMock = {
  findLeadByPhone: jest.Mock;
  findLeadById: jest.Mock;
  listConsents: jest.Mock;
  listMessagesForConversation: jest.Mock;
  updateLead: jest.Mock;
  anonymizeConversationMessages: jest.Mock;
  anonymizeLead: jest.Mock;
  findSettings: jest.Mock;
  upsertSettings: jest.Mock;
  getBusinessName: jest.Mock;
};

describe('ComplianceService', () => {
  let repo: RepoMock;
  let consent: { revokeConsent: jest.Mock; recordConsent: jest.Mock };
  let audit: { record: jest.Mock };
  let emit: jest.Mock;
  let service: ComplianceService;

  beforeEach(() => {
    repo = {
      findLeadByPhone: jest.fn().mockResolvedValue(null),
      findLeadById: jest.fn(),
      listConsents: jest.fn().mockResolvedValue([]),
      listMessagesForConversation: jest.fn().mockResolvedValue([]),
      updateLead: jest.fn(),
      anonymizeConversationMessages: jest.fn().mockResolvedValue(0),
      anonymizeLead: jest.fn().mockResolvedValue(lead()),
      findSettings: jest.fn().mockResolvedValue(null),
      upsertSettings: jest.fn().mockResolvedValue({}),
      getBusinessName: jest.fn().mockResolvedValue('Acme Realty'),
    };
    consent = {
      revokeConsent: jest.fn().mockResolvedValue(0),
      recordConsent: jest.fn().mockResolvedValue({ id: 'c-1' }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    emit = jest.fn();
    service = new ComplianceService(repo as never, consent as never, audit as never, { emit } as never);
  });

  // ── Right of access ────────────────────────────────────────────────────────

  describe('dataRequest (right of access §11)', () => {
    it('normalizes the phone, returns lead+messages+consents, and audits an EXPORT', async () => {
      const l = lead();
      repo.findLeadByPhone.mockResolvedValueOnce(l);
      repo.listConsents.mockResolvedValueOnce([{ id: 'c-1' }]);
      repo.listMessagesForConversation.mockResolvedValueOnce([message()]);

      const res = await service.dataRequest(BIZ_A, RAW_PHONE);

      expect(repo.findLeadByPhone).toHaveBeenCalledWith(BIZ_A, NORM_PHONE);
      expect(res.found).toBe(true);
      expect(res.phone).toBe(NORM_PHONE);
      expect(res.lead?.id).toBe(LEAD_ID);
      expect(res.messages).toHaveLength(1);
      expect(res.consents).toHaveLength(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BIZ_A,
          action: 'EXPORT',
          resourceType: 'realty_lead',
          resourceId: LEAD_ID,
        }),
      );
    });

    it('reports found=false and skips the message fetch when there is no lead', async () => {
      const res = await service.dataRequest(BIZ_A, RAW_PHONE);
      expect(res.found).toBe(false);
      expect(res.lead).toBeNull();
      expect(repo.listMessagesForConversation).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ resourceId: null }),
      );
    });

    it('skips the message fetch when the lead has no conversation', async () => {
      repo.findLeadByPhone.mockResolvedValueOnce(lead({ conversation_id: null }));
      await service.dataRequest(BIZ_A, RAW_PHONE);
      expect(repo.listMessagesForConversation).not.toHaveBeenCalled();
    });
  });

  // ── Right to correction ──────────────────────────────────────────────────────

  describe('correction (§12)', () => {
    it('applies only the supplied fields and audits before/after', async () => {
      const before = lead();
      const after = lead({ name: 'Ravi K.', email: 'new@example.com' });
      repo.findLeadByPhone.mockResolvedValueOnce(before);
      repo.updateLead.mockResolvedValueOnce(after);

      const res = await service.correction(BIZ_A, {
        phone: RAW_PHONE,
        name: 'Ravi K.',
        email: 'new@example.com',
      });

      expect(res).toBe(after);
      const [, leadId, data] = repo.updateLead.mock.calls[0];
      expect(leadId).toBe(LEAD_ID);
      expect(data.name).toBe('Ravi K.');
      expect(data.email).toBe('new@example.com');
      expect(data.alt_phone).toBeUndefined();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE',
          before: { name: 'Ravi Kumar', email: 'ravi@example.com', altPhone: null },
          after: expect.objectContaining({ name: 'Ravi K.', email: 'new@example.com' }),
        }),
      );
    });

    it('throws NotFoundException when the lead does not exist', async () => {
      await expect(service.correction(BIZ_A, { phone: RAW_PHONE })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.updateLead).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // ── Right to erasure ─────────────────────────────────────────────────────────

  describe('erasure (§13 — anonymize in place)', () => {
    it('revokes consent, anonymizes messages + lead, audits a DELETE, emits, and reports counts', async () => {
      repo.findLeadByPhone.mockResolvedValueOnce(lead());
      consent.revokeConsent.mockResolvedValueOnce(2);
      repo.anonymizeConversationMessages.mockResolvedValueOnce(5);

      const res = await service.erasure(BIZ_A, RAW_PHONE, 'REQUEST', NOW);

      expect(consent.revokeConsent).toHaveBeenCalledWith(BIZ_A, NORM_PHONE);
      expect(repo.anonymizeConversationMessages).toHaveBeenCalledWith(BIZ_A, 'conv-1');
      expect(repo.anonymizeLead).toHaveBeenCalledWith(BIZ_A, expect.objectContaining({ id: LEAD_ID }), 'REQUEST', NOW);
      expect(res).toEqual({
        erased: true,
        leadId: LEAD_ID,
        messagesAnonymized: 5,
        consentsRevoked: 2,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DELETE', actorType: 'API', resourceId: LEAD_ID }),
      );
      expect(emit).toHaveBeenCalledWith(
        'realty.lead.erased',
        expect.objectContaining({ type: 'realty.lead.erased', leadId: LEAD_ID, reason: 'REQUEST' }),
      );
    });

    it('audits as SYSTEM actor when the reason is RETENTION', async () => {
      repo.findLeadByPhone.mockResolvedValueOnce(lead());
      await service.erasure(BIZ_A, RAW_PHONE, 'RETENTION', NOW);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DELETE', actorType: 'SYSTEM' }),
      );
    });

    it('is a no-op erase (but still revokes consent) when no lead is held', async () => {
      consent.revokeConsent.mockResolvedValueOnce(1);
      const res = await service.erasure(BIZ_A, RAW_PHONE);
      expect(res).toEqual({ erased: false, leadId: null, messagesAnonymized: 0, consentsRevoked: 1 });
      expect(repo.anonymizeLead).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('skips message anonymization when the lead has no conversation', async () => {
      repo.findLeadByPhone.mockResolvedValueOnce(lead({ conversation_id: null }));
      const res = await service.erasure(BIZ_A, RAW_PHONE, 'REQUEST', NOW);
      expect(repo.anonymizeConversationMessages).not.toHaveBeenCalled();
      expect(res.messagesAnonymized).toBe(0);
      expect(res.erased).toBe(true);
    });

    it('is idempotent — re-erasing an already-anonymized lead still succeeds', async () => {
      // Second pass: lead already erased (metadata.erased) but findLeadByPhone
      // won't match the hashed phone, so it behaves as "no lead" — no throw.
      repo.findLeadByPhone.mockResolvedValueOnce(null);
      const res = await service.erasure(BIZ_A, RAW_PHONE, 'REQUEST', NOW);
      expect(res.erased).toBe(false);
    });

    it('defaults reason to REQUEST and now to a real Date when omitted', async () => {
      repo.findLeadByPhone.mockResolvedValueOnce(lead());
      await service.erasure(BIZ_A, RAW_PHONE);
      expect(repo.anonymizeLead).toHaveBeenCalledWith(
        BIZ_A,
        expect.anything(),
        'REQUEST',
        expect.any(Date),
      );
    });
  });

  // ── Settings ────────────────────────────────────────────────────────────────

  describe('settings', () => {
    it('returns defaults when no settings row exists', async () => {
      const s = await service.getSettings(BIZ_A);
      expect(s).toEqual({
        retentionMonths: DEFAULT_RETENTION_MONTHS,
        dataProcessorAgreement: false,
        dataProcessorAgreedAt: null,
        lastRetentionRunAt: null,
      });
    });

    it('maps a stored settings row onto the DTO', async () => {
      const agreedAt = new Date('2026-02-02T00:00:00Z');
      repo.findSettings.mockResolvedValue({
        retention_months: 12,
        data_processor_agreement: true,
        data_processor_agreed_at: agreedAt,
        last_retention_run_at: null,
      });
      const s = await service.getSettings(BIZ_A);
      expect(s.retentionMonths).toBe(12);
      expect(s.dataProcessorAgreement).toBe(true);
      expect(s.dataProcessorAgreedAt).toBe(agreedAt);
    });

    it('upserts + audits on update and returns the fresh settings', async () => {
      repo.findSettings.mockResolvedValue({ retention_months: 36 });
      const s = await service.updateSettings(BIZ_A, { retentionMonths: 36 });
      expect(repo.upsertSettings).toHaveBeenCalledWith(BIZ_A, { retentionMonths: 36 });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE',
          resourceType: 'realty_compliance_settings',
          actorType: 'TEAM_MEMBER',
        }),
      );
      expect(s.retentionMonths).toBe(36);
    });
  });

  // ── First-contact notice + report ─────────────────────────────────────────────

  describe('firstContactNotice', () => {
    it('builds the notice from the business name', async () => {
      expect(await service.firstContactNotice(BIZ_A)).toBe(buildFirstContactNotice('Acme Realty'));
    });

    it('falls back to the generic name when unknown', async () => {
      repo.getBusinessName.mockResolvedValueOnce(null);
      expect(await service.firstContactNotice(BIZ_A)).toBe(buildFirstContactNotice('this brokerage'));
    });
  });

  describe('complianceReport', () => {
    it('assembles the fiduciary/processor report from settings + business name', async () => {
      repo.findSettings.mockResolvedValue({ retention_months: 24, data_processor_agreement: true });
      const report = await service.complianceReport(BIZ_A);
      expect(report).toMatchObject({
        businessId: BIZ_A,
        dataFiduciary: 'Acme Realty',
        dataProcessor: 'GoSumo Realty',
        retentionMonths: 24,
        dataProcessorAgreement: true,
      });
    });
  });

  // ── Event listeners ───────────────────────────────────────────────────────────

  describe('onLeadCreated', () => {
    it('records PROCESSING consent when a lead is captured', async () => {
      await service.onLeadCreated({
        businessId: BIZ_A,
        leadId: LEAD_ID,
        whatsappPhone: NORM_PHONE,
        source: 'WHATSAPP',
      } as never);

      expect(consent.recordConsent).toHaveBeenCalledWith(
        BIZ_A,
        expect.objectContaining({
          phone: NORM_PHONE,
          consentType: ConsentType.PROCESSING,
          channel: 'WHATSAPP',
          source: 'lead_created',
        }),
      );
    });

    it('swallows a consent-write failure (listener must not throw)', async () => {
      consent.recordConsent.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.onLeadCreated({ businessId: BIZ_A, leadId: LEAD_ID, whatsappPhone: NORM_PHONE } as never),
      ).resolves.toBeUndefined();
    });
  });

  describe('onLeadOptedOut', () => {
    it('revokes all consent on the ledger over the WHATSAPP channel', async () => {
      await service.onLeadOptedOut({
        businessId: BIZ_A,
        leadId: LEAD_ID,
        whatsappPhone: NORM_PHONE,
      } as never);
      expect(consent.revokeConsent).toHaveBeenCalledWith(BIZ_A, NORM_PHONE, undefined, 'WHATSAPP');
    });

    it('swallows a revoke failure (listener must not throw)', async () => {
      consent.revokeConsent.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.onLeadOptedOut({ businessId: BIZ_A, leadId: LEAD_ID, whatsappPhone: NORM_PHONE } as never),
      ).resolves.toBeUndefined();
    });
  });

  // ── Cross-tenant isolation ────────────────────────────────────────────────────

  describe('cross-tenant isolation', () => {
    it('scopes every access-path repository call to the calling business', async () => {
      repo.findLeadByPhone.mockResolvedValueOnce(lead({ business_id: BIZ_B }));
      repo.listMessagesForConversation.mockResolvedValueOnce([message({ business_id: BIZ_B })]);
      await service.dataRequest(BIZ_B, RAW_PHONE);

      expect(repo.findLeadByPhone).toHaveBeenCalledWith(BIZ_B, NORM_PHONE);
      expect(repo.listConsents).toHaveBeenCalledWith(BIZ_B, NORM_PHONE);
      expect(repo.listMessagesForConversation).toHaveBeenCalledWith(BIZ_B, 'conv-1');
      expect(repo.findLeadByPhone).not.toHaveBeenCalledWith(BIZ_A, expect.anything());
    });

    it('erasure for business B never touches business A rows', async () => {
      repo.findLeadByPhone.mockResolvedValueOnce(lead({ business_id: BIZ_B }));
      await service.erasure(BIZ_B, RAW_PHONE, 'REQUEST', NOW);

      expect(consent.revokeConsent).toHaveBeenCalledWith(BIZ_B, NORM_PHONE);
      expect(repo.anonymizeConversationMessages).toHaveBeenCalledWith(BIZ_B, 'conv-1');
      expect(repo.anonymizeLead.mock.calls[0][0]).toBe(BIZ_B);
      expect(emit).toHaveBeenCalledWith(
        'realty.lead.erased',
        expect.objectContaining({ businessId: BIZ_B }),
      );
    });
  });
});
