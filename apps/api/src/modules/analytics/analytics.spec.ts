import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { ChannelType } from '@gosumo/shared';
import { AnalyticsService } from './analytics.service';
import { AnalyticsRepository } from './analytics.repository';
import { ANALYTICS_CACHE, AnalyticsCache } from './analytics.cache';
import { Granularity } from './dto';

// ─────────────────────────────────────────────
// Test constants
// ─────────────────────────────────────────────

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_BUSINESS_ID = '99999999-9999-9999-9999-999999999999';
const FROM = '2026-06-01T00:00:00.000Z';
const TO = '2026-06-15T00:00:00.000Z';

// ─────────────────────────────────────────────
// Mock builders
// ─────────────────────────────────────────────

type RepoMock = jest.Mocked<AnalyticsRepository>;

function makeRepositoryMock(): RepoMock {
  return {
    getConversationCounts: jest.fn(),
    getConversationVolumeByChannel: jest.fn(),
    getConversationVolumeSeries: jest.fn(),
    countOpenConversations: jest.fn(),
    getResponseTimeStats: jest.fn(),
    getResponseTimeSeries: jest.fn(),
    getAvgResolutionSeconds: jest.fn(),
    getAiDecisionCounts: jest.fn(),
    getAutonomySeries: jest.fn(),
    getConfidenceStats: jest.fn(),
    getEscalationReasons: jest.fn(),
    getRevenueSummary: jest.fn(),
    getRevenueSeries: jest.fn(),
    getOrderCountSeries: jest.fn(),
    getTopProducts: jest.fn(),
    countNewClients: jest.fn(),
    countReturningClients: jest.fn(),
    getAcquisitionByChannel: jest.fn(),
    getAcquisitionSeries: jest.fn(),
    getRetentionStats: jest.fn(),
    getBookingCounts: jest.fn(),
    getBookingSeries: jest.fn(),
    getStaffMetrics: jest.fn(),
    countPendingTasks: jest.fn(),
    countBookings: jest.fn(),
  } as unknown as RepoMock;
}

function makeCacheMock(): jest.Mocked<AnalyticsCache> {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
}

// ─────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let repo: RepoMock;
  let cache: jest.Mocked<AnalyticsCache>;

  beforeEach(async () => {
    repo = makeRepositoryMock();
    cache = makeCacheMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: AnalyticsRepository, useValue: repo },
        { provide: ANALYTICS_CACHE, useValue: cache },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  // ───────────────────────────────────────────
  // resolveRange
  // ───────────────────────────────────────────

  describe('resolveRange', () => {
    it('defaults to a trailing 30-day DAY-granularity window', () => {
      const range = service.resolveRange({});
      const spanDays = (range.to.getTime() - range.from.getTime()) / (24 * 60 * 60 * 1000);
      expect(Math.round(spanDays)).toBe(30);
      expect(range.granularity).toBe(Granularity.DAY);
    });

    it('honours explicit from/to/granularity', () => {
      const range = service.resolveRange({ from: FROM, to: TO, granularity: Granularity.WEEK });
      expect(range.from.toISOString()).toBe(FROM);
      expect(range.to.toISOString()).toBe(TO);
      expect(range.granularity).toBe(Granularity.WEEK);
    });

    it('throws BadRequest when from >= to', () => {
      expect(() => service.resolveRange({ from: TO, to: FROM })).toThrow(BadRequestException);
    });

    it('throws BadRequest on an unparseable date', () => {
      expect(() => service.resolveRange({ from: 'not-a-date', to: TO })).toThrow(
        BadRequestException,
      );
    });

    it('throws 422 DATE_RANGE_TOO_LARGE beyond 365 days', () => {
      expect(() =>
        service.resolveRange({ from: '2024-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }),
      ).toThrow(UnprocessableEntityException);
    });

    it('allows exactly 365 days', () => {
      expect(() =>
        service.resolveRange({ from: '2025-01-01T00:00:00.000Z', to: '2025-12-31T00:00:00.000Z' }),
      ).not.toThrow();
    });
  });

  // ───────────────────────────────────────────
  // Dashboard summary (caching)
  // ───────────────────────────────────────────

  describe('getDashboardSummary', () => {
    function stubDashboardRepo(): void {
      repo.getConversationCounts.mockResolvedValue({
        total: 10,
        resolved: 7,
        open: 2,
        pendingHuman: 1,
        escalated: 0,
        snoozed: 0,
        aiResolved: 5,
        humanResolved: 2,
      });
      repo.getResponseTimeStats.mockResolvedValue({
        avgSeconds: 42.5,
        p50Seconds: 30,
        p90Seconds: 80,
        sampleSize: 8,
      });
      repo.getAiDecisionCounts.mockResolvedValue({
        total: 20,
        autoExecuted: 16,
        sentForReview: 3,
        escalated: 1,
        overriddenByHuman: 0,
        expired: 0,
        overridden: 2,
      });
      repo.getRevenueSummary.mockResolvedValue({
        grossRevenueRupees: 1500.5,
        refundsRupees: 0,
        orderCount: 3,
      });
      repo.countNewClients.mockResolvedValue(4);
      repo.countBookings.mockResolvedValue(6);
      repo.countOpenConversations.mockResolvedValue(9);
      repo.countPendingTasks.mockResolvedValue(5);
    }

    it('computes a live summary on cache miss and re-caches it', async () => {
      stubDashboardRepo();

      const summary = await service.getDashboardSummary(BUSINESS_ID);

      expect(summary.conversationsToday).toBe(10);
      expect(summary.openConversations).toBe(9);
      expect(summary.avgFirstResponseSecondsToday).toBe(42.5);
      expect(summary.resolutionRateToday).toBe(70); // 7/10
      expect(summary.autonomyRateToday).toBe(80); // 16/20
      expect(summary.revenueTodayPaise).toBe(150050); // 1500.50 → paise
      expect(summary.ordersToday).toBe(3);
      expect(summary.bookingsToday).toBe(6);
      expect(summary.newClientsToday).toBe(4);
      expect(summary.pendingTasks).toBe(5);

      // Re-cache happened with the dashboard key + TTL.
      expect(cache.set).toHaveBeenCalledWith(
        `gosumo:${BUSINESS_ID}:analytics:dashboard`,
        expect.any(String),
        300,
      );
    });

    it('returns the cached payload without hitting the repository', async () => {
      const cached = {
        conversationsToday: 99,
        openConversations: 0,
        avgFirstResponseSecondsToday: 0,
        resolutionRateToday: 0,
        autonomyRateToday: 0,
        revenueTodayPaise: 0,
        ordersToday: 0,
        bookingsToday: 0,
        newClientsToday: 0,
        pendingTasks: 0,
        generatedAt: '2026-06-27T00:00:00.000Z',
      };
      cache.get.mockResolvedValueOnce(JSON.stringify(cached));

      const summary = await service.getDashboardSummary(BUSINESS_ID);

      expect(summary.conversationsToday).toBe(99);
      expect(repo.getConversationCounts).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('recomputes when the cached payload is corrupt', async () => {
      cache.get.mockResolvedValueOnce('{not-json');
      stubDashboardRepo();

      const summary = await service.getDashboardSummary(BUSINESS_ID);

      expect(summary.conversationsToday).toBe(10);
      expect(repo.getConversationCounts).toHaveBeenCalled();
    });

    it('falls back to a live query when the cache read throws', async () => {
      cache.get.mockRejectedValueOnce(new Error('redis down'));
      stubDashboardRepo();

      const summary = await service.getDashboardSummary(BUSINESS_ID);

      expect(summary.conversationsToday).toBe(10);
    });

    it('does not throw when the cache write fails', async () => {
      cache.set.mockRejectedValueOnce(new Error('redis down'));
      stubDashboardRepo();

      await expect(service.getDashboardSummary(BUSINESS_ID)).resolves.toBeDefined();
    });

    it('scopes the cache key to the tenant', async () => {
      stubDashboardRepo();
      await service.getDashboardSummary(OTHER_BUSINESS_ID);
      expect(cache.get).toHaveBeenCalledWith(
        `gosumo:${OTHER_BUSINESS_ID}:analytics:dashboard`,
      );
    });

    it('reports a 0 autonomy rate when there are no decisions, never NaN', async () => {
      stubDashboardRepo();
      repo.getAiDecisionCounts.mockResolvedValue({
        total: 0,
        autoExecuted: 0,
        sentForReview: 0,
        escalated: 0,
        overriddenByHuman: 0,
        expired: 0,
        overridden: 0,
      });

      const summary = await service.getDashboardSummary(BUSINESS_ID);
      expect(summary.autonomyRateToday).toBe(0);
    });
  });

  // ───────────────────────────────────────────
  // Conversation metrics
  // ───────────────────────────────────────────

  describe('getConversationMetrics', () => {
    it('computes rates, channel shares, and a gap-filled series', async () => {
      repo.getConversationCounts.mockResolvedValue({
        total: 100,
        resolved: 80,
        open: 15,
        pendingHuman: 3,
        escalated: 2,
        snoozed: 0,
        aiResolved: 60,
        humanResolved: 20,
      });
      repo.getConversationVolumeByChannel.mockResolvedValue([
        { channel: ChannelType.WHATSAPP, count: 70 },
        { channel: ChannelType.INSTAGRAM, count: 30 },
      ]);
      repo.getConversationVolumeSeries.mockResolvedValue([
        { bucket: new Date('2026-06-02T00:00:00.000Z'), value: 40 },
      ]);

      const result = await service.getConversationMetrics(BUSINESS_ID, {
        from: FROM,
        to: TO,
        granularity: Granularity.DAY,
      });

      expect(result.resolutionRate).toBe(80);
      expect(result.aiResolutionRate).toBe(75); // 60 / 80
      expect(result.humanResolutionRate).toBe(25); // 20 / 80
      // Channel shares sorted desc with percentages.
      expect(result.byChannel[0]).toEqual({
        channel: ChannelType.WHATSAPP,
        count: 70,
        percentage: 70,
      });
      // 06-01 → 06-15 inclusive of the end bucket → 15 daily buckets, gap-filled.
      expect(result.volumeSeries).toHaveLength(15);
      const filled = result.volumeSeries.find(
        (p) => p.date === '2026-06-02T00:00:00.000Z',
      );
      expect(filled?.value).toBe(40);
    });

    it('returns zero rates (not NaN) for an empty business', async () => {
      repo.getConversationCounts.mockResolvedValue({
        total: 0,
        resolved: 0,
        open: 0,
        pendingHuman: 0,
        escalated: 0,
        snoozed: 0,
        aiResolved: 0,
        humanResolved: 0,
      });
      repo.getConversationVolumeByChannel.mockResolvedValue([]);
      repo.getConversationVolumeSeries.mockResolvedValue([]);

      const result = await service.getConversationMetrics(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.resolutionRate).toBe(0);
      expect(result.aiResolutionRate).toBe(0);
      expect(result.byChannel).toEqual([]);
      expect(result.volumeSeries.every((p) => p.value === 0)).toBe(true);
    });

    it('passes the resolved business id and range to the repository', async () => {
      repo.getConversationCounts.mockResolvedValue({
        total: 0,
        resolved: 0,
        open: 0,
        pendingHuman: 0,
        escalated: 0,
        snoozed: 0,
        aiResolved: 0,
        humanResolved: 0,
      });
      repo.getConversationVolumeByChannel.mockResolvedValue([]);
      repo.getConversationVolumeSeries.mockResolvedValue([]);

      await service.getConversationMetrics(BUSINESS_ID, { from: FROM, to: TO });

      expect(repo.getConversationCounts).toHaveBeenCalledWith(BUSINESS_ID, {
        from: new Date(FROM),
        to: new Date(TO),
      });
    });
  });

  // ───────────────────────────────────────────
  // Response time metrics
  // ───────────────────────────────────────────

  describe('getResponseTimeMetrics', () => {
    it('rounds latencies and forwards the sample size', async () => {
      repo.getResponseTimeStats.mockResolvedValue({
        avgSeconds: 33.33333,
        p50Seconds: 20.5,
        p90Seconds: 95.1234,
        sampleSize: 42,
      });
      repo.getAvgResolutionSeconds.mockResolvedValue(3600.9);
      repo.getResponseTimeSeries.mockResolvedValue([]);

      const result = await service.getResponseTimeMetrics(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.avgFirstResponseSeconds).toBe(33.33);
      expect(result.p90FirstResponseSeconds).toBe(95.12);
      expect(result.avgResolutionSeconds).toBe(3600.9);
      expect(result.sampleSize).toBe(42);
    });
  });

  // ───────────────────────────────────────────
  // Revenue metrics
  // ───────────────────────────────────────────

  describe('getRevenueMetrics', () => {
    it('converts rupees to paise, nets refunds, and computes AOV', async () => {
      repo.getRevenueSummary.mockResolvedValue({
        grossRevenueRupees: 1000,
        refundsRupees: 150,
        orderCount: 4,
      });
      repo.getRevenueSeries.mockResolvedValue([]);
      repo.getOrderCountSeries.mockResolvedValue([]);

      const result = await service.getRevenueMetrics(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.grossRevenuePaise).toBe(100000); // 1000 → paise
      expect(result.refundsPaise).toBe(15000);
      expect(result.netRevenuePaise).toBe(85000);
      expect(result.averageOrderValuePaise).toBe(25000); // 100000 / 4
    });

    it('returns AOV 0 when there are no orders', async () => {
      repo.getRevenueSummary.mockResolvedValue({
        grossRevenueRupees: 0,
        refundsRupees: 0,
        orderCount: 0,
      });
      repo.getRevenueSeries.mockResolvedValue([]);
      repo.getOrderCountSeries.mockResolvedValue([]);

      const result = await service.getRevenueMetrics(BUSINESS_ID, { from: FROM, to: TO });
      expect(result.averageOrderValuePaise).toBe(0);
    });
  });

  describe('getTopProducts', () => {
    it('forwards the limit and returns the ranked list', async () => {
      repo.getTopProducts.mockResolvedValue([
        { itemId: 'p1', name: 'Widget', unitsSold: 12, revenuePaise: 240000 },
      ]);

      const result = await service.getTopProducts(BUSINESS_ID, { from: FROM, to: TO, limit: 5 });

      expect(repo.getTopProducts).toHaveBeenCalledWith(
        BUSINESS_ID,
        { from: new Date(FROM), to: new Date(TO) },
        5,
      );
      expect(result[0]!.revenuePaise).toBe(240000);
    });

    it('defaults the limit to 10', async () => {
      repo.getTopProducts.mockResolvedValue([]);
      await service.getTopProducts(BUSINESS_ID, { from: FROM, to: TO });
      expect(repo.getTopProducts).toHaveBeenCalledWith(BUSINESS_ID, expect.anything(), 10);
    });
  });

  // ───────────────────────────────────────────
  // Client analytics
  // ───────────────────────────────────────────

  describe('getClientAcquisitionMetrics', () => {
    it('computes the new-client share and channel breakdown', async () => {
      repo.countNewClients.mockResolvedValue(30);
      repo.countReturningClients.mockResolvedValue(10);
      repo.getAcquisitionByChannel.mockResolvedValue([
        { channel: ChannelType.WHATSAPP, count: 20 },
        { channel: ChannelType.EMAIL, count: 10 },
      ]);
      repo.getAcquisitionSeries.mockResolvedValue([]);

      const result = await service.getClientAcquisitionMetrics(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.newClients).toBe(30);
      expect(result.returningClients).toBe(10);
      expect(result.newClientShare).toBe(75); // 30 / 40
      expect(result.byChannel[0]!.channel).toBe(ChannelType.WHATSAPP);
    });
  });

  describe('getClientRetentionMetrics', () => {
    it('computes churn and retention rates', async () => {
      repo.getRetentionStats.mockResolvedValue({
        activeAtStart: 200,
        churned: 50,
        atRisk: 12,
      });

      const result = await service.getClientRetentionMetrics(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.churnRate).toBe(25); // 50 / 200
      expect(result.retentionRate).toBe(75);
      expect(result.atRiskClients).toBe(12);
    });

    it('reports 0 churn (not NaN) when no cohort exists', async () => {
      repo.getRetentionStats.mockResolvedValue({ activeAtStart: 0, churned: 0, atRisk: 0 });
      const result = await service.getClientRetentionMetrics(BUSINESS_ID, { from: FROM, to: TO });
      expect(result.churnRate).toBe(0);
      expect(result.retentionRate).toBe(100);
    });
  });

  // ───────────────────────────────────────────
  // AI performance
  // ───────────────────────────────────────────

  describe('getAutonomyMetrics', () => {
    it('computes the autonomy KPI and override rate with a per-bucket series', async () => {
      repo.getAiDecisionCounts.mockResolvedValue({
        total: 50,
        autoExecuted: 40,
        sentForReview: 7,
        escalated: 3,
        overriddenByHuman: 0,
        expired: 0,
        overridden: 8,
      });
      repo.getAutonomySeries.mockResolvedValue([
        { bucket: new Date('2026-06-02T00:00:00.000Z'), auto: 8, total: 10 },
      ]);

      const result = await service.getAutonomyMetrics(BUSINESS_ID, {
        from: FROM,
        to: TO,
        granularity: Granularity.DAY,
      });

      expect(result.autonomyRate).toBe(80); // 40 / 50
      expect(result.overrideRate).toBe(20); // 8 / 40
      const point = result.autonomySeries.find((p) => p.date === '2026-06-02T00:00:00.000Z');
      expect(point?.value).toBe(80); // 8 / 10 → 80%
    });

    it('never divides by zero when there are no decisions', async () => {
      repo.getAiDecisionCounts.mockResolvedValue({
        total: 0,
        autoExecuted: 0,
        sentForReview: 0,
        escalated: 0,
        overriddenByHuman: 0,
        expired: 0,
        overridden: 0,
      });
      repo.getAutonomySeries.mockResolvedValue([]);

      const result = await service.getAutonomyMetrics(BUSINESS_ID, { from: FROM, to: TO });
      expect(result.autonomyRate).toBe(0);
      expect(result.overrideRate).toBe(0);
    });
  });

  describe('getConfidenceDistribution', () => {
    it('builds a full 10-bucket histogram and autonomy bands', async () => {
      repo.getConfidenceStats.mockResolvedValue({
        total: 100,
        averageConfidence: 0.82,
        histogram: [
          { bucket: 3, count: 10 }, // [20,30) → ESCALATE
          { bucket: 8, count: 30 }, // [70,80) → REVIEW
          { bucket: 9, count: 20 }, // [80,90) → REVIEW
          { bucket: 10, count: 40 }, // [90,100] → AUTO
        ],
      });

      const result = await service.getConfidenceDistribution(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.averageConfidence).toBe(82); // 0.82 → 82
      expect(result.histogram).toHaveLength(10);
      expect(result.histogram[2]).toEqual({ lower: 20, upper: 30, count: 10 });
      expect(result.histogram[9]).toEqual({ lower: 90, upper: 100, count: 40 });

      const bands = Object.fromEntries(result.byBand.map((b) => [b.band, b.count]));
      expect(bands.ESCALATE).toBe(10);
      expect(bands.REVIEW).toBe(50); // 30 + 20
      expect(bands.AUTO).toBe(40);
    });

    it('zero-fills every bucket for an empty range', async () => {
      repo.getConfidenceStats.mockResolvedValue({
        total: 0,
        averageConfidence: 0,
        histogram: [],
      });

      const result = await service.getConfidenceDistribution(BUSINESS_ID, { from: FROM, to: TO });
      expect(result.histogram).toHaveLength(10);
      expect(result.histogram.every((b) => b.count === 0)).toBe(true);
      expect(result.byBand.every((b) => b.percentage === 0)).toBe(true);
    });
  });

  describe('getEscalationReasons', () => {
    it('computes per-reason percentage shares', async () => {
      repo.getEscalationReasons.mockResolvedValue([
        { reason: 'PROCESS_REFUND', count: 6 },
        { reason: 'low_confidence', count: 2 },
      ]);

      const result = await service.getEscalationReasons(BUSINESS_ID, { from: FROM, to: TO });

      expect(result[0]).toEqual({ reason: 'PROCESS_REFUND', count: 6, percentage: 75 });
      expect(result[1]!.percentage).toBe(25);
    });

    it('returns an empty array (no throw) when there are no escalations', async () => {
      repo.getEscalationReasons.mockResolvedValue([]);
      const result = await service.getEscalationReasons(BUSINESS_ID, { from: FROM, to: TO });
      expect(result).toEqual([]);
    });
  });

  // ───────────────────────────────────────────
  // Team performance
  // ───────────────────────────────────────────

  describe('getStaffMetrics', () => {
    it('forwards the tenant-scoped range and returns the rows', async () => {
      const rows = [
        {
          memberId: 'm1',
          name: 'Asha',
          role: 'STAFF',
          assignedConversations: 5,
          resolvedConversations: 12,
          tasksResolved: 8,
          avgTaskResolutionSeconds: 240,
        },
      ];
      repo.getStaffMetrics.mockResolvedValue(rows);

      const result = await service.getStaffMetrics(BUSINESS_ID, { from: FROM, to: TO });

      expect(repo.getStaffMetrics).toHaveBeenCalledWith(BUSINESS_ID, {
        from: new Date(FROM),
        to: new Date(TO),
      });
      expect(result).toEqual(rows);
    });
  });

  // ───────────────────────────────────────────
  // Booking analytics
  // ───────────────────────────────────────────

  describe('getBookingMetrics', () => {
    it('computes completion and cancellation rates', async () => {
      repo.getBookingCounts.mockResolvedValue({
        total: 40,
        confirmed: 10,
        completed: 24,
        cancelled: 4,
        noShow: 2,
      });
      repo.getBookingSeries.mockResolvedValue([]);

      const result = await service.getBookingMetrics(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.completionRate).toBe(60); // 24 / 40
      expect(result.cancellationRate).toBe(15); // (4 + 2) / 40
    });
  });

  // ───────────────────────────────────────────
  // Multi-tenant isolation
  // ───────────────────────────────────────────

  describe('multi-tenant scoping', () => {
    it('threads the caller businessId into every repository call', async () => {
      repo.getConversationCounts.mockResolvedValue({
        total: 0,
        resolved: 0,
        open: 0,
        pendingHuman: 0,
        escalated: 0,
        snoozed: 0,
        aiResolved: 0,
        humanResolved: 0,
      });
      repo.getConversationVolumeByChannel.mockResolvedValue([]);
      repo.getConversationVolumeSeries.mockResolvedValue([]);

      await service.getConversationMetrics(OTHER_BUSINESS_ID, { from: FROM, to: TO });

      for (const call of repo.getConversationCounts.mock.calls) {
        expect(call[0]).toBe(OTHER_BUSINESS_ID);
      }
      expect(repo.getConversationVolumeByChannel).toHaveBeenCalledWith(
        OTHER_BUSINESS_ID,
        expect.anything(),
      );
    });
  });
});
