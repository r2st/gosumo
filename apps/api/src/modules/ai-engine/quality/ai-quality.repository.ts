import { Injectable } from '@nestjs/common';
import { Prisma, AiQualityBucket, ChannelType } from '@prisma/client';
import type { ai_quality_metrics } from '@prisma/client';
import { PrismaService } from '../../../common/services/prisma.service';
import { CONFIDENCE_DECILES } from './ai-quality.constants';

/**
 * One (business, channel) group of a rollup window, straight out of Postgres.
 *
 * Every numeric column is cast in SQL — `count(*)` is bigint and `sum()` over
 * an integer column is numeric, and both arrive as `BigInt`/`Decimal` in the
 * driver. Casting at the source rather than converting here means the row is
 * already the shape the upsert wants, and a column that is genuinely absent
 * (no latency recorded) stays `null` instead of becoming a misleading zero.
 */
export interface RollupGroup {
  business_id: string;
  channel: ChannelType;
  decisions: number;
  auto_executed: number;
  sent_for_review: number;
  escalated: number;
  overridden: number;
  expired: number;
  human_overrides: number;
  /** Decile counts d0…d9, in order. */
  deciles: number[];
  confidence_sum: Prisma.Decimal;
  confidence_min: Prisma.Decimal | null;
  confidence_max: Prisma.Decimal | null;
  latency_count: number;
  latency_sum_ms: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_max_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
}

/** The raw row shape before the decile columns are folded into an array. */
interface RawRollupRow extends Omit<RollupGroup, 'deciles'> {
  d0: number;
  d1: number;
  d2: number;
  d3: number;
  d4: number;
  d5: number;
  d6: number;
  d7: number;
  d8: number;
  d9: number;
}

export interface MetricsQuery {
  from: Date;
  to: Date;
  bucket: AiQualityBucket;
  channel?: ChannelType;
}

/**
 * AiQualityRepository — reads `ai_decisions` in aggregate and writes
 * `ai_quality_metrics`.
 *
 * The aggregation is deliberately one raw statement rather than a Prisma
 * `groupBy` plus post-processing. Three of the things the rollup needs cannot
 * be expressed in Prisma at all — `percentile_disc` for exact latency
 * percentiles, `count(*) FILTER (WHERE …)` for the outcome tallies and the
 * confidence histogram in a single pass, and the join to `conversations` that
 * supplies the channel — and doing them in JS would mean streaming every
 * decision row in the window into the API process to count it.
 */
@Injectable()
export class AiQualityRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Rollup source ─────────────────────────────────────────────────────────────

  /**
   * Aggregate every AI decision in `[from, to)`, grouped by business and the
   * channel of the conversation it belongs to.
   *
   * Cross-tenant by design — it is a scheduled rollup, so no request tenant
   * exists and the question it asks is "which tenants decided anything in this
   * hour". Each returned group carries its own `business_id`, and every write
   * that follows is keyed by it. Registered in `repository-contract.spec.ts`'s
   * GLOBAL_SWEEPS for that reason.
   */
  async aggregateWindow(from: Date, to: Date): Promise<RollupGroup[]> {
    const rows = await this.prisma.$queryRaw<RawRollupRow[]>`
      SELECT
        d.business_id                                                        AS business_id,
        c.channel                                                            AS channel,
        count(*)::int                                                        AS decisions,
        count(*) FILTER (WHERE d.outcome = 'AUTO_EXECUTED')::int             AS auto_executed,
        count(*) FILTER (WHERE d.outcome = 'SENT_FOR_REVIEW')::int           AS sent_for_review,
        count(*) FILTER (WHERE d.outcome = 'ESCALATED')::int                 AS escalated,
        count(*) FILTER (WHERE d.outcome = 'OVERRIDDEN_BY_HUMAN')::int       AS overridden,
        count(*) FILTER (WHERE d.outcome = 'EXPIRED')::int                   AS expired,
        count(*) FILTER (WHERE d.was_overridden)::int                        AS human_overrides,
        count(*) FILTER (WHERE d.confidence_score <  0.1)::int               AS d0,
        count(*) FILTER (WHERE d.confidence_score >= 0.1
                           AND d.confidence_score <  0.2)::int               AS d1,
        count(*) FILTER (WHERE d.confidence_score >= 0.2
                           AND d.confidence_score <  0.3)::int               AS d2,
        count(*) FILTER (WHERE d.confidence_score >= 0.3
                           AND d.confidence_score <  0.4)::int               AS d3,
        count(*) FILTER (WHERE d.confidence_score >= 0.4
                           AND d.confidence_score <  0.5)::int               AS d4,
        count(*) FILTER (WHERE d.confidence_score >= 0.5
                           AND d.confidence_score <  0.6)::int               AS d5,
        count(*) FILTER (WHERE d.confidence_score >= 0.6
                           AND d.confidence_score <  0.7)::int               AS d6,
        count(*) FILTER (WHERE d.confidence_score >= 0.7
                           AND d.confidence_score <  0.8)::int               AS d7,
        count(*) FILTER (WHERE d.confidence_score >= 0.8
                           AND d.confidence_score <  0.9)::int               AS d8,
        count(*) FILTER (WHERE d.confidence_score >= 0.9)::int               AS d9,
        COALESCE(sum(d.confidence_score), 0)                                 AS confidence_sum,
        min(d.confidence_score)                                              AS confidence_min,
        max(d.confidence_score)                                              AS confidence_max,
        count(d.latency_ms)::int                                             AS latency_count,
        COALESCE(sum(d.latency_ms), 0)::int                                  AS latency_sum_ms,
        (percentile_disc(0.5)  WITHIN GROUP (ORDER BY d.latency_ms))::int    AS latency_p50_ms,
        (percentile_disc(0.95) WITHIN GROUP (ORDER BY d.latency_ms))::int    AS latency_p95_ms,
        max(d.latency_ms)::int                                               AS latency_max_ms,
        COALESCE(sum(d.prompt_tokens), 0)::int                               AS prompt_tokens,
        COALESCE(sum(d.completion_tokens), 0)::int                           AS completion_tokens
      FROM ai_decisions d
      JOIN conversations c ON c.id = d.conversation_id
      WHERE d.decided_at >= ${from} AND d.decided_at < ${to}
      GROUP BY d.business_id, c.channel
    `;

    return rows.map((r) => ({
      business_id: r.business_id,
      channel: r.channel,
      decisions: r.decisions,
      auto_executed: r.auto_executed,
      sent_for_review: r.sent_for_review,
      escalated: r.escalated,
      overridden: r.overridden,
      expired: r.expired,
      human_overrides: r.human_overrides,
      deciles: [r.d0, r.d1, r.d2, r.d3, r.d4, r.d5, r.d6, r.d7, r.d8, r.d9],
      confidence_sum: r.confidence_sum,
      confidence_min: r.confidence_min,
      confidence_max: r.confidence_max,
      latency_count: r.latency_count,
      latency_sum_ms: r.latency_sum_ms,
      latency_p50_ms: r.latency_p50_ms,
      latency_p95_ms: r.latency_p95_ms,
      latency_max_ms: r.latency_max_ms,
      prompt_tokens: r.prompt_tokens,
      completion_tokens: r.completion_tokens,
    }));
  }

  // ── Rollup sink ───────────────────────────────────────────────────────────────

  /**
   * Write one bucket row, overwriting whatever was there.
   *
   * Upsert rather than insert because a re-run must be a no-op in effect: the
   * catch-up path and a manual recompute both revisit buckets that already
   * exist, and an insert would either throw or (worse, with skipDuplicates)
   * silently keep a bucket that was computed while its hour was still open.
   */
  async upsertBucket(
    businessId: string,
    bucket: AiQualityBucket,
    bucketStart: Date,
    group: RollupGroup,
    now: Date = new Date(),
  ): Promise<ai_quality_metrics> {
    const values = {
      decisions: group.decisions,
      auto_executed: group.auto_executed,
      sent_for_review: group.sent_for_review,
      escalated: group.escalated,
      overridden: group.overridden,
      expired: group.expired,
      human_overrides: group.human_overrides,
      confidence_deciles: group.deciles as Prisma.InputJsonValue,
      confidence_sum: group.confidence_sum,
      confidence_min: group.confidence_min,
      confidence_max: group.confidence_max,
      latency_count: group.latency_count,
      latency_sum_ms: group.latency_sum_ms,
      latency_p50_ms: group.latency_p50_ms,
      latency_p95_ms: group.latency_p95_ms,
      latency_max_ms: group.latency_max_ms,
      prompt_tokens: group.prompt_tokens,
      completion_tokens: group.completion_tokens,
      computed_at: now,
    };

    return this.prisma.ai_quality_metrics.upsert({
      where: {
        business_id_bucket_bucket_start_channel: {
          business_id: businessId,
          bucket,
          bucket_start: bucketStart,
          channel: group.channel,
        },
      },
      create: {
        business_id: businessId,
        bucket,
        bucket_start: bucketStart,
        channel: group.channel,
        ...values,
      },
      update: values,
    });
  }

  /**
   * The most recent bucket start already computed at this granularity.
   *
   * Cross-tenant: the rollup asks "how far behind am I", which is a property of
   * the job and not of any tenant. Returns a single timestamp and no rows.
   * Registered in GLOBAL_SWEEPS.
   */
  async latestComputedBucketStart(bucket: AiQualityBucket): Promise<Date | null> {
    const row = await this.prisma.ai_quality_metrics.findFirst({
      where: { bucket },
      orderBy: { bucket_start: 'desc' },
      select: { bucket_start: true },
    });
    return row?.bucket_start ?? null;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────────

  /** Every bucket row for a tenant in `[from, to)`, oldest first. */
  async listMetrics(
    businessId: string,
    query: MetricsQuery,
  ): Promise<ai_quality_metrics[]> {
    return this.prisma.ai_quality_metrics.findMany({
      where: {
        business_id: businessId,
        bucket: query.bucket,
        bucket_start: { gte: query.from, lt: query.to },
        ...(query.channel ? { channel: query.channel } : {}),
      },
      orderBy: [{ bucket_start: 'asc' }, { channel: 'asc' }],
    });
  }

  /**
   * Delete every rollup row for a tenant at or after `from`.
   *
   * The recompute path: a bucket whose source data changed (a late override
   * landing against an old decision) is dropped and rebuilt rather than
   * patched, because the counts are not incrementally derivable from the row.
   */
  async deleteFrom(
    businessId: string,
    bucket: AiQualityBucket,
    from: Date,
  ): Promise<number> {
    const { count } = await this.prisma.ai_quality_metrics.deleteMany({
      where: {
        business_id: businessId,
        bucket,
        bucket_start: { gte: from },
      },
    });
    return count;
  }
}

/** An all-zero decile histogram — the shape every row's array must have. */
export function emptyDeciles(): number[] {
  return new Array<number>(CONFIDENCE_DECILES).fill(0);
}
