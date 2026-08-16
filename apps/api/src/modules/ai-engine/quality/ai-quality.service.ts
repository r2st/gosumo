import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AiQualityBucket, ChannelType } from '@prisma/client';
import type { ai_quality_metrics } from '@prisma/client';
import {
  AiQualityRepository,
  RollupGroup,
  emptyDeciles,
} from './ai-quality.repository';
import {
  AI_QUALITY_MAX_BUCKETS_PER_RUN,
  AI_QUALITY_RUN_BUDGET_MS,
  CONFIDENCE_DECILES,
  DEFAULT_QUALITY_WINDOW_DAYS,
  MAX_QUALITY_WINDOW_DAYS,
} from './ai-quality.constants';
import {
  DAY_MS,
  bucketSizeMs,
  bucketsToCompute,
  floorToBucket,
  latestClosedBucketStart,
  rate,
  round4,
} from './ai-quality.util';
import {
  ChannelQualityDto,
  LatencySummaryDto,
  QualityMetricsQueryDto,
  QualityPointDto,
  QualityRecomputeResultDto,
  QualitySummaryDto,
  RecomputeQualityDto,
  RollupResultDto,
  RollupSummaryDto,
} from './dto';

/** Running totals for one channel while a summary is assembled. */
interface Accumulator {
  /** Null on the cross-channel accumulator. */
  channel: ChannelType | null;
  decisions: number;
  autoExecuted: number;
  sentForReview: number;
  escalated: number;
  expired: number;
  overriddenOutcome: number;
  humanOverrides: number;
  confidenceSum: number;
  deciles: number[];
  latencyCount: number;
  latencySumMs: number;
  latencyMaxMs: number;
  /** Largest per-bucket p50/p95 seen, and how many buckets contributed. */
  worstP50Ms: number | null;
  worstP95Ms: number | null;
  bucketsSeen: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * AiQualityService — turns `ai_decisions` into an answerable question.
 *
 * Two responsibilities, deliberately in one place because they share the bucket
 * arithmetic: the scheduled rollup that fills `ai_quality_metrics`, and the read
 * API that reports confidence distribution, routing rates, human-override rate
 * and response time per channel off it.
 *
 * **Late overrides.** `was_overridden` is set on a decision hours after it was
 * decided, so an hour bucket computed at the top of the next hour undercounts
 * overrides against it. The DAY rollup re-aggregates the whole day from source
 * at day close and does not have that problem, which is why override rate
 * should be read at DAY granularity; `recompute` exists for the rest.
 */
@Injectable()
export class AiQualityService {
  private readonly logger = new Logger(AiQualityService.name);

  constructor(private readonly repository: AiQualityRepository) {}

  // ════════════════════════════════════════════
  // Rollup
  // ════════════════════════════════════════════

  /**
   * Compute every closed bucket that has not been computed yet, at both
   * granularities, newest-first-bounded.
   *
   * Runs on a schedule with no request tenant: one aggregate query per bucket
   * spans every business, and each returned group is written under its own
   * `business_id`.
   */
  async runRollup(
    now: Date = new Date(),
    deadline: number = Date.now() + AI_QUALITY_RUN_BUDGET_MS,
  ): Promise<RollupSummaryDto> {
    const results: RollupResultDto[] = [];
    for (const bucket of [AiQualityBucket.HOUR, AiQualityBucket.DAY]) {
      results.push(await this.rollupGranularity(bucket, now, deadline));
    }
    return { results };
  }

  private async rollupGranularity(
    bucket: AiQualityBucket,
    now: Date,
    deadline: number,
  ): Promise<RollupResultDto> {
    const latestClosed = latestClosedBucketStart(now, bucket);
    const lastComputed = await this.repository.latestComputedBucketStart(bucket);
    const due = bucketsToCompute(
      lastComputed,
      latestClosed,
      bucket,
      AI_QUALITY_MAX_BUCKETS_PER_RUN,
    );

    // The cap kept only the newest buckets; anything older stays uncomputed.
    let pending =
      lastComputed !== null &&
      due.length > 0 &&
      due[0]!.getTime() > lastComputed.getTime() + bucketSizeMs(bucket);

    const size = bucketSizeMs(bucket);
    const businesses = new Set<string>();
    let rowsWritten = 0;
    let bucketsComputed = 0;

    for (const bucketStart of due) {
      if (Date.now() >= deadline) {
        // Out of budget mid-catch-up. Say so rather than let the next run
        // infer "nothing to do" from a `lastComputed` that moved.
        pending = true;
        break;
      }

      const to = new Date(bucketStart.getTime() + size);
      const groups = await this.repository.aggregateWindow(bucketStart, to);
      for (const group of groups) {
        await this.repository.upsertBucket(
          group.business_id,
          bucket,
          bucketStart,
          group,
          now,
        );
        businesses.add(group.business_id);
        rowsWritten += 1;
      }
      bucketsComputed += 1;
    }

    if (bucketsComputed > 0) {
      this.logger.log(
        `AI quality rollup (${bucket}): ${bucketsComputed} bucket(s), ` +
          `${rowsWritten} row(s) across ${businesses.size} business(es)`,
      );
    }
    if (pending) {
      this.logger.warn(
        `AI quality rollup (${bucket}) did not reach the present — closed buckets ` +
          `remain uncomputed. They will be picked up next tick.`,
      );
    }

    return {
      bucket,
      bucketsComputed,
      rowsWritten,
      businesses: businesses.size,
      pending,
    };
  }

  /**
   * Drop and rebuild one tenant's buckets from `from` onwards.
   *
   * The escape hatch for a bucket whose source data changed after it was
   * computed — the late-override case above, or a backfill. It deletes first
   * because the counts are not incrementally derivable: a bucket that now has
   * no decisions at all must disappear, and an upsert alone would leave the
   * stale row behind.
   *
   * Only closed buckets are rebuilt; the current one is left alone so a
   * recompute cannot freeze a partial count.
   */
  async recompute(
    businessId: string,
    dto: RecomputeQualityDto,
    now: Date = new Date(),
  ): Promise<QualityRecomputeResultDto> {
    const bucket = dto.bucket ?? AiQualityBucket.HOUR;
    const from = new Date(dto.from);
    if (Number.isNaN(from.getTime())) {
      throw new BadRequestException('`from` is not a valid date');
    }

    const oldest = new Date(now.getTime() - MAX_QUALITY_WINDOW_DAYS * DAY_MS);
    if (from < oldest) {
      throw new BadRequestException(
        `Cannot recompute further back than ${MAX_QUALITY_WINDOW_DAYS} days`,
      );
    }
    if (from > now) {
      throw new BadRequestException('Recompute window starts in the future');
    }

    const size = bucketSizeMs(bucket);
    const start = floorToBucket(from, bucket);
    const latestClosed = latestClosedBucketStart(now, bucket);

    const deleted = await this.repository.deleteFrom(businessId, bucket, start);

    let written = 0;
    let buckets = 0;
    for (let t = start.getTime(); t <= latestClosed.getTime(); t += size) {
      const bucketStart = new Date(t);
      const groups = await this.repository.aggregateWindow(
        bucketStart,
        new Date(t + size),
      );
      for (const group of groups) {
        // The aggregate spans tenants; this path rebuilds one of them.
        if (group.business_id !== businessId) continue;
        await this.repository.upsertBucket(
          businessId,
          bucket,
          bucketStart,
          group,
          now,
        );
        written += 1;
      }
      buckets += 1;
    }

    this.logger.log(
      `AI quality recompute for business ${businessId}: ${buckets} bucket(s), ` +
        `${deleted} deleted, ${written} rewritten`,
    );

    return { deleted, written, buckets };
  }

  // ════════════════════════════════════════════
  // Read API
  // ════════════════════════════════════════════

  /**
   * Confidence distribution, routing rates, override rate and latency for one
   * tenant, overall and split by channel, plus a time series.
   */
  async getSummary(
    businessId: string,
    query: QualityMetricsQueryDto,
    now: Date = new Date(),
  ): Promise<QualitySummaryDto> {
    const bucket = query.bucket ?? AiQualityBucket.HOUR;
    const { from, to } = this.resolveWindow(query, now);

    const rows = await this.repository.listMetrics(businessId, {
      from,
      to,
      bucket,
      channel: query.channel,
    });

    const perChannel = new Map<ChannelType, Accumulator>();
    const overall = this.newAccumulator(null);
    const overallBuckets = new Set<number>();
    const series = new Map<number, Accumulator>();

    for (const row of rows) {
      const acc =
        perChannel.get(row.channel) ??
        perChannel.set(row.channel, this.newAccumulator(row.channel)).get(row.channel)!;
      this.absorb(acc, row);
      this.absorb(overall, row);
      overallBuckets.add(row.bucket_start.getTime());

      const t = row.bucket_start.getTime();
      const point = series.get(t) ?? series.set(t, this.newAccumulator(null)).get(t)!;
      this.absorb(point, row);
    }

    // `bucketsSeen` counts rows, and one bucket contributes one row per
    // channel. The percentile-exactness test is about distinct *buckets*.
    overall.bucketsSeen = overallBuckets.size;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      overall: this.toDto(overall),
      byChannel: [...perChannel.values()]
        .map((a) => this.toDto(a))
        .sort((a, b) => b.decisions - a.decisions),
      series: [...series.entries()]
        .sort(([a], [b]) => a - b)
        .map(([t, acc]) => this.toPoint(new Date(t), acc)),
    };
  }

  /**
   * Resolve `from`/`to` with the window rules applied: `to` defaults to now,
   * `from` to a week before it, and the span is capped.
   */
  private resolveWindow(
    query: QualityMetricsQueryDto,
    now: Date,
  ): { from: Date; to: Date } {
    const to = query.to ? new Date(query.to) : now;
    if (Number.isNaN(to.getTime())) {
      throw new BadRequestException('`to` is not a valid date');
    }

    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_QUALITY_WINDOW_DAYS * DAY_MS);
    if (Number.isNaN(from.getTime())) {
      throw new BadRequestException('`from` is not a valid date');
    }
    if (from >= to) {
      throw new BadRequestException('`from` must be before `to`');
    }
    if (to.getTime() - from.getTime() > MAX_QUALITY_WINDOW_DAYS * DAY_MS) {
      throw new BadRequestException(
        `Window may not exceed ${MAX_QUALITY_WINDOW_DAYS} days`,
      );
    }

    return { from, to };
  }

  private newAccumulator(channel: ChannelType | null): Accumulator {
    return {
      channel,
      decisions: 0,
      autoExecuted: 0,
      sentForReview: 0,
      escalated: 0,
      expired: 0,
      overriddenOutcome: 0,
      humanOverrides: 0,
      confidenceSum: 0,
      deciles: emptyDeciles(),
      latencyCount: 0,
      latencySumMs: 0,
      latencyMaxMs: 0,
      worstP50Ms: null,
      worstP95Ms: null,
      bucketsSeen: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  /** Fold one stored bucket row into a running total. */
  private absorb(acc: Accumulator, row: ai_quality_metrics): void {
    acc.decisions += row.decisions;
    acc.autoExecuted += row.auto_executed;
    acc.sentForReview += row.sent_for_review;
    acc.escalated += row.escalated;
    acc.expired += row.expired;
    acc.overriddenOutcome += row.overridden;
    acc.humanOverrides += row.human_overrides;
    acc.confidenceSum += Number(row.confidence_sum);
    acc.latencyCount += row.latency_count;
    acc.latencySumMs += row.latency_sum_ms;
    acc.latencyMaxMs = Math.max(acc.latencyMaxMs, row.latency_max_ms ?? 0);
    acc.promptTokens += row.prompt_tokens;
    acc.completionTokens += row.completion_tokens;
    acc.bucketsSeen += 1;

    if (row.latency_p50_ms !== null) {
      acc.worstP50Ms = Math.max(acc.worstP50Ms ?? 0, row.latency_p50_ms);
    }
    if (row.latency_p95_ms !== null) {
      acc.worstP95Ms = Math.max(acc.worstP95Ms ?? 0, row.latency_p95_ms);
    }

    // A row whose histogram is the wrong length is a row written by a different
    // version of this code. Fold what lines up rather than throwing on a read.
    const deciles = Array.isArray(row.confidence_deciles)
      ? (row.confidence_deciles as unknown[])
      : [];
    for (let i = 0; i < CONFIDENCE_DECILES; i += 1) {
      const v = deciles[i];
      if (typeof v === 'number' && Number.isFinite(v)) acc.deciles[i]! += v;
    }
  }

  private latencyOf(acc: Accumulator): LatencySummaryDto {
    return {
      meanMs: Math.round(rate(acc.latencySumMs, acc.latencyCount)),
      maxMs: acc.latencyMaxMs,
      p50Ms: acc.worstP50Ms,
      p95Ms: acc.worstP95Ms,
      percentilesExact: acc.bucketsSeen <= 1,
      sampleCount: acc.latencyCount,
    };
  }

  private toDto(acc: Accumulator): ChannelQualityDto {
    return {
      channel: acc.channel,
      decisions: acc.decisions,
      autoExecuted: acc.autoExecuted,
      sentForReview: acc.sentForReview,
      escalated: acc.escalated,
      expired: acc.expired,
      humanOverrides: acc.humanOverrides,
      autoExecuteRate: round4(rate(acc.autoExecuted, acc.decisions)),
      reviewRate: round4(rate(acc.sentForReview, acc.decisions)),
      escalationRate: round4(rate(acc.escalated, acc.decisions)),
      overrideRate: round4(rate(acc.humanOverrides, acc.decisions)),
      meanConfidence: round4(rate(acc.confidenceSum, acc.decisions)),
      confidenceDeciles: acc.deciles,
      latency: this.latencyOf(acc),
      promptTokens: acc.promptTokens,
      completionTokens: acc.completionTokens,
    };
  }

  private toPoint(bucketStart: Date, acc: Accumulator): QualityPointDto {
    return {
      bucketStart: bucketStart.toISOString(),
      decisions: acc.decisions,
      autoExecuteRate: round4(rate(acc.autoExecuted, acc.decisions)),
      reviewRate: round4(rate(acc.sentForReview, acc.decisions)),
      escalationRate: round4(rate(acc.escalated, acc.decisions)),
      overrideRate: round4(rate(acc.humanOverrides, acc.decisions)),
      meanConfidence: round4(rate(acc.confidenceSum, acc.decisions)),
      meanLatencyMs: Math.round(rate(acc.latencySumMs, acc.latencyCount)),
    };
  }
}

/** Re-exported so tests can build a group without importing the repository. */
export type { RollupGroup };
