import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChannelType } from '@gosumo/shared';

import { AnalyticsService } from './analytics.service';
import { AnalyticsRepository } from './analytics.repository';
import { ANALYTICS_CACHE } from './analytics.cache';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';
import {
  csatProxyScore,
  summarizeCsat,
  CSAT_PROXY_MAX,
  CSAT_PROXY_MIN,
  CSAT_PROXY_CHATTY_INBOUND,
  CSAT_PROXY_SLOW_HOURS,
  type CsatProxyGroup,
} from './conversation-quality.util';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

// ─────────────────────────────────────────────
// The proxy scoring policy
// ─────────────────────────────────────────────

describe('csatProxyScore', () => {
  const clean = { escalated: false, breached: false, slow: false, chatty: false };

  it('gives a clean, fast, single-pass resolution the top score', () => {
    expect(csatProxyScore(clean)).toBe(CSAT_PROXY_MAX);
  });

  it.each([
    ['escalated', { ...clean, escalated: true }],
    ['breached', { ...clean, breached: true }],
    ['slow', { ...clean, slow: true }],
    ['chatty', { ...clean, chatty: true }],
  ])('deducts one point for %s', (_name, signals) => {
    expect(csatProxyScore(signals)).toBe(CSAT_PROXY_MAX - 1);
  });

  it('weights every signal equally', () => {
    // Flat weights are a decision, not an oversight — any relative weighting
    // would be invented, and an invented one is harder to argue with.
    const one = csatProxyScore({ ...clean, escalated: true });
    for (const key of ['breached', 'slow', 'chatty'] as const) {
      expect(csatProxyScore({ ...clean, [key]: true })).toBe(one);
    }
  });

  it('accumulates penalties', () => {
    expect(csatProxyScore({ escalated: true, breached: true, slow: false, chatty: false })).toBe(3);
    expect(csatProxyScore({ escalated: true, breached: true, slow: true, chatty: false })).toBe(2);
  });

  it('floors at 1 rather than 0, so proxy and explicit share the 1-5 axis', () => {
    expect(csatProxyScore({ escalated: true, breached: true, slow: true, chatty: true })).toBe(
      CSAT_PROXY_MIN,
    );
  });
});

// ─────────────────────────────────────────────
// Summarisation
// ─────────────────────────────────────────────

describe('summarizeCsat', () => {
  const cleanGroup = (count: number): CsatProxyGroup => ({
    escalated: false,
    breached: false,
    slow: false,
    chatty: false,
    count,
  });

  it('reports nulls, not zeros, when there is nothing to average', () => {
    // Zero would read as "our customers rate us 0/5" on a tenant that has
    // simply not resolved anything yet.
    const summary = summarizeCsat([], []);
    expect(summary.explicitAverage).toBeNull();
    expect(summary.proxyAverage).toBeNull();
    expect(summary.combinedAverage).toBeNull();
    expect(summary.combinedSampled).toBe(0);
  });

  it('averages explicit ratings weighted by how many gave each score', () => {
    const summary = summarizeCsat(
      [
        { score: 5, count: 3 },
        { score: 1, count: 1 },
      ],
      [],
    );
    expect(summary.explicitResponses).toBe(4);
    expect(summary.explicitAverage).toBe(4); // (5*3 + 1) / 4
  });

  it('averages proxy groups weighted by group size', () => {
    const summary = summarizeCsat([], [
      cleanGroup(10),
      { escalated: true, breached: true, slow: false, chatty: false, count: 10 },
    ]);
    expect(summary.proxySampled).toBe(20);
    expect(summary.proxyAverage).toBe(4); // (5*10 + 3*10) / 20
  });

  it('keeps explicit and proxy separate while also pooling them', () => {
    // The whole point of the split: a tenant reading "4.2" has to be able to
    // see whether four customers said so or an algorithm inferred it from
    // four thousand conversations.
    const summary = summarizeCsat([{ score: 1, count: 1 }], [cleanGroup(9)]);

    expect(summary.explicitAverage).toBe(1);
    expect(summary.proxyAverage).toBe(5);
    expect(summary.combinedSampled).toBe(10);
    expect(summary.combinedAverage).toBe(4.6); // (1 + 45) / 10
  });

  it('counts each conversation once in the distribution', () => {
    const summary = summarizeCsat([{ score: 3, count: 2 }], [cleanGroup(4)]);

    expect(summary.distribution).toEqual({ '1': 0, '2': 0, '3': 2, '4': 0, '5': 4 });
    const total = Object.values(summary.distribution).reduce((a, b) => a + b, 0);
    expect(total).toBe(summary.combinedSampled);
  });

  it('drops an out-of-range stored score instead of clamping it', () => {
    // A 7 in a 1-5 column means the data is wrong; averaging it in would hide
    // that, and clamping it to 5 would invent a rating nobody gave.
    const summary = summarizeCsat(
      [
        { score: 7, count: 5 },
        { score: 4, count: 1 },
      ],
      [],
    );
    expect(summary.explicitResponses).toBe(1);
    expect(summary.explicitAverage).toBe(4);
  });
});

// ─────────────────────────────────────────────
// The service assembly
// ─────────────────────────────────────────────

describe('AnalyticsService — getConversationQualityMetrics', () => {
  let service: AnalyticsService;
  let repo: jest.Mocked<AnalyticsRepository>;

  const defaults = {
    getConversationCounts: {
      total: 100,
      resolved: 60,
      open: 30,
      pendingHuman: 5,
      escalated: 5,
      snoozed: 0,
      aiResolved: 50,
      humanResolved: 10,
    },
    getConversationQualityStats: {
      resolvedCount: 80,
      fcrCount: 40,
      escalatedCount: 8,
      avgResolutionSeconds: 3600.456,
      p50ResolutionSeconds: 1800,
      p90ResolutionSeconds: 7200,
    },
    getResponseTimeStats: {
      avgSeconds: 42.129,
      p50Seconds: 30,
      p90Seconds: 120,
      sampleSize: 75,
    },
    getCsatSignals: {
      explicit: [{ score: 5, count: 2 }],
      proxyGroups: [
        { escalated: false, breached: false, slow: false, chatty: false, count: 6 },
        { escalated: true, breached: false, slow: false, chatty: false, count: 2 },
      ],
    },
    getConversationQualityByChannel: [
      {
        channel: ChannelType.WHATSAPP,
        created: 80,
        resolved: 60,
        fcr: 30,
        avgResolutionSeconds: 3000,
      },
      { channel: ChannelType.EMAIL, created: 20, resolved: 20, fcr: 20, avgResolutionSeconds: 600 },
    ],
  };

  beforeEach(async () => {
    repo = {
      getConversationCounts: jest.fn().mockResolvedValue(defaults.getConversationCounts),
      getConversationQualityStats: jest
        .fn()
        .mockResolvedValue(defaults.getConversationQualityStats),
      getResponseTimeStats: jest.fn().mockResolvedValue(defaults.getResponseTimeStats),
      getCsatSignals: jest.fn().mockResolvedValue(defaults.getCsatSignals),
      getConversationQualityByChannel: jest
        .fn()
        .mockResolvedValue(defaults.getConversationQualityByChannel),
    } as unknown as jest.Mocked<AnalyticsRepository>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: AnalyticsRepository, useValue: repo },
        { provide: ANALYTICS_CACHE, useValue: { get: jest.fn(), set: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: LlmClientService, useValue: { complete: jest.fn() } },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  it('computes resolution rate against what arrived in the window', async () => {
    const report = await service.getConversationQualityMetrics(BUSINESS_ID, {});
    expect(report.resolutionRate).toBe(80); // 80 resolved / 100 created
  });

  it('computes first-contact resolution against what was resolved, not what arrived', async () => {
    // FCR asks "of the ones we closed, how many took one round trip" — an
    // unclosed conversation is not yet a first-contact failure.
    const report = await service.getConversationQualityMetrics(BUSINESS_ID, {});
    expect(report.firstContactResolution.rate).toBe(50); // 40 / 80
    expect(report.firstContactResolution.count).toBe(40);
    expect(report.firstContactResolution.escalatedCount).toBe(8);
  });

  it('reports the resolved count from the resolved-in-window query, not the status tally', async () => {
    // The two disagree by design: `getConversationCounts` groups conversations
    // *created* in the window by their current status, while the quality query
    // counts conversations *resolved* in the window. Reading the wrong one here
    // is what makes a resolution-rate chart trend down forever.
    const report = await service.getConversationQualityMetrics(BUSINESS_ID, {});
    expect(report.volume.created).toBe(100);
    expect(report.volume.resolved).toBe(80);
  });

  it('passes the proxy model parameters to the repository and reports them back', async () => {
    const report = await service.getConversationQualityMetrics(BUSINESS_ID, {});

    expect(repo.getCsatSignals).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.anything(),
      CSAT_PROXY_SLOW_HOURS,
      CSAT_PROXY_CHATTY_INBOUND,
    );
    expect(report.csat.proxyModel).toEqual({
      maxScore: CSAT_PROXY_MAX,
      slowHours: CSAT_PROXY_SLOW_HOURS,
      chattyInboundThreshold: CSAT_PROXY_CHATTY_INBOUND,
      penaltyPerSignal: 1,
    });
  });

  it('reports explicit and proxy CSAT separately', async () => {
    const report = await service.getConversationQualityMetrics(BUSINESS_ID, {});

    expect(report.csat.explicitResponses).toBe(2);
    expect(report.csat.explicitAverage).toBe(5);
    expect(report.csat.proxySampled).toBe(8);
    expect(report.csat.proxyAverage).toBe(4.75); // (5*6 + 4*2) / 8
    expect(report.csat.combinedSampled).toBe(10);
  });

  it('rounds latency figures to two decimals', async () => {
    const report = await service.getConversationQualityMetrics(BUSINESS_ID, {});
    expect(report.responseTime.avgFirstResponseSeconds).toBe(42.13);
    expect(report.resolutionTime.avgSeconds).toBe(3600.46);
  });

  it('breaks quality down per channel', async () => {
    const report = await service.getConversationQualityMetrics(BUSINESS_ID, {});

    expect(report.byChannel).toEqual([
      {
        channel: ChannelType.WHATSAPP,
        created: 80,
        resolved: 60,
        resolutionRate: 75,
        firstContactResolutionRate: 50,
        avgResolutionSeconds: 3000,
      },
      {
        channel: ChannelType.EMAIL,
        created: 20,
        resolved: 20,
        resolutionRate: 100,
        firstContactResolutionRate: 100,
        avgResolutionSeconds: 600,
      },
    ]);
  });

  it('returns zeros and nulls rather than throwing on an empty period', async () => {
    repo.getConversationCounts.mockResolvedValue({
      ...defaults.getConversationCounts,
      total: 0,
      resolved: 0,
      open: 0,
      pendingHuman: 0,
      escalated: 0,
      aiResolved: 0,
      humanResolved: 0,
    });
    repo.getConversationQualityStats.mockResolvedValue({
      resolvedCount: 0,
      fcrCount: 0,
      escalatedCount: 0,
      avgResolutionSeconds: 0,
      p50ResolutionSeconds: 0,
      p90ResolutionSeconds: 0,
    });
    repo.getCsatSignals.mockResolvedValue({ explicit: [], proxyGroups: [] });
    repo.getConversationQualityByChannel.mockResolvedValue([]);

    const report = await service.getConversationQualityMetrics(BUSINESS_ID, {});

    expect(report.resolutionRate).toBe(0);
    expect(report.firstContactResolution.rate).toBe(0);
    expect(report.csat.combinedAverage).toBeNull();
    expect(report.byChannel).toEqual([]);
  });

  it('rejects a range wider than the 365-day cap', async () => {
    await expect(
      service.getConversationQualityMetrics(BUSINESS_ID, {
        from: '2020-01-01T00:00:00Z',
        to: '2026-01-01T00:00:00Z',
      }),
    ).rejects.toThrow();
  });
});
