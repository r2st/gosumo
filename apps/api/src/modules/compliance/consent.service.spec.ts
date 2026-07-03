/**
 * ConsentService unit tests — the DPDPA consent ledger (business plan §21).
 *
 * Covers: idempotent grant per (phone, type), revocation counts, opt-out
 * revoke-all, history retrieval, the emitted `realty.consent.recorded` event,
 * and — critically — cross-tenant isolation (business A's consent must never
 * satisfy or revoke business B's).
 */

import { ConsentType } from '@prisma/client';
import type { consent_logs } from '@prisma/client';
import { ConsentService, type RecordConsentInput } from './consent.service';

const BIZ_A = '00000000-0000-4000-a000-00000000000a';
const BIZ_B = '00000000-0000-4000-a000-00000000000b';
const PHONE = '+919876543210';

function consentRow(over: Partial<consent_logs> = {}): consent_logs {
  return {
    id: 'consent-1',
    business_id: BIZ_A,
    phone: PHONE,
    consent_type: ConsentType.PROCESSING,
    channel: 'WHATSAPP',
    message_id: null,
    source: null,
    granted_at: new Date('2026-01-01T00:00:00Z'),
    revoked_at: null,
    ...over,
  } as consent_logs;
}

type RepoMock = {
  findActiveConsent: jest.Mock;
  createConsent: jest.Mock;
  revokeAllConsents: jest.Mock;
  listConsents: jest.Mock;
};

describe('ConsentService', () => {
  let repo: RepoMock;
  let emit: jest.Mock;
  let service: ConsentService;

  beforeEach(() => {
    repo = {
      findActiveConsent: jest.fn().mockResolvedValue(null),
      createConsent: jest.fn().mockImplementation(async (d) => consentRow({ channel: d.channel })),
      revokeAllConsents: jest.fn().mockResolvedValue(0),
      listConsents: jest.fn().mockResolvedValue([]),
    };
    emit = jest.fn();
    service = new ConsentService(repo as never, { emit } as never);
  });

  const grant = (input: Partial<RecordConsentInput> = {}): RecordConsentInput => ({
    phone: PHONE,
    consentType: ConsentType.PROCESSING,
    ...input,
  });

  describe('recordConsent', () => {
    it('writes a new consent row scoped to the business and defaults channel to SYSTEM', async () => {
      await service.recordConsent(BIZ_A, grant());

      expect(repo.findActiveConsent).toHaveBeenCalledWith(BIZ_A, PHONE, ConsentType.PROCESSING);
      expect(repo.createConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BIZ_A,
          phone: PHONE,
          consentType: ConsentType.PROCESSING,
          channel: 'SYSTEM',
          granted: true,
        }),
      );
    });

    it('passes through channel/messageId/source when provided', async () => {
      await service.recordConsent(
        BIZ_A,
        grant({ channel: 'WHATSAPP', messageId: 'msg-1', source: 'lead_created' }),
      );
      expect(repo.createConsent).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'WHATSAPP', messageId: 'msg-1', source: 'lead_created' }),
      );
    });

    it('is idempotent — an existing active consent is returned without a new row', async () => {
      const existing = consentRow();
      repo.findActiveConsent.mockResolvedValueOnce(existing);

      const result = await service.recordConsent(BIZ_A, grant());

      expect(result).toBe(existing);
      expect(repo.createConsent).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits realty.consent.recorded with granted=true on a fresh grant', async () => {
      await service.recordConsent(BIZ_A, grant({ channel: 'WHATSAPP' }));

      expect(emit).toHaveBeenCalledWith(
        'realty.consent.recorded',
        expect.objectContaining({
          type: 'realty.consent.recorded',
          businessId: BIZ_A,
          phone: PHONE,
          consentType: ConsentType.PROCESSING,
          granted: true,
          channel: 'WHATSAPP',
        }),
      );
    });

    it.each([ConsentType.PROCESSING, ConsentType.MARKETING, ConsentType.EXCHANGE])(
      'records each consent type (%s) independently',
      async (type) => {
        await service.recordConsent(BIZ_A, grant({ consentType: type }));
        expect(repo.createConsent).toHaveBeenCalledWith(
          expect.objectContaining({ consentType: type }),
        );
      },
    );
  });

  describe('revokeConsent (opt-out)', () => {
    it('revokes all active consents for a phone and returns the count', async () => {
      repo.revokeAllConsents.mockResolvedValueOnce(3);

      const count = await service.revokeConsent(BIZ_A, PHONE);

      expect(count).toBe(3);
      expect(repo.revokeAllConsents).toHaveBeenCalledWith(BIZ_A, PHONE, undefined);
    });

    it('revokes only the named type when one is given', async () => {
      repo.revokeAllConsents.mockResolvedValueOnce(1);
      await service.revokeConsent(BIZ_A, PHONE, ConsentType.MARKETING);
      expect(repo.revokeAllConsents).toHaveBeenCalledWith(BIZ_A, PHONE, ConsentType.MARKETING);
    });

    it('emits granted=false when something was actually revoked', async () => {
      repo.revokeAllConsents.mockResolvedValueOnce(2);
      await service.revokeConsent(BIZ_A, PHONE, undefined, 'WHATSAPP');

      expect(emit).toHaveBeenCalledWith(
        'realty.consent.recorded',
        expect.objectContaining({ granted: false, channel: 'WHATSAPP', consentType: 'ALL' }),
      );
    });

    it('does not emit when nothing was revoked (no active consent)', async () => {
      repo.revokeAllConsents.mockResolvedValueOnce(0);
      const count = await service.revokeConsent(BIZ_A, PHONE);
      expect(count).toBe(0);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('getHistory', () => {
    it('returns the full ledger history for a phone', async () => {
      const rows = [consentRow(), consentRow({ id: 'consent-2', revoked_at: new Date() })];
      repo.listConsents.mockResolvedValueOnce(rows);

      const history = await service.getHistory(BIZ_A, PHONE);

      expect(history).toBe(rows);
      expect(repo.listConsents).toHaveBeenCalledWith(BIZ_A, PHONE);
    });
  });

  describe('cross-tenant isolation', () => {
    it('threads the caller businessId into every ledger read/write', async () => {
      await service.recordConsent(BIZ_B, grant());
      expect(repo.findActiveConsent).toHaveBeenCalledWith(BIZ_B, PHONE, ConsentType.PROCESSING);
      expect(repo.createConsent).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ_B }),
      );
      expect(repo.createConsent).not.toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ_A }),
      );
    });

    it("an active consent for business A does not satisfy business B's idempotency check", async () => {
      // A stateful fake ledger keyed by (businessId, phone, type) — the real
      // isolation guarantee is that findActiveConsent is business-scoped.
      const store: consent_logs[] = [];
      repo.findActiveConsent.mockImplementation(async (bid, phone, type) =>
        store.find(
          (r) => r.business_id === bid && r.phone === phone && r.consent_type === type && !r.revoked_at,
        ) ?? null,
      );
      repo.createConsent.mockImplementation(async (d) => {
        const row = consentRow({ id: `c-${store.length}`, business_id: d.businessId });
        store.push(row);
        return row;
      });

      await service.recordConsent(BIZ_A, grant());
      await service.recordConsent(BIZ_B, grant()); // must create its own row, not reuse A's

      expect(repo.createConsent).toHaveBeenCalledTimes(2);
      expect(store.map((r) => r.business_id).sort()).toEqual([BIZ_A, BIZ_B].sort());
    });

    it("revoking business A's consent leaves business B's untouched", async () => {
      const store: consent_logs[] = [
        consentRow({ id: 'a', business_id: BIZ_A }),
        consentRow({ id: 'b', business_id: BIZ_B }),
      ];
      repo.revokeAllConsents.mockImplementation(async (bid, phone) => {
        const hits = store.filter((r) => r.business_id === bid && r.phone === phone && !r.revoked_at);
        hits.forEach((r) => (r.revoked_at = new Date()));
        return hits.length;
      });

      await service.revokeConsent(BIZ_A, PHONE);

      expect(store.find((r) => r.id === 'a')!.revoked_at).not.toBeNull();
      expect(store.find((r) => r.id === 'b')!.revoked_at).toBeNull();
    });
  });
});
