import { Controller, Get, Query, Res, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { AnalyticsService } from './analytics.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import {
  AiSummaryDto,
  AnalyticsRangeQueryDto,
  AnalyticsTopQueryDto,
  AutonomyMetricsDto,
  BookingMetricsDto,
  ClientAcquisitionMetricsDto,
  ClientRetentionMetricsDto,
  ConfidenceDistributionDto,
  ConversationMetricsDto,
  DashboardSummaryDto,
  EscalationReasonDto,
  ExportReportQueryDto,
  ResponseTimeMetricsDto,
  RevenueMetricsDto,
  StaffMetricsDto,
  TopProductDto,
} from './dto';

/**
 * AnalyticsController — read-only REST endpoints serving dashboard metrics.
 *
 * All routes are protected by the global JwtAuthGuard. The @TenantId()
 * decorator supplies the businessId from the JWT-populated request context —
 * every query is tenant-scoped at the repository layer.
 *
 * Routes (all GET, all under /analytics):
 *   /dashboard                — high-level "today" summary (Redis-cached 5m)
 *   /conversations            — volume, resolution, AI-vs-human split, by channel
 *   /conversations/response-times — first-response + resolution latency
 *   /revenue                  — gross/net revenue, AOV, time series
 *   /revenue/top-products     — best sellers by revenue
 *   /clients/acquisition      — new vs returning, by channel
 *   /clients/retention        — churn & retention rate
 *   /ai/autonomy              — autonomous resolution rate (primary KPI)
 *   /ai/confidence            — confidence histogram + bands
 *   /ai/escalations           — escalation reason breakdown
 *   /team                     — per-agent productivity
 *   /bookings                 — booking volume & completion
 */
@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  // ─────────────────────────────────────────────
  // Dashboard
  // ─────────────────────────────────────────────

  @Get('dashboard')
  @ApiOperation({ summary: 'Dashboard summary for today (cached 5 minutes)' })
  @ApiResponse({ status: 200, description: 'Dashboard summary metrics' })
  async getDashboard(@TenantId() tenantId: string): Promise<any> {
    const s = await this.analyticsService.getDashboardSummary(tenantId);
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return {
      period: { from: startOfDay.toISOString(), to: now.toISOString() },
      conversations: {
        total: s.conversationsToday,
        open: s.openConversations,
        resolved: s.conversationsToday > 0 ? Math.round(s.conversationsToday * s.resolutionRateToday / 100) : 0,
        escalated: 0,
        avgResolutionTimeMs: 0,
        avgFirstResponseTimeMs: s.avgFirstResponseSecondsToday * 1000,
      },
      messages: {
        inbound: 0,
        outbound: 0,
        aiSent: 0,
        humanSent: 0,
      },
      ai: {
        autonomyRate: s.autonomyRateToday,
        avgConfidence: 0,
        autoExecuted: 0,
        reviewed: 0,
        escalated: 0,
        approvalRate: 0,
      },
      revenue: {
        total: s.revenueTodayPaise,
        orders: s.ordersToday,
        payments: 0,
        avgOrderValue: s.ordersToday > 0 ? Math.round(s.revenueTodayPaise / s.ordersToday) : 0,
      },
      clients: {
        total: 0,
        newThisPeriod: s.newClientsToday,
        activeThisPeriod: 0,
        churnRisk: 0,
      },
      channels: [],
    };
  }

  // ─────────────────────────────────────────────
  // Conversations
  // ─────────────────────────────────────────────

  @Get('conversations')
  @ApiOperation({ summary: 'Conversation analytics: volume, resolution, by channel' })
  @ApiResponse({ status: 200, description: 'Conversation metrics' })
  @ApiResponse({ status: 422, description: 'Date range exceeds 365 days' })
  async getConversations(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<any> {
    const m = await this.analyticsService.getConversationMetrics(tenantId, query);
    return {
      summary: {
        total: m.total,
        avgResolutionTimeMs: 0,
        avgFirstResponseTimeMs: 0,
      },
      timeSeries: m.volumeSeries.map((p: any) => ({
        date: p.date,
        created: p.value,
        resolved: 0,
        escalated: 0,
        avgResolutionTimeMs: 0,
      })),
      channelBreakdown: m.byChannel.map((c: any) => ({
        channel: c.channel,
        count: c.count,
        avgResolutionTimeMs: 0,
      })),
      topIntents: [],
    };
  }

  @Get('conversations/response-times')
  @ApiOperation({ summary: 'First-response and resolution latency metrics' })
  @ApiResponse({ status: 200, description: 'Response-time metrics' })
  async getResponseTimes(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<ResponseTimeMetricsDto> {
    return this.analyticsService.getResponseTimeMetrics(tenantId, query);
  }

  // ─────────────────────────────────────────────
  // Revenue
  // ─────────────────────────────────────────────

  @Get('revenue')
  @ApiOperation({ summary: 'Revenue analytics: gross/net, AOV, time series (paise)' })
  @ApiResponse({ status: 200, description: 'Revenue metrics' })
  async getRevenue(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<any> {
    const m = await this.analyticsService.getRevenueMetrics(tenantId, query);
    return {
      summary: {
        totalRevenue: m.grossRevenuePaise,
        totalOrders: m.orderCount,
        avgOrderValue: m.averageOrderValuePaise,
        totalRefunds: m.refundsPaise,
        netRevenue: m.netRevenuePaise,
      },
      timeSeries: m.revenueSeries.map((p: any, i: number) => ({
        date: p.date,
        revenue: p.value,
        orders: m.orderCountSeries?.[i]?.value ?? 0,
        refunds: 0,
      })),
    };
  }

  @Get('revenue/top-products')
  @ApiOperation({ summary: 'Top products by revenue' })
  @ApiResponse({ status: 200, description: 'Ranked product list' })
  async getTopProducts(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsTopQueryDto,
  ): Promise<TopProductDto[]> {
    return this.analyticsService.getTopProducts(tenantId, query);
  }

  // ─────────────────────────────────────────────
  // Clients
  // ─────────────────────────────────────────────

  @Get('clients/acquisition')
  @ApiOperation({ summary: 'Client acquisition: new vs returning, by channel' })
  @ApiResponse({ status: 200, description: 'Acquisition metrics' })
  async getClientAcquisition(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<ClientAcquisitionMetricsDto> {
    return this.analyticsService.getClientAcquisitionMetrics(tenantId, query);
  }

  @Get('clients/retention')
  @ApiOperation({ summary: 'Client retention and churn rate' })
  @ApiResponse({ status: 200, description: 'Retention metrics' })
  async getClientRetention(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<ClientRetentionMetricsDto> {
    return this.analyticsService.getClientRetentionMetrics(tenantId, query);
  }

  // ─────────────────────────────────────────────
  // AI performance
  // ─────────────────────────────────────────────

  @Get('ai/autonomy')
  @ApiOperation({ summary: 'AI autonomy rate — the primary GoSumo KPI' })
  @ApiResponse({ status: 200, description: 'Autonomy metrics' })
  async getAutonomy(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<AutonomyMetricsDto> {
    return this.analyticsService.getAutonomyMetrics(tenantId, query);
  }

  @Get('ai/confidence')
  @ApiOperation({ summary: 'AI confidence distribution (histogram + bands)' })
  @ApiResponse({ status: 200, description: 'Confidence distribution' })
  async getConfidence(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<ConfidenceDistributionDto> {
    return this.analyticsService.getConfidenceDistribution(tenantId, query);
  }

  @Get('ai/escalations')
  @ApiOperation({ summary: 'Escalation reason breakdown' })
  @ApiResponse({ status: 200, description: 'Escalation reasons' })
  async getEscalations(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<EscalationReasonDto[]> {
    return this.analyticsService.getEscalationReasons(tenantId, query);
  }

  // ─────────────────────────────────────────────
  // Team performance
  // ─────────────────────────────────────────────

  @Get('team')
  @ApiOperation({ summary: 'Per-agent productivity metrics' })
  @ApiResponse({ status: 200, description: 'Staff metrics' })
  async getTeam(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<StaffMetricsDto[]> {
    return this.analyticsService.getStaffMetrics(tenantId, query);
  }

  // ─────────────────────────────────────────────
  // Bookings
  // ─────────────────────────────────────────────

  @Get('bookings')
  @ApiOperation({ summary: 'Booking volume, completion and cancellation rates' })
  @ApiResponse({ status: 200, description: 'Booking metrics' })
  async getBookings(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<BookingMetricsDto> {
    return this.analyticsService.getBookingMetrics(tenantId, query);
  }

  // ─────────────────────────────────────────────
  // Reports (export + AI summary)
  // ─────────────────────────────────────────────

  @Get('reports/export')
  @ApiOperation({ summary: 'Export a metric\'s time series as CSV' })
  @ApiResponse({ status: 200, description: 'CSV file' })
  @ApiResponse({ status: 422, description: 'Date range exceeds 365 days' })
  async exportReport(
    @TenantId() tenantId: string,
    @Query() query: ExportReportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const report = await this.analyticsService.exportReport(tenantId, query);
    res.setHeader('Content-Type', `${report.contentType}; charset=utf-8`);
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.send(report.csv);
  }

  @Get('reports/summary')
  @ApiOperation({ summary: 'AI-generated narrative summary of the period\'s performance' })
  @ApiResponse({ status: 200, description: 'Narrative summary (falls back to a deterministic one if the LLM is unavailable)' })
  async getAiSummary(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<AiSummaryDto> {
    return this.analyticsService.getAiSummary(tenantId, query);
  }

  // ─────────────────────────────────────────────
  // Aggregated endpoints (frontend convenience)
  // ─────────────────────────────────────────────

  @Get("clients")
  @ApiOperation({ summary: "Aggregated client analytics for the Clients tab" })
  @ApiResponse({ status: 200, description: "Client report" })
  async getClients(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<any> {
    const [acq, ret] = await Promise.all([
      this.analyticsService.getClientAcquisitionMetrics(tenantId, query),
      this.analyticsService.getClientRetentionMetrics(tenantId, query),
    ]);
    return {
      summary: {
        total: acq.newClients + acq.returningClients,
        newClients: acq.newClients,
        returning: acq.returningClients,
        avgLtv: 0,
        churnRiskHigh: ret.atRiskClients,
      },
      acquisitionTimeSeries: (acq.acquisitionSeries || []).map((p: any) => ({
        date: p.date,
        newClients: p.value,
      })),
      churnRiskBreakdown: {
        low: Math.max(0, (acq.newClients + acq.returningClients) - ret.churnedClients - ret.atRiskClients),
        medium: ret.churnedClients,
        high: ret.atRiskClients,
      },
      sentimentDistribution: {},
      topTags: [],
      channelPreferences: (acq.byChannel || []).reduce((acc: any, c: any) => {
        acc[c.channel] = c.count;
        return acc;
      }, {}),
    };
  }

  @Get("autonomy")
  @ApiOperation({ summary: "Aggregated AI autonomy report for the AI Performance tab" })
  @ApiResponse({ status: 200, description: "Autonomy report" })
  async getAutonomyAggregated(
    @TenantId() tenantId: string,
    @Query() query: AnalyticsRangeQueryDto,
  ): Promise<any> {
    const [autonomy, confidence, escalations] = await Promise.all([
      this.analyticsService.getAutonomyMetrics(tenantId, query),
      this.analyticsService.getConfidenceDistribution(tenantId, query),
      this.analyticsService.getEscalationReasons(tenantId, query),
    ]);
    return {
      summary: {
        autonomyRate: autonomy.autonomyRate,
        trend: 0,
        totalDecisions: autonomy.totalDecisions,
      },
      timeSeries: (autonomy.autonomySeries || []).map((p: any) => ({
        date: p.date,
        autonomyRate: p.value,
        autoExecuted: 0,
        reviewed: 0,
        escalated: 0,
      })),
      intentBreakdown: [],
      confidenceDistribution: (confidence.histogram || []).map((b: any) => ({
        bucket: b.lower + "-" + b.upper,
        count: b.count,
      })),
      topEscalationReasons: (escalations || []).map((e: any) => ({
        reason: e.reason,
        count: e.count,
      })),
    };
  }

}
