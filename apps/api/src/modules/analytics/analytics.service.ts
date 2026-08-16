import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ChannelType } from '@gosumo/shared';
import { AnalyticsRepository, DateRange } from './analytics.repository';
import { ANALYTICS_CACHE, AnalyticsCache } from './analytics.cache';
import { fillTimeSeries, pct, round2, rupeesToPaise, toCsv } from './analytics.util';
import {
  summarizeCsat,
  CSAT_PROXY_MAX,
  CSAT_PROXY_PENALTY,
  CSAT_PROXY_SLOW_HOURS,
  CSAT_PROXY_CHATTY_INBOUND,
} from './conversation-quality.util';
import { LlmClientService, LlmUnavailableError } from '../ai-engine/pipeline/llm-client.service';
import {
  AiSummaryDto,
  AnalyticsRangeQueryDto,
  AnalyticsTopQueryDto,
  AutonomyMetricsDto,
  BookingMetricsDto,
  ChannelVolumeDto,
  ClientAcquisitionMetricsDto,
  ClientRetentionMetricsDto,
  ConfidenceBand,
  ConfidenceBandCountDto,
  ConfidenceBucketDto,
  ConfidenceDistributionDto,
  ConversationMetricsDto,
  ConversationQualityDto,
  DashboardSummaryDto,
  EscalationReasonDto,
  ExportedReportDto,
  ExportMetric,
  ExportReportQueryDto,
  Granularity,
  ResolvedRangeDto,
  ResponseTimeMetricsDto,
  RevenueMetricsDto,
  StaffMetricsDto,
  TimeSeriesPointDto,
  TopProductDto,
} from './dto';

/** Default trailing window when the caller omits `from`/`to`. */
const DEFAULT_RANGE_DAYS = 30;
/** Hard cap on the queryable window (CLAUDE.md: 422 DATE_RANGE_TOO_LARGE). */
const MAX_RANGE_DAYS = 365;
/** Dashboard summary cache TTL. */
const DASHBOARD_CACHE_TTL_SECONDS = 300;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Internal: a resolved range plus its granularity. */
interface ResolvedRange {
  from: Date;
  to: Date;
  granularity: Granularity;
}

/**
 * AnalyticsService — the public API of the analytics module.
 *
 * Responsibilities:
 *  - Resolve and validate date ranges (default 30d, cap 365d).
 *  - Orchestrate repository aggregations into chart-ready DTOs.
 *  - Compute platform KPIs (autonomy rate, resolution rate, churn).
 *  - Cache the dashboard summary in Redis with a 5-minute TTL.
 *
 * The module is read-only — it emits no events and never writes.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly repository: AnalyticsRepository,
    @Inject(ANALYTICS_CACHE) private readonly cache: AnalyticsCache,
    private readonly llmClient: LlmClientService,
  ) {}

  // ───────────────────────────────────────────────────────────────────
  // Range resolution & validation
  // ───────────────────────────────────────────────────────────────────

  /**
   * Resolve a query's `from`/`to`/`granularity` into concrete values.
   * - `to` defaults to now; `from` defaults to `to - 30 days`.
   * - `granularity` defaults to DAY.
   * - Throws 400 if `from >= to`, 422 if the span exceeds 365 days.
   */
  resolveRange(query: AnalyticsRangeQueryDto): ResolvedRange {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid `from`/`to` timestamp');
    }
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('`from` must be strictly before `to`');
    }

    const spanDays = (to.getTime() - from.getTime()) / MS_PER_DAY;
    if (spanDays > MAX_RANGE_DAYS) {
      throw new UnprocessableEntityException({
        code: 'DATE_RANGE_TOO_LARGE',
        message: `Date range is capped at ${MAX_RANGE_DAYS} days (requested ${Math.ceil(spanDays)}).`,
      });
    }

    return { from, to, granularity: query.granularity ?? Granularity.DAY };
  }

  private toResolvedRangeDto(range: ResolvedRange): ResolvedRangeDto {
    return {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      granularity: range.granularity,
    };
  }

  private asDateRange(range: ResolvedRange): DateRange {
    return { from: range.from, to: range.to };
  }

  // ───────────────────────────────────────────────────────────────────
  // Dashboard summary (cached)
  // ───────────────────────────────────────────────────────────────────

  /**
   * High-level dashboard summary for "today" (UTC day start → now). Cached in
   * Redis for 5 minutes; on a cache miss the live query runs and re-caches.
   * Never throws on an empty business — returns zeros.
   */
  async getDashboardSummary(businessId: string): Promise<DashboardSummaryDto> {
    // One clock read for both the key and the window it describes, so a request
    // that straddles midnight cannot cache a summary of one day under another
    // day's key.
    const now = new Date();
    const cacheKey = this.dashboardCacheKey(businessId, now);

    const cached = await this.safeCacheGet(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as DashboardSummaryDto;
      } catch {
        this.logger.warn(`Corrupt dashboard cache for ${businessId}; recomputing`);
      }
    }

    const summary = await this.computeDashboardSummary(businessId, now);
    await this.safeCacheSet(cacheKey, JSON.stringify(summary), DASHBOARD_CACHE_TTL_SECONDS);
    return summary;
  }

  private async computeDashboardSummary(
    businessId: string,
    now: Date,
  ): Promise<DashboardSummaryDto> {
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    // Guard against the exact midnight tick so `from < to` always holds.
    const todayRange: DateRange = {
      from: startOfDay,
      to: now.getTime() > startOfDay.getTime() ? now : new Date(startOfDay.getTime() + 1000),
    };

    const [
      conversations,
      responseTime,
      decisions,
      revenue,
      newClients,
      bookingsToday,
      openConversations,
      pendingTasks,
    ] = await Promise.all([
      this.repository.getConversationCounts(businessId, todayRange),
      this.repository.getResponseTimeStats(businessId, todayRange),
      this.repository.getAiDecisionCounts(businessId, todayRange),
      this.repository.getRevenueSummary(businessId, todayRange),
      this.repository.countNewClients(businessId, todayRange),
      this.repository.countBookings(businessId, todayRange),
      this.repository.countOpenConversations(businessId),
      this.repository.countPendingTasks(businessId),
    ]);

    return {
      conversationsToday: conversations.total,
      openConversations,
      avgFirstResponseSecondsToday: round2(responseTime.avgSeconds),
      resolutionRateToday: pct(conversations.resolved, conversations.total),
      autonomyRateToday: pct(decisions.autoExecuted, decisions.total),
      revenueTodayPaise: rupeesToPaise(revenue.grossRevenueRupees),
      ordersToday: revenue.orderCount,
      bookingsToday,
      newClientsToday: newClients,
      pendingTasks,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * The cache key carries the UTC day the summary describes.
   *
   * Every field on `DashboardSummaryDto` is a "today" figure measured over
   * `[UTC midnight, now)`, but the key used to be day-less and the entry lives
   * for {@link DASHBOARD_CACHE_TTL_SECONDS}. An entry written at 23:58 UTC was
   * therefore still served at 00:01 the next day: the dashboard opened on a
   * fresh day showing the previous day's conversation, revenue and booking
   * counts, and a `generatedAt` timestamp that quietly disagreed with them. The
   * numbers then appeared to *drop to zero* when the entry finally expired,
   * which reads as data loss rather than a new day starting.
   *
   * Dating the key makes the rollover a cache miss instead of a stale hit. The
   * previous day's entry is simply never asked for again and ages out on its
   * own TTL.
   */
  private dashboardCacheKey(businessId: string, now: Date): string {
    const utcDay = now.toISOString().slice(0, 10); // YYYY-MM-DD
    return `gosumo:${businessId}:analytics:dashboard:${utcDay}`;
  }

  // ───────────────────────────────────────────────────────────────────
  // Conversation analytics
  // ───────────────────────────────────────────────────────────────────

  async getConversationMetrics(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<ConversationMetricsDto> {
    const range = this.resolveRange(query);
    const dateRange = this.asDateRange(range);

    const [counts, byChannelRaw, seriesRows] = await Promise.all([
      this.repository.getConversationCounts(businessId, dateRange),
      this.repository.getConversationVolumeByChannel(businessId, dateRange),
      this.repository.getConversationVolumeSeries(businessId, dateRange, range.granularity),
    ]);

    const byChannel = this.buildChannelVolume(byChannelRaw, counts.total);
    const resolvedTotal = counts.aiResolved + counts.humanResolved;

    return {
      range: this.toResolvedRangeDto(range),
      total: counts.total,
      resolved: counts.resolved,
      open: counts.open,
      pendingHuman: counts.pendingHuman,
      escalated: counts.escalated,
      resolutionRate: pct(counts.resolved, counts.total),
      aiResolutionRate: pct(counts.aiResolved, resolvedTotal),
      humanResolutionRate: pct(counts.humanResolved, resolvedTotal),
      aiResolvedCount: counts.aiResolved,
      humanResolvedCount: counts.humanResolved,
      byChannel,
      volumeSeries: this.buildSeries(range, seriesRows),
    };
  }

  async getResponseTimeMetrics(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<ResponseTimeMetricsDto> {
    const range = this.resolveRange(query);
    const dateRange = this.asDateRange(range);

    const [stats, avgResolution, seriesRows] = await Promise.all([
      this.repository.getResponseTimeStats(businessId, dateRange),
      this.repository.getAvgResolutionSeconds(businessId, dateRange),
      this.repository.getResponseTimeSeries(businessId, dateRange, range.granularity),
    ]);

    return {
      range: this.toResolvedRangeDto(range),
      avgFirstResponseSeconds: round2(stats.avgSeconds),
      p50FirstResponseSeconds: round2(stats.p50Seconds),
      p90FirstResponseSeconds: round2(stats.p90Seconds),
      avgResolutionSeconds: round2(avgResolution),
      sampleSize: stats.sampleSize,
      series: this.buildSeries(range, seriesRows),
    };
  }

  /**
   * The conversation-quality report: how much got resolved, how much of that
   * took one round trip, how fast, and how satisfied the customer probably was.
   *
   * Five queries in parallel rather than one large one. They scope to different
   * windows on purpose — volume by `created_at`, resolution and CSAT by
   * `resolved_at` — and folding them together would force one window on all of
   * them, which is the mistake that makes a resolution-rate chart trend
   * downwards forever (see `getConversationQualityStats`).
   */
  async getConversationQualityMetrics(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<ConversationQualityDto> {
    const range = this.resolveRange(query);
    const dateRange = this.asDateRange(range);

    const [counts, quality, responseTimes, csatSignals, byChannel] = await Promise.all([
      this.repository.getConversationCounts(businessId, dateRange),
      this.repository.getConversationQualityStats(businessId, dateRange),
      this.repository.getResponseTimeStats(businessId, dateRange),
      this.repository.getCsatSignals(
        businessId,
        dateRange,
        CSAT_PROXY_SLOW_HOURS,
        CSAT_PROXY_CHATTY_INBOUND,
      ),
      this.repository.getConversationQualityByChannel(businessId, dateRange),
    ]);

    const csat = summarizeCsat(csatSignals.explicit, csatSignals.proxyGroups);

    return {
      range: this.toResolvedRangeDto(range),
      volume: {
        created: counts.total,
        resolved: quality.resolvedCount,
        open: counts.open,
        pendingHuman: counts.pendingHuman,
        escalated: counts.escalated,
      },
      // Denominator is what was opened in the window, not what was closed —
      // "of the work that arrived, how much did we finish" is the question a
      // business owner is asking. It can exceed 100% in a period spent clearing
      // a backlog, which is true and worth seeing rather than clamping away.
      resolutionRate: pct(quality.resolvedCount, counts.total),
      firstContactResolution: {
        count: quality.fcrCount,
        // Denominator is *resolved* conversations: FCR asks "of the ones we
        // closed, how many took one round trip", so an unclosed conversation
        // is not yet a failure of first-contact resolution.
        rate: pct(quality.fcrCount, quality.resolvedCount),
        escalatedCount: quality.escalatedCount,
      },
      responseTime: {
        avgFirstResponseSeconds: round2(responseTimes.avgSeconds),
        p50FirstResponseSeconds: round2(responseTimes.p50Seconds),
        p90FirstResponseSeconds: round2(responseTimes.p90Seconds),
        sampleSize: responseTimes.sampleSize,
      },
      resolutionTime: {
        avgSeconds: round2(quality.avgResolutionSeconds),
        p50Seconds: round2(quality.p50ResolutionSeconds),
        p90Seconds: round2(quality.p90ResolutionSeconds),
      },
      csat: {
        explicitResponses: csat.explicitResponses,
        explicitAverage: csat.explicitAverage,
        proxySampled: csat.proxySampled,
        proxyAverage: csat.proxyAverage,
        combinedAverage: csat.combinedAverage,
        combinedSampled: csat.combinedSampled,
        distribution: csat.distribution,
        proxyModel: {
          maxScore: CSAT_PROXY_MAX,
          slowHours: CSAT_PROXY_SLOW_HOURS,
          chattyInboundThreshold: CSAT_PROXY_CHATTY_INBOUND,
          penaltyPerSignal: CSAT_PROXY_PENALTY,
        },
      },
      byChannel: byChannel.map((c) => ({
        channel: c.channel,
        created: c.created,
        resolved: c.resolved,
        resolutionRate: pct(c.resolved, c.created),
        firstContactResolutionRate: pct(c.fcr, c.resolved),
        avgResolutionSeconds: round2(c.avgResolutionSeconds),
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Revenue analytics
  // ───────────────────────────────────────────────────────────────────

  async getRevenueMetrics(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<RevenueMetricsDto> {
    const range = this.resolveRange(query);
    const dateRange = this.asDateRange(range);

    const [summary, revenueRows, orderRows] = await Promise.all([
      this.repository.getRevenueSummary(businessId, dateRange),
      this.repository.getRevenueSeries(businessId, dateRange, range.granularity),
      this.repository.getOrderCountSeries(businessId, dateRange, range.granularity),
    ]);

    const grossPaise = rupeesToPaise(summary.grossRevenueRupees);
    const refundsPaise = rupeesToPaise(summary.refundsRupees);
    const netPaise = grossPaise - refundsPaise;
    const aovPaise = summary.orderCount > 0 ? Math.round(grossPaise / summary.orderCount) : 0;

    return {
      range: this.toResolvedRangeDto(range),
      grossRevenuePaise: grossPaise,
      netRevenuePaise: netPaise,
      refundsPaise,
      orderCount: summary.orderCount,
      averageOrderValuePaise: aovPaise,
      revenueSeries: this.buildSeries(range, revenueRows),
      orderCountSeries: this.buildSeries(range, orderRows),
    };
  }

  async getTopProducts(
    businessId: string,
    query: AnalyticsTopQueryDto,
  ): Promise<TopProductDto[]> {
    const range = this.resolveRange(query);
    const limit = query.limit ?? 10;
    const rows = await this.repository.getTopProducts(businessId, this.asDateRange(range), limit);
    return rows.map((r) => ({
      itemId: r.itemId,
      name: r.name,
      unitsSold: r.unitsSold,
      revenuePaise: r.revenuePaise,
    }));
  }

  // ───────────────────────────────────────────────────────────────────
  // Client analytics
  // ───────────────────────────────────────────────────────────────────

  async getClientAcquisitionMetrics(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<ClientAcquisitionMetricsDto> {
    const range = this.resolveRange(query);
    const dateRange = this.asDateRange(range);

    const [newClients, returningClients, byChannelRaw, seriesRows] = await Promise.all([
      this.repository.countNewClients(businessId, dateRange),
      this.repository.countReturningClients(businessId, dateRange),
      this.repository.getAcquisitionByChannel(businessId, dateRange),
      this.repository.getAcquisitionSeries(businessId, dateRange, range.granularity),
    ]);

    return {
      range: this.toResolvedRangeDto(range),
      newClients,
      returningClients,
      newClientShare: pct(newClients, newClients + returningClients),
      byChannel: this.buildChannelVolume(byChannelRaw, newClients),
      acquisitionSeries: this.buildSeries(range, seriesRows),
    };
  }

  async getClientRetentionMetrics(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<ClientRetentionMetricsDto> {
    const range = this.resolveRange(query);
    const stats = await this.repository.getRetentionStats(businessId, this.asDateRange(range));

    const churnRate = pct(stats.churned, stats.activeAtStart);

    return {
      range: this.toResolvedRangeDto(range),
      activeAtStart: stats.activeAtStart,
      churnedClients: stats.churned,
      churnRate,
      retentionRate: round2(100 - churnRate),
      atRiskClients: stats.atRisk,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // AI performance analytics
  // ───────────────────────────────────────────────────────────────────

  async getAutonomyMetrics(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<AutonomyMetricsDto> {
    const range = this.resolveRange(query);
    const dateRange = this.asDateRange(range);

    const [counts, seriesRows] = await Promise.all([
      this.repository.getAiDecisionCounts(businessId, dateRange),
      this.repository.getAutonomySeries(businessId, dateRange, range.granularity),
    ]);

    // Per-bucket autonomy rate (auto/total) — each bucket appears once.
    const rateRows = seriesRows.map((r) => ({
      bucket: r.bucket,
      value: pct(r.auto, r.total),
    }));

    return {
      range: this.toResolvedRangeDto(range),
      totalDecisions: counts.total,
      autoExecuted: counts.autoExecuted,
      sentForReview: counts.sentForReview,
      escalated: counts.escalated,
      overridden: counts.overridden,
      expired: counts.expired,
      autonomyRate: pct(counts.autoExecuted, counts.total),
      overrideRate: pct(counts.overridden, counts.autoExecuted),
      autonomySeries: this.buildSeries(range, rateRows),
    };
  }

  async getConfidenceDistribution(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<ConfidenceDistributionDto> {
    const range = this.resolveRange(query);
    const stats = await this.repository.getConfidenceStats(businessId, this.asDateRange(range));

    const histogram = this.buildConfidenceHistogram(stats.histogram);
    const byBand = this.buildConfidenceBands(histogram, stats.total);

    return {
      range: this.toResolvedRangeDto(range),
      totalDecisions: stats.total,
      averageConfidence: round2(stats.averageConfidence * 100),
      histogram,
      byBand,
    };
  }

  async getEscalationReasons(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<EscalationReasonDto[]> {
    const range = this.resolveRange(query);
    const rows = await this.repository.getEscalationReasons(businessId, this.asDateRange(range));
    const total = rows.reduce((sum, r) => sum + r.count, 0);

    return rows.map((r) => ({
      reason: r.reason,
      count: r.count,
      percentage: pct(r.count, total),
    }));
  }

  // ───────────────────────────────────────────────────────────────────
  // Team performance
  // ───────────────────────────────────────────────────────────────────

  async getStaffMetrics(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<StaffMetricsDto[]> {
    const range = this.resolveRange(query);
    return this.repository.getStaffMetrics(businessId, this.asDateRange(range));
  }

  // ───────────────────────────────────────────────────────────────────
  // Booking analytics
  // ───────────────────────────────────────────────────────────────────

  async getBookingMetrics(
    businessId: string,
    query: AnalyticsRangeQueryDto,
  ): Promise<BookingMetricsDto> {
    const range = this.resolveRange(query);
    const dateRange = this.asDateRange(range);

    const [counts, seriesRows] = await Promise.all([
      this.repository.getBookingCounts(businessId, dateRange),
      this.repository.getBookingSeries(businessId, dateRange, range.granularity),
    ]);

    return {
      range: this.toResolvedRangeDto(range),
      total: counts.total,
      confirmed: counts.confirmed,
      completed: counts.completed,
      cancelled: counts.cancelled,
      noShow: counts.noShow,
      completionRate: pct(counts.completed, counts.total),
      cancellationRate: pct(counts.cancelled + counts.noShow, counts.total),
      series: this.buildSeries(range, seriesRows),
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Report export (CSV)
  // ───────────────────────────────────────────────────────────────────

  /**
   * Render a metric's time series (or, for STAFF, the per-member table) as
   * a downloadable CSV. Reuses the same range-resolution and repository
   * queries as the JSON endpoints — this is a rendering, not a new query.
   */
  async exportReport(businessId: string, query: ExportReportQueryDto): Promise<ExportedReportDto> {
    const metric = query.metric ?? ExportMetric.CONVERSATIONS;
    const range = this.resolveRange(query);

    let rows: Record<string, string | number | boolean | null>[];

    switch (metric) {
      case ExportMetric.RESPONSE_TIME: {
        const data = await this.getResponseTimeMetrics(businessId, query);
        rows = data.series.map((p) => ({ date: p.date, avgFirstResponseSeconds: p.value }));
        break;
      }
      case ExportMetric.REVENUE: {
        const data = await this.getRevenueMetrics(businessId, query);
        rows = data.revenueSeries.map((p, i) => ({
          date: p.date,
          grossRevenuePaise: p.value,
          orderCount: data.orderCountSeries[i]?.value ?? 0,
        }));
        break;
      }
      case ExportMetric.AUTONOMY: {
        const data = await this.getAutonomyMetrics(businessId, query);
        rows = data.autonomySeries.map((p) => ({ date: p.date, autonomyRatePercent: p.value }));
        break;
      }
      case ExportMetric.STAFF: {
        const data = await this.getStaffMetrics(businessId, query);
        rows = data.map((s) => ({
          memberId: s.memberId,
          name: s.name,
          role: s.role,
          assignedConversations: s.assignedConversations,
          resolvedConversations: s.resolvedConversations,
          tasksResolved: s.tasksResolved,
          avgTaskResolutionSeconds: s.avgTaskResolutionSeconds,
        }));
        break;
      }
      case ExportMetric.CONVERSATIONS:
      default: {
        const data = await this.getConversationMetrics(businessId, query);
        rows = data.volumeSeries.map((p) => ({ date: p.date, conversations: p.value }));
        break;
      }
    }

    const dateStamp = range.to.toISOString().slice(0, 10);
    return {
      filename: `gosumo-${metric.toLowerCase()}-${dateStamp}.csv`,
      contentType: 'text/csv',
      csv: toCsv(rows),
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // AI-generated narrative summary (OpenRouter)
  // ───────────────────────────────────────────────────────────────────

  /**
   * A short, business-friendly narrative summary of the period's performance,
   * generated via OpenRouter. Fails open: if the LLM is unavailable, returns
   * a deterministic summary built from the same numbers instead of erroring.
   */
  async getAiSummary(businessId: string, query: AnalyticsRangeQueryDto = {}): Promise<AiSummaryDto> {
    const range = this.resolveRange(query);
    const dateRange = this.asDateRange(range);

    const [conversations, response, revenue, autonomy] = await Promise.all([
      this.repository.getConversationCounts(businessId, dateRange),
      this.repository.getResponseTimeStats(businessId, dateRange),
      this.repository.getRevenueSummary(businessId, dateRange),
      this.repository.getAiDecisionCounts(businessId, dateRange),
    ]);

    const facts = {
      conversationsTotal: conversations.total,
      resolutionRatePercent: pct(conversations.resolved, conversations.total),
      avgFirstResponseSeconds: round2(response.avgSeconds),
      grossRevenuePaise: rupeesToPaise(revenue.grossRevenueRupees),
      orderCount: revenue.orderCount,
      autonomyRatePercent: pct(autonomy.autoExecuted, autonomy.total),
      escalatedCount: autonomy.escalated,
    };

    try {
      const result = await this.llmClient.complete({
        system:
          'You are a concise business analyst summarizing customer-support metrics for a small ' +
          'Indian business owner. Write 3-5 short bullet points in plain English, no markdown ' +
          'headers, no fluff. Call out the single most important number and one clear ' +
          'recommendation if a metric looks concerning (e.g. low autonomy, low resolution rate).',
        user: `Metrics for ${range.from.toISOString().slice(0, 10)} to ${range.to.toISOString().slice(0, 10)}:\n${JSON.stringify(facts, null, 2)}`,
        maxTokens: 300,
        temperature: 0.4,
      });

      return {
        range: this.toResolvedRangeDto(range),
        summary: result.text || this.fallbackSummary(facts),
        aiGenerated: Boolean(result.text),
        modelId: result.modelId,
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) {
        this.logger.warn(`Unexpected error generating AI summary: ${this.errMsg(err)}`);
      }
      return {
        range: this.toResolvedRangeDto(range),
        summary: this.fallbackSummary(facts),
        aiGenerated: false,
        generatedAt: new Date().toISOString(),
      };
    }
  }

  private fallbackSummary(facts: {
    conversationsTotal: number;
    resolutionRatePercent: number;
    avgFirstResponseSeconds: number;
    grossRevenuePaise: number;
    orderCount: number;
    autonomyRatePercent: number;
    escalatedCount: number;
  }): string {
    const revenueRupees = round2(facts.grossRevenuePaise / 100);
    return [
      `${facts.conversationsTotal} conversations, ${facts.resolutionRatePercent}% resolved.`,
      `Average first response: ${Math.round(facts.avgFirstResponseSeconds)}s.`,
      `Revenue: ₹${revenueRupees} across ${facts.orderCount} orders.`,
      `AI autonomy rate: ${facts.autonomyRatePercent}% (${facts.escalatedCount} escalated to a human).`,
    ].join(' ');
  }

  // ───────────────────────────────────────────────────────────────────
  // Shared builders
  // ───────────────────────────────────────────────────────────────────

  private buildSeries(
    range: ResolvedRange,
    rows: { bucket: Date; value: number }[],
  ): TimeSeriesPointDto[] {
    return fillTimeSeries(range.from, range.to, range.granularity, rows);
  }

  private buildChannelVolume(
    rows: { channel: ChannelType; count: number }[],
    total: number,
  ): ChannelVolumeDto[] {
    return rows
      .map((r) => ({
        channel: r.channel,
        count: r.count,
        percentage: pct(r.count, total),
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Expand the sparse raw histogram (bucket index 1–10) into a full,
   * zero-filled 10-bucket decile distribution.
   */
  private buildConfidenceHistogram(
    rows: { bucket: number; count: number }[],
  ): ConfidenceBucketDto[] {
    const counts = new Map<number, number>();
    for (const r of rows) {
      counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + r.count);
    }

    const buckets: ConfidenceBucketDto[] = [];
    for (let i = 1; i <= 10; i++) {
      buckets.push({
        lower: (i - 1) * 10,
        upper: i * 10,
        count: counts.get(i) ?? 0,
      });
    }
    return buckets;
  }

  /**
   * Roll up the decile histogram into autonomy bands:
   *   ESCALATE [0,70), REVIEW [70,90), AUTO [90,100].
   */
  private buildConfidenceBands(
    histogram: ConfidenceBucketDto[],
    total: number,
  ): ConfidenceBandCountDto[] {
    const sumRange = (lo: number, hi: number): number =>
      histogram
        .filter((b) => b.lower >= lo && b.lower < hi)
        .reduce((sum, b) => sum + b.count, 0);

    const escalate = sumRange(0, 70);
    const review = sumRange(70, 90);
    const auto = sumRange(90, 100);

    return [
      { band: ConfidenceBand.ESCALATE, count: escalate, percentage: pct(escalate, total) },
      { band: ConfidenceBand.REVIEW, count: review, percentage: pct(review, total) },
      { band: ConfidenceBand.AUTO, count: auto, percentage: pct(auto, total) },
    ];
  }

  // ───────────────────────────────────────────────────────────────────
  // Cache helpers (never let a cache outage break analytics)
  // ───────────────────────────────────────────────────────────────────

  private async safeCacheGet(key: string): Promise<string | null> {
    try {
      return await this.cache.get(key);
    } catch (err) {
      this.logger.warn(`Analytics cache get failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  private async safeCacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.cache.set(key, value, ttlSeconds);
    } catch (err) {
      this.logger.warn(`Analytics cache set failed: ${this.errMsg(err)}`);
    }
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
