/**
 * AiQualityService unit tests.
 *
 * Covers the two halves of the module: the scheduled rollup (catch-up, the
 * per-run cap, the time budget, cross-tenant fan-out, never counting an open
 * bucket) and the read API (rate arithmetic, decile folding, the percentile
 * honesty flag, window validation).
 */

import { BadRequestException } from '@nestjs/common';
import { AiQualityBucket, ChannelType } from '@prisma/client';
import type { ai_quality_metrics } from '@prisma/client';
import { AiQualityService } from './ai-quality.service';
import type { RollupGroup } from './ai-quality.repository';
import { AI_QUALITY_MAX_BUCKETS_PER_RUN, MAX_QUALITY_WINDOW_DAYS } from './ai-quality.constants';

const BIZ_A = '00000000-0000-4000-a000-00000000000a';
const BIZ_B = '00000000-0000-4000-a000-00000000000b';
const NOW = new Date('2026-08-15T13:47:00Z');

/** Prisma hands Decimal columns back as objects; only `Number()` is used on them. */
function dec(n: number): never {
  return { toNumber: () => n, toString: () => String(n) } as never;
}

function group(over: Partial<RollupGroup> = {}): RollupGroup {
  return {
    business_id: BIZ_A,
    channel: ChannelType.WHATSAPP,
    decisions: 10,
    auto_executed: 6,
    sent_for_review: 3,
    escalated: 1,
    overridden: 0,
    expired: 0,
    human_overrides: 2,
    deciles: [0, 0, 0, 0, 0, 0, 0, 3, 4, 3],
    confidence_sum: dec(8.5),
    confidence_min: dec(0.7),
    confidence_max: dec(0.98),
    latency_count: 10,
    latency_sum_ms: 12_000,
    latency_p50_ms: 1100,
    latency_p95_ms: 2400,
    latency_max_ms: 3000,
    prompt_tokens: 5000,
    completion_tokens: 900,
    ...over,
  };
}

function metricRow(over: Partial<ai_quality_metrics> = {}): ai_quality_metrics {
  return {
    id: 'row',
    business_id: BIZ_A,
    channel: ChannelType.WHATSAPP,
    bucket: AiQualityBucket.HOUR,
    bucket_start: new Date('2026-08-15T12:00:00Z'),
    decisions: 10,
    auto_executed: 6,
    sent_for_review: 3,
    escalated: 1,
    overridden: 0,
    expired: 0,
    human_overrides: 2,
    confidence_deciles: [0, 0, 0, 0, 0, 0, 0, 3, 4, 3],
    confidence_sum: dec(8.5),
    confidence_min: dec(0.7),
    confidence_max: dec(0.98),
    latency_count: 10,
    latency_sum_ms: 12_000,
    latency_p50_ms: 1100,
    latency_p95_ms: 2400,
    latency_max_ms: 3000,
    prompt_tokens: 5000,
    completion_tokens: 900,
    computed_at: NOW,
    created_at: NOW,
    ...over,
  } as ai_quality_metrics;
}

type RepoMock = {
  aggregateWindow: jest.Mock;
  upsertBucket: jest.Mock;
  upsertBucketBatch: jest.Mock;
  latestComputedBucketStart: jest.Mock;
  listMetrics: jest.Mock;
  deleteFrom: jest.Mock;
};

describe('AiQualityService', () => {
  let repo: RepoMock;
  let service: AiQualityService;

  beforeEach(() => {
    repo = {
      aggregateWindow: jest.fn().mockResolvedValue([]),
      upsertBucket: jest.fn().mockResolvedValue(metricRow()),
      upsertBucketBatch: jest.fn().mockImplementation(
        async (_bucket: unknown, _start: unknown, groups: RollupGroup[]) => groups.length,
      ),
      latestComputedBucketStart: jest.fn().mockResolvedValue(null),
      listMetrics: jest.fn().mockResolvedValue([]),
      deleteFrom: jest.fn().mockResolvedValue(0),
    };
    service = new AiQualityService(repo as never);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // ── Rollup ──────────────────────────────────────────────────────────────────

  describe('runRollup', () => {
    it('never aggregates the bucket that is still open', async () => {
      repo.latestComputedBucketStart.mockResolvedValue(
        new Date('2026-08-15T11:00:00Z'),
      );

      await service.runRollup(NOW);

      const hourWindows = repo.aggregateWindow.mock.calls.map(
        ([from, to]: [Date, Date]) => [from.toISOString(), to.toISOString()],
      );
      // 13:00 is the open bucket at 13:47; it must not appear as a `from`.
      expect(hourWindows).toContainEqual([
        '2026-08-15T12:00:00.000Z',
        '2026-08-15T13:00:00.000Z',
      ]);
      expect(hourWindows.some(([from]) => from === '2026-08-15T13:00:00.000Z')).toBe(
        false,
      );
    });

    it('writes each group under its own business, not a shared tenant', async () => {
      repo.latestComputedBucketStart.mockResolvedValue(
        new Date('2026-08-15T11:00:00Z'),
      );
      repo.aggregateWindow.mockResolvedValue([
        group({ business_id: BIZ_A }),
        group({ business_id: BIZ_B, channel: ChannelType.EMAIL }),
      ]);

      const summary = await service.runRollup(NOW);

      const batchCalls = repo.upsertBucketBatch.mock.calls;
      const allGroups = batchCalls.flatMap(
        ([, , groups]: [unknown, unknown, RollupGroup[]]) => groups,
      );
      const bizIds = new Set(allGroups.map((g) => g.business_id));
      expect(bizIds).toEqual(new Set([BIZ_A, BIZ_B]));

      const hour = summary.results.find((r) => r.bucket === AiQualityBucket.HOUR)!;
      expect(hour.businesses).toBe(2);
      expect(hour.rowsWritten).toBe(2);
    });

    it('rolls up both granularities', async () => {
      await service.runRollup(NOW);
      expect(repo.latestComputedBucketStart).toHaveBeenCalledWith(AiQualityBucket.HOUR);
      expect(repo.latestComputedBucketStart).toHaveBeenCalledWith(AiQualityBucket.DAY);
      expect(service).toBeDefined();
    });

    it('catches up over a gap instead of skipping to the present', async () => {
      repo.latestComputedBucketStart.mockImplementation(
        async (bucket: AiQualityBucket) =>
          bucket === AiQualityBucket.HOUR
            ? new Date('2026-08-15T08:00:00Z')
            : new Date('2026-08-14T00:00:00Z'),
      );

      const summary = await service.runRollup(NOW);

      const hour = summary.results.find((r) => r.bucket === AiQualityBucket.HOUR)!;
      // 09:00 through 12:00 inclusive.
      expect(hour.bucketsComputed).toBe(4);
      expect(hour.pending).toBe(false);
    });

    it('flags pending when the gap is larger than one run may compute', async () => {
      const longAgo = new Date(
        NOW.getTime() - (AI_QUALITY_MAX_BUCKETS_PER_RUN + 10) * 3_600_000,
      );
      repo.latestComputedBucketStart.mockResolvedValue(longAgo);

      const summary = await service.runRollup(NOW);
      const hour = summary.results.find((r) => r.bucket === AiQualityBucket.HOUR)!;

      expect(hour.bucketsComputed).toBe(AI_QUALITY_MAX_BUCKETS_PER_RUN);
      expect(hour.pending).toBe(true);
    });

    it('stops at the deadline and reports pending rather than running long', async () => {
      repo.latestComputedBucketStart.mockResolvedValue(
        new Date('2026-08-15T04:00:00Z'),
      );
      // A deadline already in the past: the first bucket check trips it.
      const summary = await service.runRollup(NOW, Date.now() - 1);

      const hour = summary.results.find((r) => r.bucket === AiQualityBucket.HOUR)!;
      expect(hour.bucketsComputed).toBe(0);
      expect(hour.pending).toBe(true);
      expect(repo.aggregateWindow).not.toHaveBeenCalled();
    });

    it('does not flag pending on a cold table', async () => {
      // Nothing computed yet is not a backlog: there is no earlier data to have
      // missed, so a cold start must not permanently report itself as behind.
      repo.latestComputedBucketStart.mockResolvedValue(null);
      const summary = await service.runRollup(NOW);
      expect(summary.results.every((r) => r.pending)).toBe(false);
    });
  });

  // ── Recompute ───────────────────────────────────────────────────────────────

  describe('recompute', () => {
    it('deletes before rebuilding so an emptied bucket disappears', async () => {
      const order: string[] = [];
      repo.deleteFrom.mockImplementation(async () => {
        order.push('delete');
        return 2;
      });
      repo.aggregateWindow.mockImplementation(async () => {
        order.push('aggregate');
        return [];
      });

      await service.recompute(
        BIZ_A,
        { from: '2026-08-15T11:00:00Z', bucket: AiQualityBucket.HOUR },
        NOW,
      );

      expect(order[0]).toBe('delete');
      expect(order).toContain('aggregate');
    });

    it('ignores groups belonging to other tenants', async () => {
      repo.aggregateWindow.mockResolvedValue([
        group({ business_id: BIZ_A }),
        group({ business_id: BIZ_B }),
      ]);

      const result = await service.recompute(
        BIZ_A,
        { from: '2026-08-15T12:00:00Z', bucket: AiQualityBucket.HOUR },
        NOW,
      );

      expect(result.written).toBe(1);
      const batchGroups = repo.upsertBucketBatch.mock.calls.flatMap(
        ([, , groups]: [unknown, unknown, RollupGroup[]]) => groups,
      );
      for (const g of batchGroups) {
        expect(g.business_id).toBe(BIZ_A);
      }
    });

    it('stops at the newest closed bucket', async () => {
      repo.aggregateWindow.mockResolvedValue([]);
      await service.recompute(
        BIZ_A,
        { from: '2026-08-15T10:00:00Z', bucket: AiQualityBucket.HOUR },
        NOW,
      );
      // 10:00, 11:00, 12:00 — never the open 13:00.
      expect(repo.aggregateWindow).toHaveBeenCalledTimes(3);
    });

    it('rejects a window that reaches further back than the cap', async () => {
      const tooOld = new Date(NOW.getTime() - (MAX_QUALITY_WINDOW_DAYS + 1) * 86_400_000);
      await expect(
        service.recompute(BIZ_A, { from: tooOld.toISOString() }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.deleteFrom).not.toHaveBeenCalled();
    });

    it('rejects a future window', async () => {
      await expect(
        service.recompute(
          BIZ_A,
          { from: new Date(NOW.getTime() + 86_400_000).toISOString() },
          NOW,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an unparseable instant rather than deleting on Invalid Date', async () => {
      // `deleteFrom` with an Invalid Date is a `gte: Invalid Date` predicate,
      // which is not a no-op — reject before anything is deleted.
      await expect(
        service.recompute(BIZ_A, { from: 'yesterday' }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.deleteFrom).not.toHaveBeenCalled();
    });
  });

  // ── Read API ────────────────────────────────────────────────────────────────

  describe('getSummary', () => {
    it('computes the rates the dashboard asks for', async () => {
      repo.listMetrics.mockResolvedValue([metricRow()]);

      const summary = await service.getSummary(BIZ_A, {}, NOW);

      expect(summary.overall.decisions).toBe(10);
      expect(summary.overall.autoExecuteRate).toBe(0.6);
      expect(summary.overall.reviewRate).toBe(0.3);
      expect(summary.overall.escalationRate).toBe(0.1);
      expect(summary.overall.overrideRate).toBe(0.2);
      expect(summary.overall.meanConfidence).toBe(0.85);
      expect(summary.overall.channel).toBeNull();
    });

    it('splits by channel and sums the cross-channel totals', async () => {
      repo.listMetrics.mockResolvedValue([
        metricRow({ channel: ChannelType.WHATSAPP, decisions: 10, auto_executed: 6 }),
        metricRow({
          channel: ChannelType.EMAIL,
          decisions: 5,
          auto_executed: 1,
          sent_for_review: 4,
          escalated: 0,
          human_overrides: 0,
          latency_count: 5,
          latency_sum_ms: 20_000,
          latency_max_ms: 6000,
        }),
      ]);

      const summary = await service.getSummary(BIZ_A, {}, NOW);

      expect(summary.overall.decisions).toBe(15);
      expect(summary.overall.autoExecuteRate).toBe(round(7 / 15));
      expect(summary.byChannel.map((c) => c.channel)).toEqual([
        ChannelType.WHATSAPP,
        ChannelType.EMAIL,
      ]);

      const email = summary.byChannel.find((c) => c.channel === ChannelType.EMAIL)!;
      // Response time by channel: 20s over 5 decisions, not the blended figure.
      expect(email.latency.meanMs).toBe(4000);
      expect(email.latency.maxMs).toBe(6000);

      const whatsapp = summary.byChannel.find(
        (c) => c.channel === ChannelType.WHATSAPP,
      )!;
      expect(whatsapp.latency.meanMs).toBe(1200);
    });

    it('sums the confidence histogram element-wise', async () => {
      repo.listMetrics.mockResolvedValue([
        metricRow({ confidence_deciles: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }),
        metricRow({
          channel: ChannelType.SMS,
          confidence_deciles: [2, 0, 0, 0, 0, 0, 0, 0, 0, 5],
        }),
      ]);

      const summary = await service.getSummary(BIZ_A, {}, NOW);
      expect(summary.overall.confidenceDeciles).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    });

    it('survives a histogram written by a different version of the schema', async () => {
      repo.listMetrics.mockResolvedValue([
        metricRow({ confidence_deciles: [1, 2] as never }),
        metricRow({ channel: ChannelType.SMS, confidence_deciles: 'nonsense' as never }),
      ]);

      const summary = await service.getSummary(BIZ_A, {}, NOW);
      expect(summary.overall.confidenceDeciles).toEqual([1, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('reports percentiles as exact only when one bucket contributed', async () => {
      repo.listMetrics.mockResolvedValue([metricRow()]);
      const single = await service.getSummary(BIZ_A, {}, NOW);
      expect(single.overall.latency.percentilesExact).toBe(true);
      expect(single.overall.latency.p95Ms).toBe(2400);

      repo.listMetrics.mockResolvedValue([
        metricRow({ bucket_start: new Date('2026-08-15T11:00:00Z') }),
        metricRow({
          bucket_start: new Date('2026-08-15T12:00:00Z'),
          latency_p95_ms: 9000,
        }),
      ]);
      const multi = await service.getSummary(BIZ_A, {}, NOW);
      expect(multi.overall.latency.percentilesExact).toBe(false);
      // Worst bucket, i.e. an upper bound — never a recombined "percentile".
      expect(multi.overall.latency.p95Ms).toBe(9000);
    });

    it('counts distinct buckets, not rows, when judging exactness', async () => {
      // Two channels in one bucket is still one bucket.
      repo.listMetrics.mockResolvedValue([
        metricRow({ channel: ChannelType.WHATSAPP }),
        metricRow({ channel: ChannelType.EMAIL }),
      ]);
      const summary = await service.getSummary(BIZ_A, {}, NOW);
      expect(summary.overall.latency.percentilesExact).toBe(true);
    });

    it('returns a series ordered oldest-first with one point per bucket', async () => {
      repo.listMetrics.mockResolvedValue([
        metricRow({
          bucket_start: new Date('2026-08-15T12:00:00Z'),
          channel: ChannelType.EMAIL,
        }),
        metricRow({ bucket_start: new Date('2026-08-15T11:00:00Z') }),
        metricRow({
          bucket_start: new Date('2026-08-15T12:00:00Z'),
          channel: ChannelType.WHATSAPP,
        }),
      ]);

      const summary = await service.getSummary(BIZ_A, {}, NOW);

      expect(summary.series.map((p) => p.bucketStart)).toEqual([
        '2026-08-15T11:00:00.000Z',
        '2026-08-15T12:00:00.000Z',
      ]);
      // The 12:00 point merges both channels.
      expect(summary.series[1]!.decisions).toBe(20);
    });

    it('scopes the read to the caller tenant', async () => {
      await service.getSummary(BIZ_A, {}, NOW);
      expect(repo.listMetrics).toHaveBeenCalledWith(BIZ_A, expect.anything());
    });

    it('defaults to a week ending now', async () => {
      await service.getSummary(BIZ_A, {}, NOW);
      const [, query] = repo.listMetrics.mock.calls[0]!;
      expect(query.to.toISOString()).toBe(NOW.toISOString());
      expect(query.from.toISOString()).toBe('2026-08-08T13:47:00.000Z');
      expect(query.bucket).toBe(AiQualityBucket.HOUR);
    });

    it('passes a channel filter through instead of filtering in memory', async () => {
      await service.getSummary(BIZ_A, { channel: ChannelType.SMS }, NOW);
      const [, query] = repo.listMetrics.mock.calls[0]!;
      expect(query.channel).toBe(ChannelType.SMS);
    });

    it('rejects an inverted window', async () => {
      await expect(
        service.getSummary(
          BIZ_A,
          { from: '2026-08-15T00:00:00Z', to: '2026-08-14T00:00:00Z' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a window wider than the cap', async () => {
      await expect(
        service.getSummary(
          BIZ_A,
          { from: '2020-01-01T00:00:00Z', to: '2026-08-15T00:00:00Z' },
          NOW,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.listMetrics).not.toHaveBeenCalled();
    });

    it('rejects an unparseable date rather than querying on Invalid Date', async () => {
      await expect(
        service.getSummary(BIZ_A, { from: 'last tuesday' }, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns zeroed rates rather than NaN for a tenant with no decisions', async () => {
      repo.listMetrics.mockResolvedValue([]);
      const summary = await service.getSummary(BIZ_A, {}, NOW);

      expect(summary.overall.decisions).toBe(0);
      expect(summary.overall.autoExecuteRate).toBe(0);
      expect(summary.overall.meanConfidence).toBe(0);
      expect(summary.overall.latency.meanMs).toBe(0);
      expect(summary.byChannel).toEqual([]);
      expect(summary.series).toEqual([]);
    });
  });
});

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
