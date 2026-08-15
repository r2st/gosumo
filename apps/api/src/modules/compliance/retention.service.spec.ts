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
import {
  RETENTION_LEAD_BATCH_SIZE,
  RETENTION_MAX_LEADS_PER_BUSINESS,
  RETENTION_RUN_BUDGET_MS,
} from './compliance.constants';

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
  anonymizeOldFileUploads: jest.Mock;
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
      anonymizeOldFileUploads: jest.fn().mockResolvedValue(0),
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
      expect(repo.findInactiveLeads).toHaveBeenCalledWith(BIZ_A, retentionCutoff(24, NOW), RETENTION_LEAD_BATCH_SIZE);
    });

    it('falls back to the default when settings exist but name no window', async () => {
      // A settings row created for the data-processor agreement alone leaves
      // retention_months null. Reading that as the window would make the
      // cutoff NaN and quietly anonymize nothing — or everything.
      repo.findSettings.mockResolvedValueOnce({ retention_months: null });

      const res = await service.runForBusiness(BIZ_A, NOW);

      expect(res.retentionMonths).toBe(DEFAULT_RETENTION_MONTHS);
      expect(res.cutoff).toEqual(retentionCutoff(DEFAULT_RETENTION_MONTHS, NOW));
    });

    it('honors a per-business retention window from settings', async () => {
      repo.findSettings.mockResolvedValueOnce({ retention_months: 12 });
      const res = await service.runForBusiness(BIZ_A, NOW);
      expect(res.retentionMonths).toBe(12);
      expect(repo.findInactiveLeads).toHaveBeenCalledWith(BIZ_A, retentionCutoff(12, NOW), RETENTION_LEAD_BATCH_SIZE);
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

    it('scrubs the media attached to messages past the window', async () => {
      // Anonymizing a message clears its text. An image or document message
      // carries its personal data in the `file_uploads` row beside it — the
      // sender's own filename, and a live CDN link to the file itself.
      repo.anonymizeOldFileUploads.mockResolvedValueOnce(6);

      const res = await service.runForBusiness(BIZ_A, NOW);

      expect(repo.anonymizeOldFileUploads).toHaveBeenCalledWith(
        BIZ_A,
        retentionCutoff(DEFAULT_RETENTION_MONTHS, NOW),
      );
      expect(res.attachmentsScrubbed).toBe(6);
    });

    it('scrubs attachments against the business-specific window, not the default', async () => {
      repo.findSettings.mockResolvedValueOnce({ retention_months: 12 });

      await service.runForBusiness(BIZ_A, NOW);

      expect(repo.anonymizeOldFileUploads).toHaveBeenCalledWith(BIZ_A, retentionCutoff(12, NOW));
    });

    it('counts attachments separately from messages', async () => {
      // They are different erasures: a message loses its text, an attachment
      // loses the filename and the link. Folding them into one number would
      // hide a sweep that scrubbed captions and left every document.
      repo.anonymizeOldMessages.mockResolvedValueOnce(3);
      repo.anonymizeOldFileUploads.mockResolvedValueOnce(2);

      const res = await service.runForBusiness(BIZ_A, NOW);

      expect(res.messagesAnonymized).toBe(3);
      expect(res.attachmentsScrubbed).toBe(2);
    });

    it('reports the run when attachments were the only thing scrubbed', async () => {
      // A business whose leads and message text are already clean can still be
      // holding attachment filenames; that run is not a no-op.
      repo.anonymizeOldFileUploads.mockResolvedValueOnce(4);

      const res = await service.runForBusiness(BIZ_A, NOW);

      expect(res.attachmentsScrubbed).toBe(4);
      expect(emit).toHaveBeenCalledWith('realty.retention.run', expect.anything());
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

  // ─────────────────────────────────────────────
  // Backlog draining
  //
  // The sweep used to be a single page: it took 500 leads, erased them, marked
  // the run, and returned. A business with 1200 leads past its window had 700
  // of them left live for another week — and the run reported success, because
  // "how many did we not get to" was not a number anybody computed.
  // ─────────────────────────────────────────────
  describe('draining a backlog larger than one page', () => {
    /** A full page of distinct leads, as the repository would return one. */
    function fullPage(tag: string): realty_leads[] {
      return Array.from({ length: RETENTION_LEAD_BATCH_SIZE }, (_, i) =>
        lead(`${tag}-${i}`),
      );
    }

    it('keeps paging until the backlog is drained, not just once', async () => {
      // 500 + 500 + 20: two full pages then a short one.
      repo.findInactiveLeads
        .mockResolvedValueOnce(fullPage('p1'))
        .mockResolvedValueOnce(fullPage('p2'))
        .mockResolvedValueOnce([lead('tail-1'), lead('tail-2')]);

      const res = await service.runForBusiness(BIZ_A, NOW);

      expect(repo.findInactiveLeads).toHaveBeenCalledTimes(3);
      expect(res.leadsAnonymized).toBe(RETENTION_LEAD_BATCH_SIZE * 2 + 2);
      // The backlog is gone, so nothing is outstanding.
      expect(res.leadsPending).toBe(false);
    });

    it('stops asking once a page comes back short', async () => {
      repo.findInactiveLeads.mockResolvedValueOnce([lead('1'), lead('2')]);
      const res = await service.runForBusiness(BIZ_A, NOW);

      // A short page is the end of the backlog — a second query would only
      // confirm what the row count already said.
      expect(repo.findInactiveLeads).toHaveBeenCalledTimes(1);
      expect(res.leadsPending).toBe(false);
    });

    it('stops at the per-business ceiling and flags that leads remain', async () => {
      // Every page is full, so the backlog never ends.
      repo.findInactiveLeads.mockImplementation(async () => fullPage('endless'));

      const res = await service.runForBusiness(BIZ_A, NOW);

      expect(res.leadsAnonymized).toBe(RETENTION_MAX_LEADS_PER_BUSINESS);
      // The whole point: the caller can tell a cleared backlog from a ceiling.
      expect(res.leadsPending).toBe(true);
    });

    it('stops erasing at a deadline that has already passed', async () => {
      repo.findInactiveLeads.mockImplementation(async () => fullPage('endless'));

      // A deadline in the past — the budget was spent by earlier businesses.
      const res = await service.runForBusiness(BIZ_A, NOW, Date.now() - 1);

      expect(repo.findInactiveLeads).not.toHaveBeenCalled();
      expect(res.leadsAnonymized).toBe(0);
      expect(res.leadsPending).toBe(true);
      // Still marks the run and still scrubs orphan messages — the deadline
      // bounds the per-lead work, it does not skip the single-statement sweep.
      expect(repo.anonymizeOldMessages).toHaveBeenCalled();
      expect(repo.markRetentionRun).toHaveBeenCalledWith(BIZ_A, NOW);
    });
  });

  // ─────────────────────────────────────────────
  // Poison leads
  //
  // Paging only terminates because erasing a lead excludes it from the next
  // query. A lead that cannot be erased is therefore returned forever, so a
  // row that throws is both a correctness risk (an unbounded loop) and, before
  // paging existed, a availability one: it aborted the whole tenant's sweep.
  // ─────────────────────────────────────────────
  describe('a lead that cannot be erased', () => {
    it('steps over a throwing lead and still erases the rest of the page', async () => {
      repo.findInactiveLeads.mockResolvedValueOnce([
        lead('poison'),
        lead('ok-1'),
        lead('ok-2'),
      ]);
      compliance.eraseLead.mockImplementation(async (_biz: string, l: realty_leads) => {
        if (l.id === 'poison') throw new Error('constraint violation');
        return { erased: true, leadId: l.id, messagesAnonymized: 1, consentsRevoked: 0 };
      });

      const res = await service.runForBusiness(BIZ_A, NOW);

      expect(res.leadsAnonymized).toBe(2);
      // The lead is still past its window, so the run is not clean.
      expect(res.leadsPending).toBe(true);
    });

    it('does not re-fetch forever when a whole page is unerasable', async () => {
      // Every lead throws and none is marked erased, so the same page comes
      // back on every query. Without a no-progress guard this never returns.
      repo.findInactiveLeads.mockImplementation(async () => [
        lead('poison-1'),
        lead('poison-2'),
      ]);
      compliance.eraseLead.mockRejectedValue(new Error('always fails'));

      const res = await service.runForBusiness(BIZ_A, NOW);

      expect(repo.findInactiveLeads).toHaveBeenCalledTimes(1);
      expect(res.leadsAnonymized).toBe(0);
      expect(res.leadsPending).toBe(true);
    });

    it('treats a lead that reports erased=false as immovable, not as progress', async () => {
      repo.findInactiveLeads.mockImplementation(async () => [lead('stuck')]);
      compliance.eraseLead.mockResolvedValue({
        erased: false,
        leadId: null,
        messagesAnonymized: 0,
        consentsRevoked: 0,
      });

      const res = await service.runForBusiness(BIZ_A, NOW);

      // It would be returned by the next query too — one attempt is enough.
      expect(compliance.eraseLead).toHaveBeenCalledTimes(1);
      expect(repo.findInactiveLeads).toHaveBeenCalledTimes(1);
      expect(res.leadsPending).toBe(true);
    });
  });

  describe('runAll', () => {
    it('sweeps every business with a compliance footprint', async () => {
      repo.listBusinessIdsWithLeads.mockResolvedValueOnce([BIZ_A, BIZ_B]);
      const { results } = await service.runAll(NOW);

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

      const { results } = await service.runAll(NOW);

      expect(results).toHaveLength(1);
      expect(results[0]?.businessId).toBe(BIZ_B);
    });

    it('survives a business that rejects with something that is not an Error', async () => {
      // A driver-level rejection can be a plain string or object. The handler
      // stringifies rather than reading `.message` off it — reading it blind
      // would throw *inside the catch*, which aborts the whole sweep and so
      // skips every remaining tenant's purge.
      repo.listBusinessIdsWithLeads.mockResolvedValueOnce([BIZ_A, BIZ_B]);
      repo.findInactiveLeads
        .mockRejectedValueOnce('connection terminated')
        .mockResolvedValueOnce([]);

      const { results } = await service.runAll(NOW);

      expect(results).toHaveLength(1);
      expect(results[0]?.businessId).toBe(BIZ_B);
    });

    it('reports an empty sweep when no business has leads', async () => {
      expect(await service.runAll(NOW)).toEqual({
        results: [],
        businessesSkipped: 0,
        businessesPending: 0,
      });
    });

    it('counts the businesses left with leads past their window', async () => {
      repo.listBusinessIdsWithLeads.mockResolvedValueOnce([BIZ_A, BIZ_B]);
      // BIZ_A has an endless backlog; BIZ_B is clean.
      repo.findInactiveLeads.mockImplementation(async (bid: string) =>
        bid === BIZ_A
          ? Array.from({ length: RETENTION_LEAD_BATCH_SIZE }, (_, i) => lead(`a-${i}`))
          : [],
      );

      const summary = await service.runAll(NOW);

      expect(summary.businessesPending).toBe(1);
      expect(summary.businessesSkipped).toBe(0);
    });

    it('counts — rather than silently drops — businesses it ran out of time for', async () => {
      repo.listBusinessIdsWithLeads.mockResolvedValueOnce([BIZ_A, BIZ_B]);
      // Burn the entire run budget inside the first business, so the second is
      // never reached. A `results` array of length 1 looks identical to a
      // one-business sweep unless the skip is counted.
      const realNow = Date.now.bind(Date);
      const start = realNow();
      let calls = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => {
        // Third reading onward is past the budget: entry check for BIZ_A
        // passes, then the deadline has blown.
        calls += 1;
        return calls <= 2 ? start : start + RETENTION_RUN_BUDGET_MS + 1;
      });

      try {
        const summary = await service.runAll(NOW);
        expect(summary.businessesSkipped).toBe(1);
        expect(summary.results).toHaveLength(1);
        expect(summary.results[0]?.businessId).toBe(BIZ_A);
      } finally {
        jest.spyOn(Date, 'now').mockRestore();
      }
    });
  });

  describe('cross-tenant isolation', () => {
    it('threads each businessId into its own scoped calls during runAll', async () => {
      repo.listBusinessIdsWithLeads.mockResolvedValueOnce([BIZ_A, BIZ_B]);
      repo.findInactiveLeads.mockImplementation(async (bid) => [lead(`${bid}-lead`, { business_id: bid })]);

      await service.runAll(NOW);

      // Each business's inactive-lead scan and erase is scoped to that business.
      expect(repo.findInactiveLeads).toHaveBeenCalledWith(BIZ_A, retentionCutoff(24, NOW), RETENTION_LEAD_BATCH_SIZE);
      expect(repo.findInactiveLeads).toHaveBeenCalledWith(BIZ_B, retentionCutoff(24, NOW), RETENTION_LEAD_BATCH_SIZE);
      const erasedBiz = compliance.eraseLead.mock.calls.map((c) => c[0]).sort();
      expect(erasedBiz).toEqual([BIZ_A, BIZ_B].sort());
      // No erase ever ran a lead under the wrong tenant.
      for (const [bid, l] of compliance.eraseLead.mock.calls) {
        expect(l.business_id).toBe(bid);
      }
    });
  });
});
