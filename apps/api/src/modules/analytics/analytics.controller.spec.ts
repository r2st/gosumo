/**
 * AnalyticsController tests.
 *
 * Five handlers reshape service metrics into the exact payload the dashboard
 * renders (`/dashboard`, `/conversations`, `/revenue`, `/clients`,
 * `/autonomy`). That reshaping is the contract with `apps/web` — these tests
 * pin it, including the divide-by-zero guards and the `|| []` fallbacks that
 * keep an empty tenant from producing `undefined` in the UI.
 */

import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { ChannelType } from '@gosumo/shared';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsRangeQueryDto,
  ConfidenceBand,
  ExportMetric,
  ExportReportQueryDto,
  Granularity,
} from './dto';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

const RANGE = {
  from: '2026-07-01T00:00:00.000Z',
  to: '2026-08-01T00:00:00.000Z',
  granularity: Granularity.DAY,
};

const QUERY: AnalyticsRangeQueryDto = { from: RANGE.from, to: RANGE.to };

function emptyDashboardSummary(overrides: Record<string, number> = {}) {
  return {
    conversationsToday: 0,
    openConversations: 0,
    avgFirstResponseSecondsToday: 0,
    resolutionRateToday: 0,
    autonomyRateToday: 0,
    revenueTodayPaise: 0,
    ordersToday: 0,
    bookingsToday: 0,
    newClientsToday: 0,
    pendingTasks: 0,
    generatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

function makeServiceMock() {
  return {
    getDashboardSummary: jest.fn(),
    getConversationMetrics: jest.fn(),
    getResponseTimeMetrics: jest.fn(),
    getRevenueMetrics: jest.fn(),
    getTopProducts: jest.fn(),
    getClientAcquisitionMetrics: jest.fn(),
    getClientRetentionMetrics: jest.fn(),
    getAutonomyMetrics: jest.fn(),
    getConfidenceDistribution: jest.fn(),
    getEscalationReasons: jest.fn(),
    getStaffMetrics: jest.fn(),
    getBookingMetrics: jest.fn(),
    exportReport: jest.fn(),
    getAiSummary: jest.fn(),
  };
}

type ServiceMock = ReturnType<typeof makeServiceMock>;

describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  let service: ServiceMock;

  beforeEach(async () => {
    service = makeServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [{ provide: AnalyticsService, useValue: service }],
    }).compile();

    controller = module.get(AnalyticsController);
  });

  // ─────────────────────────────────────────────
  // /dashboard
  // ─────────────────────────────────────────────

  describe('getDashboard', () => {
    it('derives resolved count and AOV from the summary', async () => {
      service.getDashboardSummary.mockResolvedValue(
        emptyDashboardSummary({
          conversationsToday: 40,
          openConversations: 7,
          resolutionRateToday: 75,
          avgFirstResponseSecondsToday: 42,
          autonomyRateToday: 88,
          revenueTodayPaise: 1_000_00,
          ordersToday: 4,
          newClientsToday: 3,
        }),
      );

      const result = await controller.getDashboard(BUSINESS_ID);

      expect(service.getDashboardSummary).toHaveBeenCalledWith(BUSINESS_ID);
      expect(result.conversations).toEqual({
        total: 40,
        open: 7,
        resolved: 30, // 40 × 75%
        escalated: 0,
        avgResolutionTimeMs: 0,
        avgFirstResponseTimeMs: 42_000, // seconds → ms
      });
      expect(result.revenue).toEqual({
        total: 1_000_00,
        orders: 4,
        payments: 0,
        avgOrderValue: 25_000, // paise, integer
      });
      expect(result.ai.autonomyRate).toBe(88);
      expect(result.clients.newThisPeriod).toBe(3);
      expect(result.channels).toEqual([]);
    });

    it('returns zeros instead of NaN for a tenant with no activity today', async () => {
      service.getDashboardSummary.mockResolvedValue(emptyDashboardSummary());

      const result = await controller.getDashboard(BUSINESS_ID);

      expect(result.conversations.resolved).toBe(0);
      expect(result.revenue.avgOrderValue).toBe(0);
    });

    it('reports the period as start-of-UTC-day → now', async () => {
      service.getDashboardSummary.mockResolvedValue(emptyDashboardSummary());

      const result = await controller.getDashboard(BUSINESS_ID);

      const from = new Date(result.period.from);
      expect(from.getUTCHours()).toBe(0);
      expect(from.getUTCMinutes()).toBe(0);
      expect(from.getUTCSeconds()).toBe(0);
      expect(from.getUTCMilliseconds()).toBe(0);
      expect(new Date(result.period.to).getTime()).toBeGreaterThanOrEqual(from.getTime());
    });
  });

  // ─────────────────────────────────────────────
  // /conversations
  // ─────────────────────────────────────────────

  describe('getConversations', () => {
    it('maps the volume series and channel split into the report shape', async () => {
      service.getConversationMetrics.mockResolvedValue({
        range: RANGE,
        total: 12,
        volumeSeries: [
          { date: '2026-07-01T00:00:00.000Z', value: 5 },
          { date: '2026-07-02T00:00:00.000Z', value: 7 },
        ],
        byChannel: [
          { channel: ChannelType.WHATSAPP, count: 9, percentage: 75 },
          { channel: ChannelType.WEB_CHAT, count: 3, percentage: 25 },
        ],
      });

      const result = await controller.getConversations(BUSINESS_ID, QUERY);

      expect(service.getConversationMetrics).toHaveBeenCalledWith(BUSINESS_ID, QUERY);
      expect(result.summary.total).toBe(12);
      expect(result.timeSeries).toEqual([
        {
          date: '2026-07-01T00:00:00.000Z',
          created: 5,
          resolved: 0,
          escalated: 0,
          avgResolutionTimeMs: 0,
        },
        {
          date: '2026-07-02T00:00:00.000Z',
          created: 7,
          resolved: 0,
          escalated: 0,
          avgResolutionTimeMs: 0,
        },
      ]);
      expect(result.channelBreakdown).toEqual([
        { channel: ChannelType.WHATSAPP, count: 9, avgResolutionTimeMs: 0 },
        { channel: ChannelType.WEB_CHAT, count: 3, avgResolutionTimeMs: 0 },
      ]);
      expect(result.topIntents).toEqual([]);
    });

    it('returns empty arrays for a tenant with no conversations', async () => {
      service.getConversationMetrics.mockResolvedValue({
        range: RANGE,
        total: 0,
        volumeSeries: [],
        byChannel: [],
      });

      const result = await controller.getConversations(BUSINESS_ID, QUERY);

      expect(result.timeSeries).toEqual([]);
      expect(result.channelBreakdown).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────
  // /revenue
  // ─────────────────────────────────────────────

  describe('getRevenue', () => {
    it('zips the revenue and order-count series by index', async () => {
      service.getRevenueMetrics.mockResolvedValue({
        range: RANGE,
        grossRevenuePaise: 500_00,
        netRevenuePaise: 450_00,
        refundsPaise: 50_00,
        orderCount: 5,
        averageOrderValuePaise: 100_00,
        revenueSeries: [
          { date: '2026-07-01T00:00:00.000Z', value: 200_00 },
          { date: '2026-07-02T00:00:00.000Z', value: 300_00 },
        ],
        orderCountSeries: [
          { date: '2026-07-01T00:00:00.000Z', value: 2 },
          { date: '2026-07-02T00:00:00.000Z', value: 3 },
        ],
      });

      const result = await controller.getRevenue(BUSINESS_ID, QUERY);

      expect(result.summary).toEqual({
        totalRevenue: 500_00,
        totalOrders: 5,
        avgOrderValue: 100_00,
        totalRefunds: 50_00,
        netRevenue: 450_00,
      });
      expect(result.timeSeries).toEqual([
        { date: '2026-07-01T00:00:00.000Z', revenue: 200_00, orders: 2, refunds: 0 },
        { date: '2026-07-02T00:00:00.000Z', revenue: 300_00, orders: 3, refunds: 0 },
      ]);
    });

    it('falls back to zero orders when the order series is shorter or missing', async () => {
      service.getRevenueMetrics.mockResolvedValue({
        range: RANGE,
        grossRevenuePaise: 100_00,
        netRevenuePaise: 100_00,
        refundsPaise: 0,
        orderCount: 1,
        averageOrderValuePaise: 100_00,
        revenueSeries: [
          { date: '2026-07-01T00:00:00.000Z', value: 100_00 },
          { date: '2026-07-02T00:00:00.000Z', value: 0 },
        ],
        orderCountSeries: undefined,
      });

      const result = await controller.getRevenue(BUSINESS_ID, QUERY);

      expect(result.timeSeries.map((p) => p.orders)).toEqual([0, 0]);
    });
  });

  // ─────────────────────────────────────────────
  // /clients (aggregated)
  // ─────────────────────────────────────────────

  describe('getClients', () => {
    it('combines acquisition and retention into the Clients tab report', async () => {
      service.getClientAcquisitionMetrics.mockResolvedValue({
        range: RANGE,
        newClients: 10,
        returningClients: 30,
        newClientShare: 25,
        byChannel: [
          { channel: ChannelType.WHATSAPP, count: 8, percentage: 80 },
          { channel: ChannelType.EMAIL, count: 2, percentage: 20 },
        ],
        acquisitionSeries: [{ date: '2026-07-01T00:00:00.000Z', value: 10 }],
      });
      service.getClientRetentionMetrics.mockResolvedValue({
        range: RANGE,
        activeAtStart: 40,
        churnedClients: 5,
        churnRate: 12.5,
        retentionRate: 87.5,
        atRiskClients: 7,
      });

      const result = await controller.getClients(BUSINESS_ID, QUERY);

      expect(result.summary).toEqual({
        total: 40,
        newClients: 10,
        returning: 30,
        avgLtv: 0,
        churnRiskHigh: 7,
      });
      expect(result.acquisitionTimeSeries).toEqual([
        { date: '2026-07-01T00:00:00.000Z', newClients: 10 },
      ]);
      expect(result.churnRiskBreakdown).toEqual({ low: 28, medium: 5, high: 7 });
      expect(result.channelPreferences).toEqual({ WHATSAPP: 8, EMAIL: 2 });
      expect(result.sentimentDistribution).toEqual({});
      expect(result.topTags).toEqual([]);
    });

    it('floors the low-risk bucket at zero when churn + at-risk exceed the client count', async () => {
      service.getClientAcquisitionMetrics.mockResolvedValue({
        range: RANGE,
        newClients: 1,
        returningClients: 1,
        newClientShare: 50,
        byChannel: [],
        acquisitionSeries: [],
      });
      service.getClientRetentionMetrics.mockResolvedValue({
        range: RANGE,
        activeAtStart: 20,
        churnedClients: 9,
        churnRate: 45,
        retentionRate: 55,
        atRiskClients: 6,
      });

      const result = await controller.getClients(BUSINESS_ID, QUERY);

      expect(result.churnRiskBreakdown.low).toBe(0);
    });

    it('tolerates a service that omits the optional collections', async () => {
      service.getClientAcquisitionMetrics.mockResolvedValue({
        range: RANGE,
        newClients: 0,
        returningClients: 0,
        newClientShare: 0,
        byChannel: undefined,
        acquisitionSeries: undefined,
      });
      service.getClientRetentionMetrics.mockResolvedValue({
        range: RANGE,
        activeAtStart: 0,
        churnedClients: 0,
        churnRate: 0,
        retentionRate: 0,
        atRiskClients: 0,
      });

      const result = await controller.getClients(BUSINESS_ID, QUERY);

      expect(result.acquisitionTimeSeries).toEqual([]);
      expect(result.channelPreferences).toEqual({});
    });
  });

  // ─────────────────────────────────────────────
  // /autonomy (aggregated)
  // ─────────────────────────────────────────────

  describe('getAutonomyAggregated', () => {
    it('renders confidence deciles as chart labels and keeps escalation reasons', async () => {
      service.getAutonomyMetrics.mockResolvedValue({
        range: RANGE,
        totalDecisions: 100,
        autoExecuted: 80,
        sentForReview: 15,
        escalated: 5,
        overridden: 2,
        expired: 0,
        autonomyRate: 80,
        overrideRate: 2.5,
        autonomySeries: [{ date: '2026-07-01T00:00:00.000Z', value: 80 }],
      });
      service.getConfidenceDistribution.mockResolvedValue({
        range: RANGE,
        totalDecisions: 100,
        averageConfidence: 87,
        histogram: [
          { lower: 80, upper: 90, count: 30 },
          { lower: 90, upper: 100, count: 50 },
        ],
        byBand: [{ band: ConfidenceBand.AUTO, count: 80, percentage: 80 }],
      });
      service.getEscalationReasons.mockResolvedValue([
        { reason: 'LOW_CONFIDENCE', count: 4, percentage: 80 },
        { reason: 'CUSTOMER_REQUEST', count: 1, percentage: 20 },
      ]);

      const result = await controller.getAutonomyAggregated(BUSINESS_ID, QUERY);

      expect(result.summary).toEqual({ autonomyRate: 80, trend: 0, totalDecisions: 100 });
      expect(result.timeSeries).toEqual([
        {
          date: '2026-07-01T00:00:00.000Z',
          autonomyRate: 80,
          autoExecuted: 0,
          reviewed: 0,
          escalated: 0,
        },
      ]);
      expect(result.confidenceDistribution).toEqual([
        { bucket: '80-90', count: 30 },
        { bucket: '90-100', count: 50 },
      ]);
      expect(result.topEscalationReasons).toEqual([
        { reason: 'LOW_CONFIDENCE', count: 4 },
        { reason: 'CUSTOMER_REQUEST', count: 1 },
      ]);
      expect(result.intentBreakdown).toEqual([]);
    });

    it('tolerates a service that omits the optional collections', async () => {
      service.getAutonomyMetrics.mockResolvedValue({
        range: RANGE,
        totalDecisions: 0,
        autoExecuted: 0,
        sentForReview: 0,
        escalated: 0,
        overridden: 0,
        expired: 0,
        autonomyRate: 0,
        overrideRate: 0,
        autonomySeries: undefined,
      });
      service.getConfidenceDistribution.mockResolvedValue({
        range: RANGE,
        totalDecisions: 0,
        averageConfidence: 0,
        histogram: undefined,
        byBand: [],
      });
      service.getEscalationReasons.mockResolvedValue(undefined);

      const result = await controller.getAutonomyAggregated(BUSINESS_ID, QUERY);

      expect(result.timeSeries).toEqual([]);
      expect(result.confidenceDistribution).toEqual([]);
      expect(result.topEscalationReasons).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────
  // Pass-through handlers
  // ─────────────────────────────────────────────

  describe('pass-through handlers', () => {
    const PASS_THROUGHS: Array<[keyof AnalyticsController, keyof ServiceMock]> = [
      ['getResponseTimes', 'getResponseTimeMetrics'],
      ['getClientAcquisition', 'getClientAcquisitionMetrics'],
      ['getClientRetention', 'getClientRetentionMetrics'],
      ['getAutonomy', 'getAutonomyMetrics'],
      ['getConfidence', 'getConfidenceDistribution'],
      ['getEscalations', 'getEscalationReasons'],
      ['getTeam', 'getStaffMetrics'],
      ['getBookings', 'getBookingMetrics'],
      ['getAiSummary', 'getAiSummary'],
    ];

    it.each(PASS_THROUGHS)(
      '%s forwards the tenant id and query to %s',
      async (handler, method) => {
        const sentinel = { marker: handler };
        service[method].mockResolvedValue(sentinel);

        const call = controller[handler] as (
          t: string,
          q: AnalyticsRangeQueryDto,
        ) => Promise<unknown>;
        const result = await call.call(controller, BUSINESS_ID, QUERY);

        expect(service[method]).toHaveBeenCalledWith(BUSINESS_ID, QUERY);
        expect(result).toBe(sentinel);
      },
    );

    it('getTopProducts forwards the limit query', async () => {
      service.getTopProducts.mockResolvedValue([]);

      await controller.getTopProducts(BUSINESS_ID, { ...QUERY, limit: 5 });

      expect(service.getTopProducts).toHaveBeenCalledWith(BUSINESS_ID, {
        ...QUERY,
        limit: 5,
      });
    });
  });

  // ─────────────────────────────────────────────
  // CSV export
  // ─────────────────────────────────────────────

  describe('exportReport', () => {
    it('streams the CSV with download headers', async () => {
      service.exportReport.mockResolvedValue({
        filename: 'conversations-2026-07.csv',
        contentType: 'text/csv',
        csv: 'date,created\n2026-07-01,5\n',
      });
      const res = { setHeader: jest.fn(), send: jest.fn() } as unknown as Response;
      const query: ExportReportQueryDto = { ...QUERY, metric: ExportMetric.CONVERSATIONS };

      await controller.exportReport(BUSINESS_ID, query, res);

      expect(service.exportReport).toHaveBeenCalledWith(BUSINESS_ID, query);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="conversations-2026-07.csv"',
      );
      expect(res.send).toHaveBeenCalledWith('date,created\n2026-07-01,5\n');
    });
  });
});
