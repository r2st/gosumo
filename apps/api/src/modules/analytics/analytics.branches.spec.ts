/**
 * AnalyticsService — the branches `analytics.spec.ts` does not reach.
 *
 * That file covers two of the five export metrics and the LLM-unavailable path
 * of the AI summary. What is left is where the behaviour is least obvious:
 *
 *  - the remaining `exportReport` switch arms, including the revenue arm's
 *    index-align between two independently-queried series (a shorter order
 *    series must not produce `undefined` in the CSV);
 *  - the exact-midnight guard in the dashboard's "today" range, which exists so
 *    `from < to` still holds when the request lands on the tick;
 *  - the AI summary's *unexpected* error path, which must fail open to the
 *    deterministic summary exactly like the expected one, but log.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { AnalyticsRepository } from './analytics.repository';
import { ANALYTICS_CACHE, AnalyticsCache } from './analytics.cache';
import { LlmClientService, LlmUnavailableError } from '../ai-engine/pipeline/llm-client.service';
import { ExportMetric } from './dto';

const BUSINESS_ID = '11111111-1111-1111-1111-111111111111';
const FROM = '2026-06-01T00:00:00.000Z';
const TO = '2026-06-15T00:00:00.000Z';

const EMPTY_COUNTS = {
  total: 0,
  resolved: 0,
  open: 0,
  pendingHuman: 0,
  escalated: 0,
  snoozed: 0,
  aiResolved: 0,
  humanResolved: 0,
};

describe('AnalyticsService — export arms, midnight guard, and summary fail-open', () => {
  let service: AnalyticsService;
  let repo: jest.Mocked<AnalyticsRepository>;
  let cache: jest.Mocked<AnalyticsCache>;
  let llmClient: { complete: jest.Mock };

  beforeEach(async () => {
    repo = {
      getConversationCounts: jest.fn().mockResolvedValue(EMPTY_COUNTS),
      getConversationVolumeByChannel: jest.fn().mockResolvedValue([]),
      getConversationVolumeSeries: jest.fn().mockResolvedValue([]),
      countOpenConversations: jest.fn().mockResolvedValue(0),
      getResponseTimeStats: jest
        .fn()
        .mockResolvedValue({ avgSeconds: 30, p50Seconds: 20, p90Seconds: 60, sampleSize: 5 }),
      getResponseTimeSeries: jest.fn().mockResolvedValue([]),
      getAvgResolutionSeconds: jest.fn().mockResolvedValue(0),
      getAiDecisionCounts: jest
        .fn()
        .mockResolvedValue({ total: 0, autoExecuted: 0, drafted: 0, escalated: 0 }),
      getAutonomySeries: jest.fn().mockResolvedValue([]),
      getConfidenceStats: jest.fn().mockResolvedValue({ avg: 0, buckets: [] }),
      getEscalationReasons: jest.fn().mockResolvedValue([]),
      getRevenueSummary: jest
        .fn()
        .mockResolvedValue({ grossRevenuePaise: 0, orderCount: 0, avgOrderValuePaise: 0 }),
      getRevenueSeries: jest.fn().mockResolvedValue([]),
      getOrderCountSeries: jest.fn().mockResolvedValue([]),
      getTopProducts: jest.fn().mockResolvedValue([]),
      countNewClients: jest.fn().mockResolvedValue(0),
      countReturningClients: jest.fn().mockResolvedValue(0),
      getAcquisitionByChannel: jest.fn().mockResolvedValue([]),
      getAcquisitionSeries: jest.fn().mockResolvedValue([]),
      getRetentionStats: jest.fn().mockResolvedValue({ returningRate: 0, repeatOrderRate: 0 }),
      getBookingCounts: jest.fn().mockResolvedValue({ total: 0, completed: 0, cancelled: 0 }),
      getBookingSeries: jest.fn().mockResolvedValue([]),
      getStaffMetrics: jest.fn().mockResolvedValue([]),
      countPendingTasks: jest.fn().mockResolvedValue(0),
      countBookings: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<AnalyticsRepository>;

    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };
    llmClient = { complete: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: AnalyticsRepository, useValue: repo },
        { provide: ANALYTICS_CACHE, useValue: cache },
        { provide: LlmClientService, useValue: llmClient },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  /** CSV header row, split from the body. */
  function header(csv: string): string {
    return csv.split('\r\n')[0] as string;
  }

  describe('exportReport metric arms', () => {
    it('defaults to the conversations metric when none is named', async () => {
      repo.getConversationVolumeSeries.mockResolvedValue([{ bucket: new Date(FROM), value: 4 }]);

      const report = await service.exportReport(BUSINESS_ID, { from: FROM, to: TO });

      expect(header(report.csv)).toBe('date,conversations');
      expect(report.filename).toBe('gosumo-conversations-2026-06-15.csv');
    });

    it('renders the response-time series', async () => {
      repo.getResponseTimeSeries.mockResolvedValue([{ bucket: new Date(FROM), value: 42 }]);

      const report = await service.exportReport(BUSINESS_ID, {
        from: FROM,
        to: TO,
        metric: ExportMetric.RESPONSE_TIME,
      });

      expect(header(report.csv)).toBe('date,avgFirstResponseSeconds');
      expect(report.csv).toContain(',42');
      expect(report.filename).toBe('gosumo-response_time-2026-06-15.csv');
    });

    it('renders the autonomy series', async () => {
      repo.getAutonomySeries.mockResolvedValue([{ bucket: new Date(FROM), auto: 73, total: 100 }]);

      const report = await service.exportReport(BUSINESS_ID, {
        from: FROM,
        to: TO,
        metric: ExportMetric.AUTONOMY,
      });

      expect(header(report.csv)).toBe('date,autonomyRatePercent');
      expect(report.csv).toContain(',73');
    });

    it('renders revenue alongside the order count for the same bucket', async () => {
      repo.getRevenueSeries.mockResolvedValue([
        { bucket: new Date(FROM), value: 500_000 },
        { bucket: new Date('2026-06-02T00:00:00.000Z'), value: 250_000 },
      ]);
      repo.getOrderCountSeries.mockResolvedValue([
        { bucket: new Date(FROM), value: 5 },
        { bucket: new Date('2026-06-02T00:00:00.000Z'), value: 3 },
      ]);

      const report = await service.exportReport(BUSINESS_ID, {
        from: FROM,
        to: TO,
        metric: ExportMetric.REVENUE,
      });

      expect(header(report.csv)).toBe('date,grossRevenuePaise,orderCount');
      expect(report.csv).toContain('500000,5');
      expect(report.csv).toContain('250000,3');
    });

    it('writes 0 rather than a blank when the order series is shorter than the revenue series', async () => {
      // The two series are queried independently; a bucket present in one and
      // absent from the other must not emit `undefined` into the CSV.
      repo.getRevenueSeries.mockResolvedValue([
        { bucket: new Date(FROM), value: 500_000 },
        { bucket: new Date('2026-06-02T00:00:00.000Z'), value: 250_000 },
      ]);
      repo.getOrderCountSeries.mockResolvedValue([{ bucket: new Date(FROM), value: 5 }]);

      const report = await service.exportReport(BUSINESS_ID, {
        from: FROM,
        to: TO,
        metric: ExportMetric.REVENUE,
      });

      expect(report.csv).toContain('250000,0');
      expect(report.csv).not.toContain('undefined');
    });

    it('stamps the filename from the resolved range end, for every metric', async () => {
      const report = await service.exportReport(BUSINESS_ID, {
        from: FROM,
        to: TO,
        metric: ExportMetric.STAFF,
      });

      expect(report.filename).toBe('gosumo-staff-2026-06-15.csv');
      expect(report.contentType).toBe('text/csv');
    });
  });

  describe('the dashboard "today" range', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    /** The `todayRange` every dashboard query was handed. */
    function todayRange(): { from: Date; to: Date } {
      return repo.getConversationCounts.mock.calls[0]?.[1] as { from: Date; to: Date };
    }

    it('spans midnight to now during the day', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-15T09:30:00.000Z'));

      await service.getDashboardSummary(BUSINESS_ID);

      expect(todayRange().from.toISOString()).toBe('2026-06-15T00:00:00.000Z');
      expect(todayRange().to.toISOString()).toBe('2026-06-15T09:30:00.000Z');
    });

    it('keeps from < to on the exact midnight tick', async () => {
      // At exactly 00:00:00.000 the naive range would be zero-width, which the
      // downstream queries treat as an invalid window.
      jest.useFakeTimers().setSystemTime(new Date('2026-06-15T00:00:00.000Z'));

      await service.getDashboardSummary(BUSINESS_ID);

      const { from, to } = todayRange();
      expect(from.toISOString()).toBe('2026-06-15T00:00:00.000Z');
      expect(to.getTime()).toBeGreaterThan(from.getTime());
      expect(to.getTime() - from.getTime()).toBe(1000);
    });

    it('hands every dashboard query the same range', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-06-15T09:30:00.000Z'));

      await service.getDashboardSummary(BUSINESS_ID);

      const range = todayRange();
      for (const fn of [
        repo.getResponseTimeStats,
        repo.getAiDecisionCounts,
        repo.getRevenueSummary,
        repo.countNewClients,
        repo.countBookings,
      ]) {
        expect(fn).toHaveBeenCalledWith(BUSINESS_ID, range);
      }
    });
  });

  describe('getAiSummary fail-open', () => {
    it('accepts an empty query object and resolves the default range', async () => {
      llmClient.complete.mockResolvedValue({ text: 'Steady month.', modelId: 'openai/gpt-oss-20b:free' });

      const result = await service.getAiSummary(BUSINESS_ID);

      expect(result.summary).toBe('Steady month.');
      expect(result.aiGenerated).toBe(true);
      expect(result.range).toBeDefined();
    });

    it('falls back to the deterministic summary when the model returns empty text', async () => {
      llmClient.complete.mockResolvedValue({ text: '', modelId: 'openai/gpt-oss-20b:free' });

      const result = await service.getAiSummary(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.aiGenerated).toBe(false);
      expect(result.summary.length).toBeGreaterThan(0);
    });

    it('fails open quietly when the LLM is unavailable', async () => {
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      llmClient.complete.mockRejectedValue(new LlmUnavailableError('no key'));

      const result = await service.getAiSummary(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.aiGenerated).toBe(false);
      expect(result.summary.length).toBeGreaterThan(0);
      // An expected outage is not worth a warning on every request.
      expect(warn).not.toHaveBeenCalled();
    });

    it('fails open loudly for an unexpected error', async () => {
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      llmClient.complete.mockRejectedValue(new TypeError('bad prompt shape'));

      const result = await service.getAiSummary(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.aiGenerated).toBe(false);
      expect(result.summary.length).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad prompt shape'));
    });

    it('describes a non-Error rejection rather than logging "[object Object]"', async () => {
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      llmClient.complete.mockRejectedValue('upstream exploded');

      const result = await service.getAiSummary(BUSINESS_ID, { from: FROM, to: TO });

      expect(result.aiGenerated).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('upstream exploded'));
    });
  });

  describe('cache resilience', () => {
    it('still answers when the cache write fails', async () => {
      // Analytics is a read path — a Redis blip must degrade to uncached, not
      // to a 500.
      jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      cache.set.mockRejectedValue(new Error('redis down'));

      await expect(service.getDashboardSummary(BUSINESS_ID)).resolves.toBeDefined();
    });

    it('still answers when the cache read fails', async () => {
      jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      cache.get.mockRejectedValue(new Error('redis down'));

      await expect(service.getDashboardSummary(BUSINESS_ID)).resolves.toBeDefined();
    });
  });
});
