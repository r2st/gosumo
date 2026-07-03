/**
 * RetentionService unit tests — the scheduled DPDPA data-minimization sweep
 * (business plan §21). Verifies the 24-month cutoff math, per-business
 * anonymization of inactive leads + old messages, the aggregate counts, the
 * emitted `realty.retention.run` event, run-marking, the runAll fan-out with
 * per-business error isolation, and cross-tenant scoping.
 */

import type { realty_leads } from '@prisma/client';
import { RetentionService } from './retention.service';
import { DEFAULT_RETENTION_MONTHS, retentionCutoff } from './dpdpa.util';

const BIZ_A = '00000000-0000-4000-a000-00000000000a';
const BIZ_B = '00000000-0000-4000-a000-00000000000b';
const NOW = new Date('2026-07-03T00:00:00Z');

function lead(id: string, over: Partial<realty_leads> = {}): realty_leads {
  return {
    id,
    business_id: BIZ_A,
    conversation_id: `conv-${id}`,
    created_at: new Date('2023-01-01T00:00:00Z'),
    last_activity_at: new Date('2023-06-01T00:00:00Z'),
    ...over,
  } as realty_leads;
}

type RepoMock = {
  findSettings: jest.Mock;
  findInactiveLeads: jest.Mock;
  anonymizeOldMessages: jest.Mock;
  markRetentionRun: jest.Mock;
  listBusinessIdsWithLeads: jest.Mock;
};

describe('RetentionService', () => {
  let repo: RepoMock;
  let compliance: { eraseLead: jest.Mock };
  let emit: jest.Mock;
  let service: RetentionService;

  beforeEach(() => {
    repo = {
      findSettings: jest.fn().mockResolvedValue(null),
      findInactiveLeads: jest.fn().mockResolvedValue([]),
      anonymizeOldMessages: jest.fn().mockResolvedValue(0),
      markRetentionRun: jest.fn().mockResolvedValue(undefined),
      listBusinessIdsWithLeads: jest.fn().mockResolvedValue([]),
    };
    compliance = {
      eraseLead: jest
        .fn()
        .mockImplementation(async (_biz, l) => ({ erased: true, leadId: l.id, messagesAnonymized: 2, consentsRevoked: 0 })),
    };
    emit = jest.fn();
    service = new RetentionService(repo as never, compliance as never, { emit } as never);
  });

  describe('runForBusiness', () => {
    it('uses the default 24-month window when the business has no settings', async () => {
      const res = await service.runForBusiness(BIZ_A, NOW);
      expect(res.retentionMonths).toBe(DEFAULT_RETENTION_MONTHS);
      expect(res.cutoff).toEqual(retentionCutoff(24, NOW));
      expect(repo.findInactiveLeads).toHaveBeenCalledWith(BIZ_A, retentionCutoff(24, NOW));
    });

    it('honors a per-business retention window from settings', async () => {
      repo.findSettings.mockResolvedValueOnce({ retention_months: 12 });
      const res = await service.runForBusiness(BIZ_A, NOW);
      expect(res.retentionMonths).toBe(12);
      expect(repo.findInactiveLeads).toHaveBeenCalledWith(BIZ_A, retentionCutoff(12, NOW));
    });

    it('anonymizes each inactive lead and aggregates lead + message counts', async () => {
      repo.findInactiveLeads.mockResolvedValueOnce([lead('1'), lead('2')]);
      repo.anonymizeOldMessages.mockResolvedValueOnce(3); // orphan messages

      const res = await service.runForBusiness(BIZ_A, NOW);

      expect(compliance.eraseLead).toHaveBeenCalledTimes(2);
      expect(compliance.eraseLead).toHaveBeenCalledWith(BIZ_A, expect.objectContaining({ id: '1' }), 'RETENTION', NOW);
      expect(res.leadsAnonymized).toBe(2);
      // 2 leads × 2 messages each + 3 orphan messages = 7
      expect(res.messagesAnonymized).toBe(7);
    });

    it('does not count a lead whose erase reported erased=false', async () => {
      repo.findInactiveLeads.mockResolvedValueOnce([lead('1'), lead('2')]);
      compliance.eraseLead
        .mockResolvedValueOnce({ erased: false, leadId: null, messagesAnonymized: 0, consentsRevoked: 0 })
        .mockResolvedValueOnce({ erased: true, leadId: '2', messagesAnonymized: 4, consentsRevoked: 0 });

      const res = await service.runForBusiness(BIZ_A, NOW);
      expect(res.leadsAnonymized).toBe(1);
      expect(res.messagesAnonymized).toBe(4);
    });

    it('always marks the retention run, even on a clean (no-op) sweep', async () => {
      const res = await service.runForBusiness(BIZ_A, NOW);
      expect(repo.markRetentionRun).toHaveBeenCalledWith(BIZ_A, NOW);
      expect(res.leadsAnonymized).toBe(0);
      expect(res.messagesAnonymized).toBe(0);
    });

    it('emits realty.retention.run only when something was anonymized', async () => {
      repo.findInactiveLeads.mockResolvedValueOnce([lead('1')]);
      await service.runForBusiness(BIZ_A, NOW);
      expect(emit).toHaveBeenCalledWith(
        'realty.retention.run',
        expect.objectContaining({
          type: 'realty.retention.run',
          businessId: BIZ_A,
          leadsAnonymized: 1,
          messagesAnonymized: 2,
          retentionMonths: DEFAULT_RETENTION_MONTHS,
        }),
      );
    });

    it('does not emit when the sweep anonymized nothing', async () => {
      await service.runForBusiness(BIZ_A, NOW);
      expect(emit).not.toHaveBeenCalled();
    });

    it('emits when only orphan messages (no leads) were scrubbed', async () => {
      repo.anonymizeOldMessages.mockResolvedValueOnce(5);
      await service.runForBusiness(BIZ_A, NOW);
      expect(emit).toHaveBeenCalledWith(
        'realty.retention.run',
        expect.objectContaining({ leadsAnonymized: 0, messagesAnonymized: 5 }),
      );
    });
  });

  describe('runAll', () => {
    it('sweeps every business with a compliance footprint', async () => {
      repo.listBusinessIdsWithLeads.mockResolvedValueOnce([BIZ_A, BIZ_B]);
      const results = await service.runAll(NOW);

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.businessId)).toEqual([BIZ_A, BIZ_B]);
      expect(repo.markRetentionRun).toHaveBeenCalledWith(BIZ_A, NOW);
      expect(repo.markRetentionRun).toHaveBeenCalledWith(BIZ_B, NOW);
    });

    it('isolates a per-business failure — one bad business does not abort the rest', async () => {
      repo.listBusinessIdsWithLeads.mockResolvedValueOnce([BIZ_A, BIZ_B]);
      repo.findInactiveLeads
        .mockRejectedValueOnce(new Error('biz A blew up')) // BIZ_A fails
        .mockResolvedValueOnce([]); // BIZ_B succeeds

      const results = await service.runAll(NOW);

      expect(results).toHaveLength(1);
      expect(results[0]?.businessId).toBe(BIZ_B);
    });

    it('returns an empty array when no business has leads', async () => {
      expect(await service.runAll(NOW)).toEqual([]);
    });
  });

  describe('cross-tenant isolation', () => {
    it('threads each businessId into its own scoped calls during runAll', async () => {
      repo.listBusinessIdsWithLeads.mockResolvedValueOnce([BIZ_A, BIZ_B]);
      repo.findInactiveLeads.mockImplementation(async (bid) => [lead(`${bid}-lead`, { business_id: bid })]);

      await service.runAll(NOW);

      // Each business's inactive-lead scan and erase is scoped to that business.
      expect(repo.findInactiveLeads).toHaveBeenCalledWith(BIZ_A, retentionCutoff(24, NOW));
      expect(repo.findInactiveLeads).toHaveBeenCalledWith(BIZ_B, retentionCutoff(24, NOW));
      const erasedBiz = compliance.eraseLead.mock.calls.map((c) => c[0]).sort();
      expect(erasedBiz).toEqual([BIZ_A, BIZ_B].sort());
      // No erase ever ran a lead under the wrong tenant.
      for (const [bid, l] of compliance.eraseLead.mock.calls) {
        expect(l.business_id).toBe(bid);
      }
    });
  });
});
