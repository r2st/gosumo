import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChannelType } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';
import { Granularity } from './dto';
import { granularityToSqlUnit, BucketRow } from './analytics.util';
import type { CsatProxyGroup } from './conversation-quality.util';

/**
 * A half-open time window: `[from, to)`. `from` is inclusive, `to` exclusive.
 * Every aggregation query filters on this so partitioned tables
 * (`messages`, `analytics_events`) can prune partitions.
 */
export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Order statuses that count toward revenue. DRAFT (never paid), CANCELLED,
 * REFUNDED and RETURNED are excluded; PARTIALLY_REFUNDED still represents
 * captured revenue (the refunded slice is netted out separately).
 */
const REVENUE_ORDER_STATUSES: Prisma.ordersWhereInput['status'] = {
  in: ['CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED', 'PARTIALLY_REFUNDED'],
};

/** Churn-risk threshold (0–1) at/above which a client is HIGH or CRITICAL. */
const AT_RISK_CHURN_THRESHOLD = 0.61;

// ─────────────────────────────────────────────
// Raw-row shapes (all numeric columns cast to int/float8 in SQL so they
// arrive as JS numbers, never BigInt or Prisma.Decimal)
// ─────────────────────────────────────────────

interface BucketValueRaw {
  bucket: Date;
  value: number;
}

interface AutonomyBucketRaw {
  bucket: Date;
  auto: number;
  total: number;
}

interface ResponseTimeRaw {
  sample: number;
  avg_sec: number;
  p50: number;
  p90: number;
}

interface KeyCountRaw {
  key: string;
  count: number;
}

interface ConfidenceBucketRaw {
  bucket: number;
  count: number;
}

interface TopProductRaw {
  item_id: string | null;
  name: string | null;
  units: number;
  revenue: number;
}

interface ConversationQualityRaw {
  resolved_count: number;
  fcr_count: number;
  escalated_count: number;
  avg_sec: number;
  p50: number;
  p90: number;
}

/** Postgres returns the signal booleans nullable; the mapper folds them. */
interface CsatProxyGroupRaw {
  escalated: boolean;
  breached: boolean;
  slow: boolean | null;
  chatty: boolean | null;
  count: number;
}

interface ChannelQualityRaw {
  channel: string;
  created: number;
  resolved: number;
  fcr: number;
  avg_resolution_sec: number;
}

interface StaffRaw {
  id: string;
  name: string;
  role: string;
  assigned: number;
  resolved_conv: number;
  tasks_resolved: number;
  avg_task_sec: number;
}

/**
 * AnalyticsRepository — all read-only Prisma queries for the analytics module.
 *
 * Every query includes `business_id = :businessId`. The module never writes:
 * there is no create/update/delete here by design.
 */
@Injectable()
export class AnalyticsRepository {
  private readonly logger = new Logger(AnalyticsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────────────────────────────────────────────
  // Conversations
  // ───────────────────────────────────────────────────────────────────

  /**
   * Count conversations created in the range, grouped by status, plus the
   * AI-vs-human split of those that ended RESOLVED (a conversation resolved
   * with zero human messages is attributed to the AI).
   */
  async getConversationCounts(
    businessId: string,
    range: DateRange,
  ): Promise<{
    total: number;
    resolved: number;
    open: number;
    pendingHuman: number;
    escalated: number;
    snoozed: number;
    aiResolved: number;
    humanResolved: number;
  }> {
    const createdWhere: Prisma.conversationsWhereInput = {
      business_id: businessId,
      deleted_at: null,
      created_at: { gte: range.from, lt: range.to },
    };

    const [grouped, aiResolved, humanResolved] = await Promise.all([
      this.prisma.conversations.groupBy({
        by: ['status'],
        where: createdWhere,
        _count: { _all: true },
      }),
      this.prisma.conversations.count({
        where: { ...createdWhere, status: 'RESOLVED', human_message_count: { lte: 0 } },
      }),
      this.prisma.conversations.count({
        where: { ...createdWhere, status: 'RESOLVED', human_message_count: { gt: 0 } },
      }),
    ]);

    const byStatus = new Map<string, number>();
    for (const row of grouped) {
      byStatus.set(row.status, row._count._all);
    }

    const get = (s: string): number => byStatus.get(s) ?? 0;
    const total = grouped.reduce((sum, r) => sum + r._count._all, 0);

    return {
      total,
      resolved: get('RESOLVED'),
      open: get('OPEN'),
      pendingHuman: get('PENDING_HUMAN'),
      escalated: get('ESCALATED'),
      snoozed: get('SNOOZED'),
      aiResolved,
      humanResolved,
    };
  }

  /** Conversation volume created in the range, grouped by channel. */
  async getConversationVolumeByChannel(
    businessId: string,
    range: DateRange,
  ): Promise<{ channel: ChannelType; count: number }[]> {
    const grouped = await this.prisma.conversations.groupBy({
      by: ['channel'],
      where: {
        business_id: businessId,
        deleted_at: null,
        created_at: { gte: range.from, lt: range.to },
      },
      _count: { _all: true },
    });

    return grouped.map((r) => ({ channel: r.channel as ChannelType, count: r._count._all }));
  }

  /** Conversation creation volume bucketed by `granularity`. */
  async getConversationVolumeSeries(
    businessId: string,
    range: DateRange,
    granularity: Granularity,
  ): Promise<BucketRow[]> {
    const unit = granularityToSqlUnit(granularity);
    const rows = await this.prisma.$queryRaw<BucketValueRaw[]>`
      SELECT date_trunc(${unit}, created_at) AS bucket,
             COUNT(*)::float8 AS value
      FROM conversations
      WHERE business_id = ${businessId}::uuid
        AND deleted_at IS NULL
        AND created_at >= ${range.from} AND created_at < ${range.to}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ bucket: r.bucket, value: r.value }));
  }

  /** Count conversations currently in an "open-ish" state (not range-scoped). */
  async countOpenConversations(businessId: string): Promise<number> {
    return this.prisma.conversations.count({
      where: {
        business_id: businessId,
        deleted_at: null,
        status: { in: ['OPEN', 'PENDING_HUMAN', 'ESCALATED'] },
      },
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Response times
  // ───────────────────────────────────────────────────────────────────

  /**
   * First-response latency stats: for every conversation with activity in the
   * range, the gap between its first inbound and first outbound message.
   * Returns seconds. Conversations without a qualifying outbound are excluded.
   */
  async getResponseTimeStats(
    businessId: string,
    range: DateRange,
  ): Promise<{ avgSeconds: number; p50Seconds: number; p90Seconds: number; sampleSize: number }> {
    const rows = await this.prisma.$queryRaw<ResponseTimeRaw[]>`
      WITH firsts AS (
        SELECT conversation_id,
               MIN(created_at) FILTER (WHERE direction = 'INBOUND')  AS first_in,
               MIN(created_at) FILTER (WHERE direction = 'OUTBOUND') AS first_out
        FROM messages
        WHERE business_id = ${businessId}::uuid
          AND created_at >= ${range.from} AND created_at < ${range.to}
        GROUP BY conversation_id
      ),
      latencies AS (
        SELECT EXTRACT(EPOCH FROM (first_out - first_in)) AS sec
        FROM firsts
        WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out > first_in
      )
      SELECT COUNT(*)::int AS sample,
             COALESCE(AVG(sec), 0)::float8 AS avg_sec,
             COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY sec), 0)::float8 AS p50,
             COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY sec), 0)::float8 AS p90
      FROM latencies
    `;

    const row = rows[0] ?? { sample: 0, avg_sec: 0, p50: 0, p90: 0 };
    return {
      avgSeconds: row.avg_sec,
      p50Seconds: row.p50,
      p90Seconds: row.p90,
      sampleSize: row.sample,
    };
  }

  /** Average first-response latency (seconds) bucketed by `granularity`. */
  async getResponseTimeSeries(
    businessId: string,
    range: DateRange,
    granularity: Granularity,
  ): Promise<BucketRow[]> {
    const unit = granularityToSqlUnit(granularity);
    const rows = await this.prisma.$queryRaw<BucketValueRaw[]>`
      WITH firsts AS (
        SELECT conversation_id,
               MIN(created_at) FILTER (WHERE direction = 'INBOUND')  AS first_in,
               MIN(created_at) FILTER (WHERE direction = 'OUTBOUND') AS first_out
        FROM messages
        WHERE business_id = ${businessId}::uuid
          AND created_at >= ${range.from} AND created_at < ${range.to}
        GROUP BY conversation_id
      )
      SELECT date_trunc(${unit}, first_in) AS bucket,
             AVG(EXTRACT(EPOCH FROM (first_out - first_in)))::float8 AS value
      FROM firsts
      WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out > first_in
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ bucket: r.bucket, value: r.value }));
  }

  /**
   * Average conversation resolution time (seconds): from first message to
   * resolution, over conversations resolved within the range.
   */
  async getAvgResolutionSeconds(businessId: string, range: DateRange): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ avg_sec: number }[]>`
      SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (resolved_at - first_message_at))), 0)::float8 AS avg_sec
      FROM conversations
      WHERE business_id = ${businessId}::uuid
        AND deleted_at IS NULL
        AND status = 'RESOLVED'
        AND first_message_at IS NOT NULL
        AND resolved_at IS NOT NULL
        AND resolved_at >= ${range.from} AND resolved_at < ${range.to}
    `;
    return rows[0]?.avg_sec ?? 0;
  }

  // ───────────────────────────────────────────────────────────────────
  // Conversation quality
  // ───────────────────────────────────────────────────────────────────

  /**
   * Resolution and first-contact-resolution counts over conversations
   * **resolved** in the range, plus resolution-latency percentiles.
   *
   * Scoped by `resolved_at` and not `created_at`: a conversation opened in
   * March and closed in April belongs to April's resolution figures. Scoping by
   * creation would make the current period's resolution rate permanently
   * understated, since its newest conversations have not had time to close —
   * the classic way a resolution-rate chart trends down while nothing has got
   * worse.
   *
   * FCR is "resolved, the customer sent exactly one message, and no human ever
   * took it over". Both halves are needed: one inbound message with three
   * agents on the thread is not a first-contact resolution, and an escalated
   * thread the customer never had to chase is not one either. `escalated` is
   * read off `ai_decisions` rather than the conversation's *current* status,
   * because status is where a conversation ended, not where it has been.
   */
  async getConversationQualityStats(
    businessId: string,
    range: DateRange,
  ): Promise<{
    resolvedCount: number;
    fcrCount: number;
    escalatedCount: number;
    avgResolutionSeconds: number;
    p50ResolutionSeconds: number;
    p90ResolutionSeconds: number;
  }> {
    const rows = await this.prisma.$queryRaw<ConversationQualityRaw[]>`
      WITH resolved AS (
        SELECT c.id,
               c.human_message_count,
               EXTRACT(EPOCH FROM (c.resolved_at - c.first_message_at)) AS resolution_sec
        FROM conversations c
        WHERE c.business_id = ${businessId}::uuid
          AND c.deleted_at IS NULL
          AND c.status = 'RESOLVED'
          AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}
      ),
      marked AS (
        SELECT r.id,
               r.resolution_sec,
               r.human_message_count,
               EXISTS (
                 SELECT 1 FROM ai_decisions d
                 WHERE d.conversation_id = r.id
                   AND d.business_id = ${businessId}::uuid
                   AND d.outcome = 'ESCALATED'
               ) AS escalated,
               (
                 SELECT COUNT(*) FROM messages m
                 WHERE m.conversation_id = r.id
                   AND m.business_id = ${businessId}::uuid
                   AND m.direction = 'INBOUND'
               ) AS inbound_count
        FROM resolved r
      )
      SELECT COUNT(*)::int AS resolved_count,
             (COUNT(*) FILTER (
                WHERE inbound_count = 1 AND NOT escalated AND human_message_count = 0
             ))::int AS fcr_count,
             (COUNT(*) FILTER (WHERE escalated))::int AS escalated_count,
             COALESCE(AVG(resolution_sec), 0)::float8 AS avg_sec,
             COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY resolution_sec), 0)::float8 AS p50,
             COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY resolution_sec), 0)::float8 AS p90
      FROM marked
    `;

    const row = rows[0];
    return {
      resolvedCount: row?.resolved_count ?? 0,
      fcrCount: row?.fcr_count ?? 0,
      escalatedCount: row?.escalated_count ?? 0,
      avgResolutionSeconds: row?.avg_sec ?? 0,
      p50ResolutionSeconds: row?.p50 ?? 0,
      p90ResolutionSeconds: row?.p90 ?? 0,
    };
  }

  /**
   * The two inputs to the CSAT summary: explicit ratings by value, and the
   * distinct signal combinations among unrated resolved conversations.
   *
   * The second half groups by the four booleans rather than returning one row
   * per conversation. There are at most sixteen combinations, so this is a
   * bounded result whatever the tenant's volume — and the scoring policy stays
   * out of SQL, in `conversation-quality.util.ts`, where it can be read and
   * changed without a migration.
   *
   * The two sets are disjoint by construction (`csat_score IS NULL` /
   * `IS NOT NULL`), so no conversation is counted twice when they are pooled.
   */
  async getCsatSignals(
    businessId: string,
    range: DateRange,
    slowHours: number,
    chattyInbound: number,
  ): Promise<{
    explicit: { score: number; count: number }[];
    proxyGroups: CsatProxyGroup[];
  }> {
    const [explicit, proxy] = await Promise.all([
      this.prisma.$queryRaw<{ score: number; count: number }[]>`
        SELECT csat_score::int AS score, COUNT(*)::int AS count
        FROM conversations
        WHERE business_id = ${businessId}::uuid
          AND deleted_at IS NULL
          AND status = 'RESOLVED'
          AND resolved_at >= ${range.from} AND resolved_at < ${range.to}
          AND csat_score IS NOT NULL
        GROUP BY 1
        ORDER BY 1
      `,
      this.prisma.$queryRaw<CsatProxyGroupRaw[]>`
        WITH resolved AS (
          SELECT c.id,
                 c.human_message_count,
                 (c.resolved_at - c.first_message_at) > (${slowHours}::int * INTERVAL '1 hour') AS slow
          FROM conversations c
          WHERE c.business_id = ${businessId}::uuid
            AND c.deleted_at IS NULL
            AND c.status = 'RESOLVED'
            AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}
            AND c.csat_score IS NULL
        )
        SELECT EXISTS (
                 SELECT 1 FROM ai_decisions d
                 WHERE d.conversation_id = r.id
                   AND d.business_id = ${businessId}::uuid
                   AND d.outcome = 'ESCALATED'
               ) AS escalated,
               EXISTS (
                 SELECT 1 FROM sla_breaches b
                 WHERE b.conversation_id = r.id
                   AND b.business_id = ${businessId}::uuid
               ) AS breached,
               COALESCE(r.slow, FALSE) AS slow,
               (
                 SELECT COUNT(*) FROM messages m
                 WHERE m.conversation_id = r.id
                   AND m.business_id = ${businessId}::uuid
                   AND m.direction = 'INBOUND'
               ) > ${chattyInbound}::int AS chatty,
               COUNT(*)::int AS count
        FROM resolved r
        GROUP BY 1, 2, 3, 4
      `,
    ]);

    return {
      explicit,
      proxyGroups: proxy.map((r) => ({
        escalated: r.escalated,
        breached: r.breached,
        // `resolved_at - first_message_at` is null when a conversation has no
        // first message recorded, and NULL > interval is NULL — folded to false
        // here so an incomplete row is "not slow" rather than dropped from the
        // group set entirely.
        slow: r.slow ?? false,
        chatty: r.chatty ?? false,
        count: r.count,
      })),
    };
  }

  /**
   * Per-channel volume, resolution and first-response latency in one pass.
   *
   * Created and resolved counts come from different windows on purpose — see
   * {@link getConversationQualityStats} — so a channel's `resolutionRate` is
   * "how many did we close" against "how many did we open", not a cohort rate.
   */
  async getConversationQualityByChannel(
    businessId: string,
    range: DateRange,
  ): Promise<
    {
      channel: ChannelType;
      created: number;
      resolved: number;
      fcr: number;
      avgResolutionSeconds: number;
    }[]
  > {
    const rows = await this.prisma.$queryRaw<ChannelQualityRaw[]>`
      WITH created AS (
        SELECT channel, COUNT(*)::int AS created
        FROM conversations
        WHERE business_id = ${businessId}::uuid
          AND deleted_at IS NULL
          AND created_at >= ${range.from} AND created_at < ${range.to}
        GROUP BY 1
      ),
      closed AS (
        SELECT c.channel,
               COUNT(*)::int AS resolved,
               (COUNT(*) FILTER (
                  WHERE c.human_message_count = 0
                    AND (
                      SELECT COUNT(*) FROM messages m
                      WHERE m.conversation_id = c.id
                        AND m.business_id = ${businessId}::uuid
                        AND m.direction = 'INBOUND'
                    ) = 1
               ))::int AS fcr,
               COALESCE(AVG(EXTRACT(EPOCH FROM (c.resolved_at - c.first_message_at))), 0)::float8
                 AS avg_resolution_sec
        FROM conversations c
        WHERE c.business_id = ${businessId}::uuid
          AND c.deleted_at IS NULL
          AND c.status = 'RESOLVED'
          AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}
        GROUP BY 1
      )
      SELECT COALESCE(created.channel, closed.channel) AS channel,
             COALESCE(created.created, 0)              AS created,
             COALESCE(closed.resolved, 0)              AS resolved,
             COALESCE(closed.fcr, 0)                   AS fcr,
             COALESCE(closed.avg_resolution_sec, 0)    AS avg_resolution_sec
      FROM created
      FULL OUTER JOIN closed ON created.channel = closed.channel
      ORDER BY 2 DESC
    `;

    return rows.map((r) => ({
      channel: r.channel as ChannelType,
      created: r.created,
      resolved: r.resolved,
      fcr: r.fcr,
      avgResolutionSeconds: r.avg_resolution_sec,
    }));
  }

  // ───────────────────────────────────────────────────────────────────
  // AI decisions
  // ───────────────────────────────────────────────────────────────────

  /** AI decision counts grouped by outcome, plus the override count. */
  async getAiDecisionCounts(
    businessId: string,
    range: DateRange,
  ): Promise<{
    total: number;
    autoExecuted: number;
    sentForReview: number;
    escalated: number;
    overriddenByHuman: number;
    expired: number;
    overridden: number;
  }> {
    const where: Prisma.ai_decisionsWhereInput = {
      business_id: businessId,
      decided_at: { gte: range.from, lt: range.to },
    };

    const [grouped, overridden] = await Promise.all([
      this.prisma.ai_decisions.groupBy({
        by: ['outcome'],
        where,
        _count: { _all: true },
      }),
      this.prisma.ai_decisions.count({ where: { ...where, was_overridden: true } }),
    ]);

    const byOutcome = new Map<string, number>();
    for (const row of grouped) {
      byOutcome.set(row.outcome, row._count._all);
    }
    const get = (o: string): number => byOutcome.get(o) ?? 0;
    const total = grouped.reduce((sum, r) => sum + r._count._all, 0);

    return {
      total,
      autoExecuted: get('AUTO_EXECUTED'),
      sentForReview: get('SENT_FOR_REVIEW'),
      escalated: get('ESCALATED'),
      overriddenByHuman: get('OVERRIDDEN_BY_HUMAN'),
      expired: get('EXPIRED'),
      overridden,
    };
  }

  /** Per-bucket auto-executed and total decision counts (for autonomy rate). */
  async getAutonomySeries(
    businessId: string,
    range: DateRange,
    granularity: Granularity,
  ): Promise<{ bucket: Date; auto: number; total: number }[]> {
    const unit = granularityToSqlUnit(granularity);
    const rows = await this.prisma.$queryRaw<AutonomyBucketRaw[]>`
      SELECT date_trunc(${unit}, decided_at) AS bucket,
             (COUNT(*) FILTER (WHERE outcome = 'AUTO_EXECUTED'))::float8 AS auto,
             COUNT(*)::float8 AS total
      FROM ai_decisions
      WHERE business_id = ${businessId}::uuid
        AND decided_at >= ${range.from} AND decided_at < ${range.to}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ bucket: r.bucket, auto: r.auto, total: r.total }));
  }

  /**
   * Confidence distribution: total decisions, mean confidence (0–1), and a
   * 10-bucket histogram (width_bucket over [0,1], overflow folded into the
   * top decile so a perfect 1.0 lands in bucket 10).
   */
  async getConfidenceStats(
    businessId: string,
    range: DateRange,
  ): Promise<{ total: number; averageConfidence: number; histogram: ConfidenceBucketRaw[] }> {
    const where: Prisma.ai_decisionsWhereInput = {
      business_id: businessId,
      decided_at: { gte: range.from, lt: range.to },
    };

    const [agg, histogram] = await Promise.all([
      this.prisma.ai_decisions.aggregate({
        where,
        _count: { _all: true },
        _avg: { confidence_score: true },
      }),
      this.prisma.$queryRaw<ConfidenceBucketRaw[]>`
        SELECT GREATEST(LEAST(width_bucket(confidence_score::float8, 0, 1, 10), 10), 1) AS bucket,
               COUNT(*)::int AS count
        FROM ai_decisions
        WHERE business_id = ${businessId}::uuid
          AND decided_at >= ${range.from} AND decided_at < ${range.to}
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    return {
      total: agg._count._all,
      averageConfidence: agg._avg.confidence_score?.toNumber() ?? 0,
      histogram,
    };
  }

  /**
   * Escalation reasons among ESCALATED decisions in the range. Uses an
   * explicit `escalationReason` in the proposed action when present, otherwise
   * falls back to the decision type.
   */
  async getEscalationReasons(
    businessId: string,
    range: DateRange,
  ): Promise<{ reason: string; count: number }[]> {
    const rows = await this.prisma.$queryRaw<KeyCountRaw[]>`
      SELECT COALESCE(NULLIF(proposed_action->>'escalationReason', ''), type::text) AS key,
             COUNT(*)::int AS count
      FROM ai_decisions
      WHERE business_id = ${businessId}::uuid
        AND outcome = 'ESCALATED'
        AND decided_at >= ${range.from} AND decided_at < ${range.to}
      GROUP BY 1
      ORDER BY count DESC
    `;
    return rows.map((r) => ({ reason: r.key, count: r.count }));
  }

  // ───────────────────────────────────────────────────────────────────
  // Revenue & orders
  // ───────────────────────────────────────────────────────────────────

  /**
   * Revenue summary for the range. Sums are returned in rupees (Decimal →
   * number); the service converts to paise. Refunds are completed refunds
   * whose completion falls in the range.
   */
  async getRevenueSummary(
    businessId: string,
    range: DateRange,
  ): Promise<{ grossRevenueRupees: number; refundsRupees: number; orderCount: number }> {
    const [orders, refunds] = await Promise.all([
      this.prisma.orders.aggregate({
        where: {
          business_id: businessId,
          deleted_at: null,
          status: REVENUE_ORDER_STATUSES,
          placed_at: { gte: range.from, lt: range.to },
        },
        _sum: { total: true },
        _count: { _all: true },
      }),
      this.prisma.refunds.aggregate({
        where: {
          business_id: businessId,
          status: 'COMPLETED',
          completed_at: { gte: range.from, lt: range.to },
        },
        _sum: { amount: true },
      }),
    ]);

    return {
      grossRevenueRupees: orders._sum.total?.toNumber() ?? 0,
      refundsRupees: refunds._sum.amount?.toNumber() ?? 0,
      orderCount: orders._count._all,
    };
  }

  /** Gross revenue per bucket, value already converted to paise. */
  async getRevenueSeries(
    businessId: string,
    range: DateRange,
    granularity: Granularity,
  ): Promise<BucketRow[]> {
    const unit = granularityToSqlUnit(granularity);
    const rows = await this.prisma.$queryRaw<BucketValueRaw[]>`
      SELECT date_trunc(${unit}, placed_at) AS bucket,
             (COALESCE(SUM(total), 0) * 100)::float8 AS value
      FROM orders
      WHERE business_id = ${businessId}::uuid
        AND deleted_at IS NULL
        AND status IN ('CONFIRMED','PROCESSING','PACKED','SHIPPED','DELIVERED','PARTIALLY_REFUNDED')
        AND placed_at >= ${range.from} AND placed_at < ${range.to}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ bucket: r.bucket, value: r.value }));
  }

  /** Order count per bucket. */
  async getOrderCountSeries(
    businessId: string,
    range: DateRange,
    granularity: Granularity,
  ): Promise<BucketRow[]> {
    const unit = granularityToSqlUnit(granularity);
    const rows = await this.prisma.$queryRaw<BucketValueRaw[]>`
      SELECT date_trunc(${unit}, placed_at) AS bucket,
             COUNT(*)::float8 AS value
      FROM orders
      WHERE business_id = ${businessId}::uuid
        AND deleted_at IS NULL
        AND status IN ('CONFIRMED','PROCESSING','PACKED','SHIPPED','DELIVERED','PARTIALLY_REFUNDED')
        AND placed_at >= ${range.from} AND placed_at < ${range.to}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ bucket: r.bucket, value: r.value }));
  }

  /**
   * Top products by revenue, from the `line_items` JSONB snapshot. Monetary
   * values inside line items are already in paise.
   */
  async getTopProducts(
    businessId: string,
    range: DateRange,
    limit: number,
  ): Promise<{ itemId: string; name: string; unitsSold: number; revenuePaise: number }[]> {
    const rows = await this.prisma.$queryRaw<TopProductRaw[]>`
      SELECT li->>'itemId' AS item_id,
             li->>'name'   AS name,
             COALESCE(SUM((li->>'quantity')::numeric), 0)::float8 AS units,
             COALESCE(SUM((li->>'totalPrice')::numeric), 0)::float8 AS revenue
      FROM orders o, jsonb_array_elements(o.line_items) li
      WHERE o.business_id = ${businessId}::uuid
        AND o.deleted_at IS NULL
        AND o.status IN ('CONFIRMED','PROCESSING','PACKED','SHIPPED','DELIVERED','PARTIALLY_REFUNDED')
        AND o.placed_at >= ${range.from} AND o.placed_at < ${range.to}
      GROUP BY 1, 2
      ORDER BY revenue DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      itemId: r.item_id ?? 'unknown',
      name: r.name ?? 'Unknown product',
      unitsSold: Math.round(r.units),
      revenuePaise: Math.round(r.revenue),
    }));
  }

  // ───────────────────────────────────────────────────────────────────
  // Clients
  // ───────────────────────────────────────────────────────────────────

  /** Clients first seen within the range (new acquisitions). */
  async countNewClients(businessId: string, range: DateRange): Promise<number> {
    return this.prisma.clients.count({
      where: {
        business_id: businessId,
        deleted_at: null,
        first_seen_at: { gte: range.from, lt: range.to },
      },
    });
  }

  /** Clients acquired before the range that interacted during it. */
  async countReturningClients(businessId: string, range: DateRange): Promise<number> {
    return this.prisma.clients.count({
      where: {
        business_id: businessId,
        deleted_at: null,
        first_seen_at: { lt: range.from },
        last_interaction_at: { gte: range.from, lt: range.to },
      },
    });
  }

  /**
   * New-client acquisition attributed to the channel each client *arrived* on.
   *
   * Attribution is single-channel by construction: `DISTINCT ON (c.id)` keeps
   * exactly one `channel_contacts` row per client — the earliest-seen one — so
   * every new client contributes to exactly one bucket and the buckets sum to
   * the number of new clients that have any contact at all.
   *
   * The obvious spelling, `COUNT(DISTINCT c.id) ... GROUP BY cc.channel`, is
   * what this replaces. The DISTINCT there only dedupes *within* a channel (a
   * client with two WhatsApp numbers), and a client reachable on WhatsApp and
   * Instagram still lands in both groups. That was tolerable when a person who
   * wrote in on two channels became two clients; since R53's cross-channel
   * identity matching it is the normal case, so the split was counting the same
   * acquisition once per channel and `AnalyticsService` was dividing those
   * inflated counts by the true `newClients` total — a channel breakdown whose
   * percentages summed past 100.
   *
   * `first_seen_at` ties are broken by `created_at` then `id` so the attributed
   * channel is stable across runs. Ties are not hypothetical: a client created
   * from a multi-channel contact payload gets every row in one transaction, all
   * defaulting to the same `now()`.
   */
  async getAcquisitionByChannel(
    businessId: string,
    range: DateRange,
  ): Promise<{ channel: ChannelType; count: number }[]> {
    const rows = await this.prisma.$queryRaw<{ channel: ChannelType; count: number }[]>`
      WITH first_contact AS (
        SELECT DISTINCT ON (c.id)
               c.id AS client_id,
               cc.channel AS channel
        FROM clients c
        JOIN channel_contacts cc
          ON cc.client_id = c.id AND cc.business_id = c.business_id
        WHERE c.business_id = ${businessId}::uuid
          AND c.deleted_at IS NULL
          AND c.first_seen_at >= ${range.from} AND c.first_seen_at < ${range.to}
        ORDER BY c.id, cc.first_seen_at ASC, cc.created_at ASC, cc.id ASC
      )
      SELECT channel, COUNT(*)::int AS count
      FROM first_contact
      GROUP BY 1
      ORDER BY count DESC, channel ASC
    `;
    return rows.map((r) => ({ channel: r.channel, count: r.count }));
  }

  /** New-client acquisitions per bucket. */
  async getAcquisitionSeries(
    businessId: string,
    range: DateRange,
    granularity: Granularity,
  ): Promise<BucketRow[]> {
    const unit = granularityToSqlUnit(granularity);
    const rows = await this.prisma.$queryRaw<BucketValueRaw[]>`
      SELECT date_trunc(${unit}, first_seen_at) AS bucket,
             COUNT(*)::float8 AS value
      FROM clients
      WHERE business_id = ${businessId}::uuid
        AND deleted_at IS NULL
        AND first_seen_at >= ${range.from} AND first_seen_at < ${range.to}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ bucket: r.bucket, value: r.value }));
  }

  /**
   * Retention/churn over a cohort active just before the window.
   * `priorFrom` = `from - (to - from)`. A client is:
   *  - active-at-start  → last_interaction_at in [priorFrom, to)  and first seen before `from`
   *  - churned          → last_interaction_at in [priorFrom, from) (no activity in the window)
   */
  async getRetentionStats(
    businessId: string,
    range: DateRange,
  ): Promise<{ activeAtStart: number; churned: number; atRisk: number }> {
    const durationMs = range.to.getTime() - range.from.getTime();
    const priorFrom = new Date(range.from.getTime() - durationMs);

    const baseCohort: Prisma.clientsWhereInput = {
      business_id: businessId,
      deleted_at: null,
      first_seen_at: { lt: range.from },
    };

    const [activeAtStart, churned, atRisk] = await Promise.all([
      this.prisma.clients.count({
        where: { ...baseCohort, last_interaction_at: { gte: priorFrom, lt: range.to } },
      }),
      this.prisma.clients.count({
        where: { ...baseCohort, last_interaction_at: { gte: priorFrom, lt: range.from } },
      }),
      this.prisma.clients.count({
        where: {
          business_id: businessId,
          deleted_at: null,
          churn_risk: { gte: AT_RISK_CHURN_THRESHOLD },
        },
      }),
    ]);

    return { activeAtStart, churned, atRisk };
  }

  // ───────────────────────────────────────────────────────────────────
  // Bookings
  // ───────────────────────────────────────────────────────────────────

  /** Booking counts grouped by status (by start time within the range). */
  async getBookingCounts(
    businessId: string,
    range: DateRange,
  ): Promise<{
    total: number;
    confirmed: number;
    completed: number;
    cancelled: number;
    noShow: number;
  }> {
    const grouped = await this.prisma.bookings.groupBy({
      by: ['status'],
      where: {
        business_id: businessId,
        deleted_at: null,
        start_at: { gte: range.from, lt: range.to },
      },
      _count: { _all: true },
    });

    const byStatus = new Map<string, number>();
    for (const row of grouped) {
      byStatus.set(row.status, row._count._all);
    }
    const get = (s: string): number => byStatus.get(s) ?? 0;

    return {
      total: grouped.reduce((sum, r) => sum + r._count._all, 0),
      confirmed: get('CONFIRMED'),
      completed: get('COMPLETED'),
      cancelled: get('CANCELLED'),
      noShow: get('NO_SHOW'),
    };
  }

  /** Bookings (by start time) per bucket. */
  async getBookingSeries(
    businessId: string,
    range: DateRange,
    granularity: Granularity,
  ): Promise<BucketRow[]> {
    const unit = granularityToSqlUnit(granularity);
    const rows = await this.prisma.$queryRaw<BucketValueRaw[]>`
      SELECT date_trunc(${unit}, start_at) AS bucket,
             COUNT(*)::float8 AS value
      FROM bookings
      WHERE business_id = ${businessId}::uuid
        AND deleted_at IS NULL
        AND start_at >= ${range.from} AND start_at < ${range.to}
      GROUP BY 1
      ORDER BY 1
    `;
    return rows.map((r) => ({ bucket: r.bucket, value: r.value }));
  }

  // ───────────────────────────────────────────────────────────────────
  // Team performance
  // ───────────────────────────────────────────────────────────────────

  /**
   * Per-member productivity for active team members: currently-assigned
   * conversations, conversations + tasks resolved in the range, and mean task
   * resolution time (seconds).
   */
  async getStaffMetrics(
    businessId: string,
    range: DateRange,
  ): Promise<
    {
      memberId: string;
      name: string;
      role: string;
      assignedConversations: number;
      resolvedConversations: number;
      tasksResolved: number;
      avgTaskResolutionSeconds: number;
    }[]
  > {
    const rows = await this.prisma.$queryRaw<StaffRaw[]>`
      SELECT tm.id AS id,
             tm.name AS name,
             tm.role::text AS role,
             COALESCE(cv.assigned, 0)::int         AS assigned,
             COALESCE(cv.resolved_conv, 0)::int    AS resolved_conv,
             COALESCE(tr.tasks_resolved, 0)::int   AS tasks_resolved,
             COALESCE(tr.avg_task_sec, 0)::float8  AS avg_task_sec
      FROM team_members tm
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS assigned,
               COUNT(*) FILTER (
                 WHERE c.status = 'RESOLVED'
                   AND c.resolved_at >= ${range.from} AND c.resolved_at < ${range.to}
               )::int AS resolved_conv
        FROM conversations c
        WHERE c.business_id = tm.business_id AND c.assigned_to = tm.id
          AND c.deleted_at IS NULL
      ) cv ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS tasks_resolved,
               AVG(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))) AS avg_task_sec
        FROM tasks t
        WHERE t.business_id = tm.business_id AND t.resolved_by = tm.id
          AND t.status = 'RESOLVED'::"TaskStatus"
          AND t.resolved_at >= ${range.from} AND t.resolved_at < ${range.to}
      ) tr ON TRUE
      WHERE tm.business_id = ${businessId}::uuid
        AND tm.deleted_at IS NULL
        AND tm.status = 'ACTIVE'
      ORDER BY resolved_conv DESC, tasks_resolved DESC
    `;

    return rows.map((r) => ({
      memberId: r.id,
      name: r.name,
      role: r.role,
      assignedConversations: r.assigned,
      resolvedConversations: r.resolved_conv,
      tasksResolved: r.tasks_resolved,
      avgTaskResolutionSeconds: Math.round(r.avg_task_sec),
    }));
  }

  /** Open HITL tasks awaiting a human right now (not range-scoped). */
  async countPendingTasks(businessId: string): Promise<number> {
    return this.prisma.tasks.count({
      where: {
        business_id: businessId,
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Misc dashboard counts
  // ───────────────────────────────────────────────────────────────────

  /** Bookings starting within the range (count only). */
  async countBookings(businessId: string, range: DateRange): Promise<number> {
    return this.prisma.bookings.count({
      where: {
        business_id: businessId,
        deleted_at: null,
        start_at: { gte: range.from, lt: range.to },
      },
    });
  }
}
