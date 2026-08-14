import {
  IsOptional,
  IsEnum,
  IsString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ChannelType } from '@gosumo/shared';
import { IsCalendarDateString } from '../../../common/validators/is-calendar-date.validator';

// ─────────────────────────────────────────────
// Enums (application layer)
// ─────────────────────────────────────────────

/**
 * Time-bucket granularity for time-series aggregation. Maps 1:1 onto a
 * PostgreSQL `date_trunc` unit (see analytics.util.ts).
 */
export enum Granularity {
  HOUR = 'HOUR',
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
}

/**
 * Confidence band a single AI decision falls into, aligned with the platform's
 * autonomy routing thresholds:
 *   - AUTO     (>= 0.90) → auto-executed
 *   - REVIEW   (0.70–0.89) → drafted for human review (HITL)
 *   - ESCALATE (< 0.70) → full human escalation
 */
export enum ConfidenceBand {
  ESCALATE = 'ESCALATE',
  REVIEW = 'REVIEW',
  AUTO = 'AUTO',
}

// ─────────────────────────────────────────────
// Query DTOs
// ─────────────────────────────────────────────

/**
 * Common date-range + granularity query for every analytics endpoint.
 *
 * `from`/`to` are ISO-8601 timestamps. When omitted, the service defaults to
 * the trailing 30 days ending now. The range is capped at 365 days — larger
 * ranges return HTTP 422 `DATE_RANGE_TOO_LARGE`.
 */
export class AnalyticsRangeQueryDto {
  @ApiPropertyOptional({
    description: 'Range start (ISO-8601). Defaults to 30 days ago.',
    example: '2026-06-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsCalendarDateString()
  from?: string;

  @ApiPropertyOptional({
    description: 'Range end (ISO-8601). Defaults to now.',
    example: '2026-06-27T00:00:00.000Z',
  })
  @IsOptional()
  @IsCalendarDateString()
  to?: string;

  @ApiPropertyOptional({
    enum: Granularity,
    description: 'Time-series bucket size. Defaults to DAY.',
  })
  @IsOptional()
  @IsEnum(Granularity)
  granularity?: Granularity;

  @ApiPropertyOptional({ description: "UI preset label (ignored by server)." })
  @IsOptional()
  @IsString()
  preset?: string;

  @ApiPropertyOptional({ description: "Filter by channel." })
  @IsOptional()
  @IsString()
  channelId?: string;
}

/**
 * Range query that also accepts a `limit` (e.g. top-products, staff lists).
 */
export class AnalyticsTopQueryDto extends AnalyticsRangeQueryDto {
  @ApiPropertyOptional({
    description: 'Maximum rows to return.',
    minimum: 1,
    maximum: 100,
    default: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ─────────────────────────────────────────────
// Shared response shapes
// ─────────────────────────────────────────────

/** Resolved, normalized range echoed back on every response for clarity. */
export interface ResolvedRangeDto {
  /** Inclusive range start (ISO-8601). */
  from: string;
  /** Exclusive range end (ISO-8601). */
  to: string;
  granularity: Granularity;
}

/** A single point in a chart-ready, gap-filled time series. */
export interface TimeSeriesPointDto {
  /** Bucket start (ISO-8601, UTC). */
  date: string;
  value: number;
}

/** A named time series (e.g. one line on a multi-series chart). */
export interface NamedTimeSeriesDto {
  key: string;
  points: TimeSeriesPointDto[];
}

/** Generic count broken down by an arbitrary string key. */
export interface BreakdownEntryDto {
  key: string;
  count: number;
  /** Share of the total, 0–100, rounded to 2dp. */
  percentage: number;
}

// ─────────────────────────────────────────────
// Dashboard summary
// ─────────────────────────────────────────────

export interface DashboardSummaryDto {
  /** Conversations created today (business-day, UTC). */
  conversationsToday: number;
  /** Conversations still open or awaiting a human right now. */
  openConversations: number;
  /** Average first-response time today, in seconds (0 when no sample). */
  avgFirstResponseSecondsToday: number;
  /** Resolution rate today (resolved / total), 0–100. */
  resolutionRateToday: number;
  /** AI autonomy rate today (autoExecuted / totalDecisions), 0–100. */
  autonomyRateToday: number;
  /** Gross revenue today, in paise. */
  revenueTodayPaise: number;
  /** Orders placed today. */
  ordersToday: number;
  /** Bookings starting today. */
  bookingsToday: number;
  /** New clients acquired today. */
  newClientsToday: number;
  /** Open HITL tasks awaiting a human right now. */
  pendingTasks: number;
  /** When this summary was computed (ISO-8601). */
  generatedAt: string;
}

// ─────────────────────────────────────────────
// Conversation analytics
// ─────────────────────────────────────────────

export interface ConversationMetricsDto {
  range: ResolvedRangeDto;
  total: number;
  resolved: number;
  open: number;
  pendingHuman: number;
  escalated: number;
  /** Resolved / total, 0–100. */
  resolutionRate: number;
  /** Resolved with zero human messages / resolved, 0–100. */
  aiResolutionRate: number;
  /** Resolved that involved a human / resolved, 0–100. */
  humanResolutionRate: number;
  aiResolvedCount: number;
  humanResolvedCount: number;
  /** Volume split by channel. */
  byChannel: ChannelVolumeDto[];
  /** Conversation creation volume over time. */
  volumeSeries: TimeSeriesPointDto[];
}

export interface ChannelVolumeDto {
  channel: ChannelType;
  count: number;
  /** Share of the total, 0–100. */
  percentage: number;
}

export interface ResponseTimeMetricsDto {
  range: ResolvedRangeDto;
  /** Mean first-response latency, seconds. */
  avgFirstResponseSeconds: number;
  /** Median (p50) first-response latency, seconds. */
  p50FirstResponseSeconds: number;
  /** p90 first-response latency, seconds. */
  p90FirstResponseSeconds: number;
  /** Mean conversation resolution time, seconds. */
  avgResolutionSeconds: number;
  /** Number of conversations that contributed to the first-response stats. */
  sampleSize: number;
  /** Average first-response latency over time. */
  series: TimeSeriesPointDto[];
}

// ─────────────────────────────────────────────
// Revenue analytics
// ─────────────────────────────────────────────

export interface RevenueMetricsDto {
  range: ResolvedRangeDto;
  /** Gross revenue (sum of order totals) in paise. */
  grossRevenuePaise: number;
  /** Net revenue (gross minus refunds) in paise. */
  netRevenuePaise: number;
  /** Total refunds in paise. */
  refundsPaise: number;
  orderCount: number;
  /** Average order value in paise. */
  averageOrderValuePaise: number;
  /** Gross revenue over time, in paise. */
  revenueSeries: TimeSeriesPointDto[];
  /** Order count over time. */
  orderCountSeries: TimeSeriesPointDto[];
}

export interface TopProductDto {
  itemId: string;
  name: string;
  unitsSold: number;
  /** Revenue attributed to this product, in paise. */
  revenuePaise: number;
}

// ─────────────────────────────────────────────
// Client analytics
// ─────────────────────────────────────────────

export interface ClientAcquisitionMetricsDto {
  range: ResolvedRangeDto;
  /** Clients first seen within the range. */
  newClients: number;
  /** Clients first seen before the range but active within it. */
  returningClients: number;
  /** New / (new + returning), 0–100. */
  newClientShare: number;
  /** New-client acquisition split by first-touch channel. */
  byChannel: ChannelVolumeDto[];
  /** New clients over time. */
  acquisitionSeries: TimeSeriesPointDto[];
}

export interface ClientRetentionMetricsDto {
  range: ResolvedRangeDto;
  /** Clients considered active at the start of the window. */
  activeAtStart: number;
  /** Of those, how many did NOT interact during the window. */
  churnedClients: number;
  /** churnedClients / activeAtStart, 0–100. */
  churnRate: number;
  /** 100 - churnRate, 0–100. */
  retentionRate: number;
  /** Clients currently flagged HIGH or CRITICAL churn risk. */
  atRiskClients: number;
}

// ─────────────────────────────────────────────
// AI performance analytics
// ─────────────────────────────────────────────

export interface AutonomyMetricsDto {
  range: ResolvedRangeDto;
  totalDecisions: number;
  autoExecuted: number;
  sentForReview: number;
  escalated: number;
  overridden: number;
  expired: number;
  /** autoExecuted / totalDecisions, 0–100 — the primary GoSumo KPI. */
  autonomyRate: number;
  /** overridden / autoExecuted, 0–100 — how often humans correct the AI. */
  overrideRate: number;
  /** Autonomy rate over time. */
  autonomySeries: TimeSeriesPointDto[];
}

export interface ConfidenceDistributionDto {
  range: ResolvedRangeDto;
  totalDecisions: number;
  /** Mean confidence across all decisions, 0–100. */
  averageConfidence: number;
  /** 10 fixed deciles (0–10, 10–20, … 90–100), value = decision count. */
  histogram: ConfidenceBucketDto[];
  /** Counts grouped by autonomy band (ESCALATE / REVIEW / AUTO). */
  byBand: ConfidenceBandCountDto[];
}

export interface ConfidenceBucketDto {
  /** Lower bound of the bucket, inclusive, 0–100. */
  lower: number;
  /** Upper bound of the bucket, exclusive (100 inclusive for the top bucket). */
  upper: number;
  count: number;
}

export interface ConfidenceBandCountDto {
  band: ConfidenceBand;
  count: number;
  /** Share of the total, 0–100. */
  percentage: number;
}

export interface EscalationReasonDto {
  reason: string;
  count: number;
  /** Share of all escalations, 0–100. */
  percentage: number;
}

// ─────────────────────────────────────────────
// Team performance analytics
// ─────────────────────────────────────────────

export interface StaffMetricsDto {
  memberId: string;
  name: string;
  role: string;
  /** Conversations currently assigned to this member (any status). */
  assignedConversations: number;
  /** Conversations this member resolved within the range. */
  resolvedConversations: number;
  /** HITL tasks this member resolved within the range. */
  tasksResolved: number;
  /** Mean time-to-resolve for this member's tasks, seconds. */
  avgTaskResolutionSeconds: number;
}

// ─────────────────────────────────────────────
// Booking analytics
// ─────────────────────────────────────────────

export interface BookingMetricsDto {
  range: ResolvedRangeDto;
  total: number;
  confirmed: number;
  completed: number;
  cancelled: number;
  noShow: number;
  /** completed / total, 0–100. */
  completionRate: number;
  /** (cancelled + noShow) / total, 0–100. */
  cancellationRate: number;
  /** Bookings (by start time) over time. */
  series: TimeSeriesPointDto[];
}

// ─────────────────────────────────────────────
// Report export
// ─────────────────────────────────────────────

/** Which metric's time series to render as CSV. */
export enum ExportMetric {
  CONVERSATIONS = 'CONVERSATIONS',
  RESPONSE_TIME = 'RESPONSE_TIME',
  REVENUE = 'REVENUE',
  AUTONOMY = 'AUTONOMY',
  STAFF = 'STAFF',
}

export class ExportReportQueryDto extends AnalyticsRangeQueryDto {
  @ApiPropertyOptional({ enum: ExportMetric, default: ExportMetric.CONVERSATIONS })
  @IsOptional()
  @IsEnum(ExportMetric)
  metric?: ExportMetric;
}

export interface ExportedReportDto {
  filename: string;
  contentType: string;
  csv: string;
}

// ─────────────────────────────────────────────
// AI-generated narrative summary
// ─────────────────────────────────────────────

export interface AiSummaryDto {
  range: ResolvedRangeDto;
  /** Short, business-friendly narrative summarizing the period's performance. */
  summary: string;
  /** false when the LLM was unavailable and a deterministic fallback was used. */
  aiGenerated: boolean;
  modelId?: string;
  generatedAt: string;
}

// ─────────────────────────────────────────────
// Dashboard-shaped report DTOs
//
// The five endpoints below reshape one or more service metrics into the exact
// payload the dashboard renders. They were previously untyped, so the response
// contract lived only in the controller body and in `apps/web/src/lib/types.ts`
// — nothing checked the two against each other. These interfaces are the
// server-side half of that contract; field names mirror the frontend types
// (`DashboardMetrics`, `ConversationReport`, `RevenueReport`, `ClientReport`,
// `AutonomyReport`) one-for-one.
//
// Fields fixed at 0 / [] / {} are not yet sourced — the shape is stable and the
// dashboard renders an empty state for them.
// ─────────────────────────────────────────────

/** Inclusive period echoed on every dashboard-shaped report. */
export interface ReportPeriodDto {
  from: string;
  to: string;
}

export interface DashboardChannelDto {
  channelType: ChannelType;
  messageCount: number;
  conversationCount: number;
}

/** `GET /analytics/dashboard` — the "today" summary tile row. */
export interface DashboardMetricsDto {
  period: ReportPeriodDto;
  conversations: {
    total: number;
    open: number;
    resolved: number;
    escalated: number;
    avgResolutionTimeMs: number;
    avgFirstResponseTimeMs: number;
  };
  messages: {
    inbound: number;
    outbound: number;
    aiSent: number;
    humanSent: number;
  };
  ai: {
    /** 0–100. */
    autonomyRate: number;
    /** 0–100. */
    avgConfidence: number;
    autoExecuted: number;
    reviewed: number;
    escalated: number;
    /** 0–100. */
    approvalRate: number;
  };
  revenue: {
    /** Gross revenue today, in paise. */
    total: number;
    orders: number;
    payments: number;
    /** Average order value, in paise. */
    avgOrderValue: number;
  };
  clients: {
    total: number;
    newThisPeriod: number;
    activeThisPeriod: number;
    churnRisk: number;
  };
  channels: DashboardChannelDto[];
}

export interface ConversationSeriesPointDto {
  /** Bucket start (ISO-8601, UTC). */
  date: string;
  created: number;
  resolved: number;
  escalated: number;
  avgResolutionTimeMs: number;
}

export interface ConversationChannelBreakdownDto {
  channel: ChannelType;
  count: number;
  avgResolutionTimeMs: number;
}

export interface TopIntentDto {
  intent: string;
  count: number;
}

/** `GET /analytics/conversations` — the Conversations tab report. */
export interface ConversationReportDto {
  summary: {
    total: number;
    avgResolutionTimeMs: number;
    avgFirstResponseTimeMs: number;
  };
  timeSeries: ConversationSeriesPointDto[];
  channelBreakdown: ConversationChannelBreakdownDto[];
  topIntents: TopIntentDto[];
}

export interface RevenueSeriesPointDto {
  /** Bucket start (ISO-8601, UTC). */
  date: string;
  /** Gross revenue in the bucket, in paise. */
  revenue: number;
  orders: number;
  /** Refunds in the bucket, in paise. */
  refunds: number;
}

/** `GET /analytics/revenue` — the Revenue tab report. All amounts in paise. */
export interface RevenueReportDto {
  summary: {
    totalRevenue: number;
    totalOrders: number;
    avgOrderValue: number;
    totalRefunds: number;
    netRevenue: number;
  };
  timeSeries: RevenueSeriesPointDto[];
}

export interface AcquisitionSeriesPointDto {
  /** Bucket start (ISO-8601, UTC). */
  date: string;
  newClients: number;
}

export interface TopTagDto {
  tag: string;
  count: number;
}

/** `GET /analytics/clients` — the Clients tab report. */
export interface ClientReportDto {
  summary: {
    total: number;
    newClients: number;
    returning: number;
    /** Average lifetime value, in paise. */
    avgLtv: number;
    churnRiskHigh: number;
  };
  acquisitionTimeSeries: AcquisitionSeriesPointDto[];
  churnRiskBreakdown: { low: number; medium: number; high: number };
  /** Sentiment label → client count. */
  sentimentDistribution: Record<string, number>;
  topTags: TopTagDto[];
  /** Channel → client count. */
  channelPreferences: Record<string, number>;
}

export interface AutonomySeriesPointDto {
  /** Bucket start (ISO-8601, UTC). */
  date: string;
  /** 0–100. */
  autonomyRate: number;
  autoExecuted: number;
  reviewed: number;
  escalated: number;
}

export interface IntentAutonomyDto {
  intent: string;
  count: number;
  /** 0–100. */
  autonomyRate: number;
  /** 0–100. */
  avgConfidence: number;
}

/** A confidence decile rendered as a chart label, e.g. `"80-90"`. */
export interface ConfidenceBucketLabelDto {
  bucket: string;
  count: number;
}

export interface EscalationReasonCountDto {
  reason: string;
  count: number;
}

/** `GET /analytics/autonomy` — the AI Performance tab report. */
export interface AutonomyReportDto {
  summary: {
    /** 0–100. */
    autonomyRate: number;
    /** Change vs the preceding period, in percentage points. */
    trend: number;
    totalDecisions: number;
  };
  timeSeries: AutonomySeriesPointDto[];
  intentBreakdown: IntentAutonomyDto[];
  confidenceDistribution: ConfidenceBucketLabelDto[];
  topEscalationReasons: EscalationReasonCountDto[];
}
