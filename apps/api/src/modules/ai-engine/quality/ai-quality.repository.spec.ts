/**
 * AiQualityRepository unit tests.
 *
 * The rollup aggregate is raw SQL, so what is asserted here is the shape of the
 * statement (the things that cannot be expressed in Prisma and are therefore
 * easy to lose in a refactor) and the upsert key, which is the only thing
 * standing between a re-run and a duplicated bucket.
 */

import { AiQualityBucket, ChannelType } from '@prisma/client';
import { AiQualityRepository, emptyDeciles } from './ai-quality.repository';
import { CONFIDENCE_DECILES } from './ai-quality.constants';

const BIZ = '00000000-0000-4000-a000-00000000000a';

function rawRow(over: Record<string, unknown> = {}) {
  return {
    business_id: BIZ,
    channel: ChannelType.WHATSAPP,
    decisions: 3,
    auto_executed: 2,
    sent_for_review: 1,
    escalated: 0,
    overridden: 0,
    expired: 0,
    human_overrides: 1,
    d0: 0,
    d1: 0,
    d2: 0,
    d3: 0,
    d4: 0,
    d5: 0,
    d6: 0,
    d7: 1,
    d8: 1,
    d9: 1,
    confidence_sum: 2.5,
    confidence_min: 0.7,
    confidence_max: 0.95,
    latency_count: 3,
    latency_sum_ms: 900,
    latency_p50_ms: 300,
    latency_p95_ms: 400,
    latency_max_ms: 400,
    prompt_tokens: 100,
    completion_tokens: 20,
    ...over,
  };
}

describe('AiQualityRepository', () => {
  describe('aggregateWindow', () => {
    /** Joins the tagged-template fragments so the statement is readable. */
    function capturedSql(calls: unknown[][]): string {
      const [fragments] = calls[0] as [TemplateStringsArray];
      return [...fragments].join(' ? ');
    }

    it('asks Postgres for the things Prisma cannot express', async () => {
      const $queryRaw = jest.fn().mockResolvedValue([]);
      const repo = new AiQualityRepository({ $queryRaw } as never);

      await repo.aggregateWindow(
        new Date('2026-08-15T12:00:00Z'),
        new Date('2026-08-15T13:00:00Z'),
      );

      const sql = capturedSql($queryRaw.mock.calls);
      // Exact percentiles — the reason this is raw SQL at all.
      expect(sql).toContain('percentile_disc(0.5)');
      expect(sql).toContain('percentile_disc(0.95)');
      // The channel, which lives on the conversation and not on the decision.
      expect(sql).toContain('JOIN conversations');
      expect(sql).toContain('c.channel');
      // One pass for the whole histogram rather than ten queries.
      expect(sql).toContain('FILTER (WHERE d.confidence_score');
      // Grouped per tenant, since this is the one query that spans them.
      expect(sql).toContain('GROUP BY d.business_id, c.channel');
    });

    it('bounds the window half-open so adjacent buckets cannot double-count', async () => {
      const $queryRaw = jest.fn().mockResolvedValue([]);
      const repo = new AiQualityRepository({ $queryRaw } as never);

      await repo.aggregateWindow(
        new Date('2026-08-15T12:00:00Z'),
        new Date('2026-08-15T13:00:00Z'),
      );

      const sql = capturedSql($queryRaw.mock.calls);
      // `>= from AND < to`: a decision at exactly 13:00:00.000 belongs to the
      // 13:00 bucket only. `<=` would put it in both.
      expect(sql).toContain('d.decided_at >=');
      expect(sql).toContain('d.decided_at <');
      expect(sql).not.toContain('d.decided_at <=');
    });

    it('folds the ten decile columns into an ordered array', async () => {
      const $queryRaw = jest.fn().mockResolvedValue([rawRow()]);
      const repo = new AiQualityRepository({ $queryRaw } as never);

      const [group] = await repo.aggregateWindow(new Date(0), new Date(1));

      expect(group!.deciles).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 1]);
      expect(group!.deciles).toHaveLength(CONFIDENCE_DECILES);
      expect(group!.business_id).toBe(BIZ);
    });
  });

  describe('upsertBucket', () => {
    it('keys on the full bucket identity so a re-run overwrites', async () => {
      const upsert = jest.fn().mockResolvedValue({});
      const repo = new AiQualityRepository({
        ai_quality_metrics: { upsert },
      } as never);

      await repo.upsertBucket(
        BIZ,
        AiQualityBucket.HOUR,
        new Date('2026-08-15T12:00:00Z'),
        {
          business_id: BIZ,
          channel: ChannelType.EMAIL,
          decisions: 1,
          auto_executed: 1,
          sent_for_review: 0,
          escalated: 0,
          overridden: 0,
          expired: 0,
          human_overrides: 0,
          deciles: emptyDeciles(),
          confidence_sum: 0.9 as never,
          confidence_min: 0.9 as never,
          confidence_max: 0.9 as never,
          latency_count: 1,
          latency_sum_ms: 100,
          latency_p50_ms: 100,
          latency_p95_ms: 100,
          latency_max_ms: 100,
          prompt_tokens: 1,
          completion_tokens: 1,
        },
      );

      const [args] = upsert.mock.calls[0]!;
      expect(args.where.business_id_bucket_bucket_start_channel).toEqual({
        business_id: BIZ,
        bucket: AiQualityBucket.HOUR,
        bucket_start: new Date('2026-08-15T12:00:00Z'),
        // Taken from the group, not from a caller argument — the channel is a
        // property of the aggregated rows.
        channel: ChannelType.EMAIL,
      });
      // The update path must not rewrite the identity columns.
      expect(args.update.business_id).toBeUndefined();
      expect(args.update.bucket_start).toBeUndefined();
      expect(args.update.channel).toBeUndefined();
    });
  });

  describe('listMetrics / deleteFrom', () => {
    it('scopes reads to the caller tenant and orders oldest-first', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const repo = new AiQualityRepository({
        ai_quality_metrics: { findMany },
      } as never);

      await repo.listMetrics(BIZ, {
        from: new Date('2026-08-01T00:00:00Z'),
        to: new Date('2026-08-15T00:00:00Z'),
        bucket: AiQualityBucket.DAY,
      });

      const [args] = findMany.mock.calls[0]!;
      expect(args.where.business_id).toBe(BIZ);
      expect(args.where.bucket).toBe(AiQualityBucket.DAY);
      expect(args.where.bucket_start).toEqual({
        gte: new Date('2026-08-01T00:00:00Z'),
        lt: new Date('2026-08-15T00:00:00Z'),
      });
      expect(args.orderBy[0]).toEqual({ bucket_start: 'asc' });
    });

    it('omits the channel predicate entirely when no channel is asked for', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const repo = new AiQualityRepository({
        ai_quality_metrics: { findMany },
      } as never);

      await repo.listMetrics(BIZ, {
        from: new Date(0),
        to: new Date(1),
        bucket: AiQualityBucket.HOUR,
      });

      // `channel: undefined` would be harmless in Prisma, but spelling it as an
      // absent key keeps the predicate honest for anyone reading the query log.
      expect('channel' in findMany.mock.calls[0]![0].where).toBe(false);
    });

    it('deletes only the caller tenant, from the cutoff forward', async () => {
      const deleteMany = jest.fn().mockResolvedValue({ count: 4 });
      const repo = new AiQualityRepository({
        ai_quality_metrics: { deleteMany },
      } as never);

      const count = await repo.deleteFrom(
        BIZ,
        AiQualityBucket.HOUR,
        new Date('2026-08-15T00:00:00Z'),
      );

      expect(count).toBe(4);
      const [args] = deleteMany.mock.calls[0]!;
      expect(args.where.business_id).toBe(BIZ);
      expect(args.where.bucket_start).toEqual({
        gte: new Date('2026-08-15T00:00:00Z'),
      });
    });
  });

  describe('emptyDeciles', () => {
    it('is ten zeroes and a fresh array each call', () => {
      const a = emptyDeciles();
      const b = emptyDeciles();
      expect(a).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      a[0] = 9;
      expect(b[0]).toBe(0);
    });
  });
});
