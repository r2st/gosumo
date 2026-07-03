/**
 * RealtyIntelligenceService unit tests. Repository, leads service, LLM, and event
 * emitter are all mocked — no database, no network.
 *
 * Coverage:
 *  1. generateNightlyAggregates — only opted-in businesses, min-n gating, emits.
 *  2. single-tenant run respects that tenant's own consent.
 *  3. consent — optIn/optOut flip the flag and emit.
 *  4. getSourceQualityReport — per-source ROI over the tenant's own leads.
 *  5. getCorridorPriors / buildCorridorContext — prompt-injection reads.
 */

import { IntelligenceMetricType, LeadStage, LeadSource } from '@gosumo/shared';
import { RealtyIntelligenceService } from './realty-intelligence.service';
import { RealtyIntelligenceRepository } from './realty-intelligence.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-a000-0000000000aa',
    businessId: BUSINESS_ID,
    source: LeadSource.PORTAL,
    stage: LeadStage.VISIT_BOOKED,
    qualScore: 70,
    bltc: {
      budgetMinPaise: 80_00_000 * 100,
      budgetMaxPaise: 1_00_00_000 * 100,
      localities: ['Whitefield'],
      timelineMonths: 3,
      config: '2BHK',
      purpose: null,
      financing: null,
    },
    objections: [{ text: 'too expensive', at: '2026-03-10T00:00:00Z' }],
    firstTouchAt: new Date('2026-03-10T00:00:00Z'),
    lastActivityAt: new Date('2026-03-12T00:00:00Z'),
    ...overrides,
  };
}

function paginated(data: unknown[]) {
  return { data, total: data.length, page: 1, limit: 500, totalPages: 1 };
}

describe('RealtyIntelligenceService', () => {
  let service: RealtyIntelligenceService;
  let repository: jest.Mocked<RealtyIntelligenceRepository>;
  let leads: { listLeads: jest.Mock };
  let llm: { complete: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(() => {
    repository = {
      upsertAggregate: jest.fn().mockResolvedValue(undefined),
      findLatestByCorridor: jest.fn().mockResolvedValue([]),
      listByBusiness: jest.fn().mockResolvedValue([]),
      listCorridors: jest.fn().mockResolvedValue([]),
      getOptInStatus: jest.fn().mockResolvedValue(true),
      setOptIn: jest.fn().mockResolvedValue(undefined),
      listOptInBusinessIds: jest.fn().mockResolvedValue([BUSINESS_ID]),
    } as unknown as jest.Mocked<RealtyIntelligenceRepository>;

    leads = { listLeads: jest.fn().mockResolvedValue(paginated([])) };
    llm = { complete: jest.fn() };
    emitter = { emit: jest.fn() };

    service = new RealtyIntelligenceService(
      repository,
      leads as unknown as RealtyLeadsService,
      llm as unknown as LlmClientService,
      emitter as unknown as import('@nestjs/event-emitter').EventEmitter2,
    );
  });

  describe('generateNightlyAggregates', () => {
    it('aggregates only opted-in businesses and emits a summary event', async () => {
      // 6 identical Whitefield leads clears the default minN=5.
      leads.listLeads.mockResolvedValue(paginated(Array.from({ length: 6 }, () => makeLead())));

      const result = await service.generateNightlyAggregates(new Date('2026-07-03T00:00:00Z'));

      expect(repository.listOptInBusinessIds).toHaveBeenCalled();
      expect(result.businessCount).toBe(1);
      // 5 metrics for the single qualifying corridor.
      expect(result.aggregateCount).toBe(5);
      expect(repository.upsertAggregate).toHaveBeenCalledTimes(5);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.intelligence.aggregates_generated',
        expect.objectContaining({ type: 'realty.intelligence.aggregates_generated', aggregateCount: 5 }),
      );
    });

    it('writes nothing when a corridor is below the min-n threshold', async () => {
      leads.listLeads.mockResolvedValue(paginated([makeLead(), makeLead()])); // only 2
      const result = await service.generateNightlyAggregates();
      expect(result.aggregateCount).toBe(0);
      expect(repository.upsertAggregate).not.toHaveBeenCalled();
    });

    it('single-tenant run skips a business that has not opted in', async () => {
      repository.getOptInStatus.mockResolvedValue(false);
      const result = await service.generateNightlyAggregates(new Date(), BUSINESS_ID);
      expect(result.businessCount).toBe(0);
      expect(leads.listLeads).not.toHaveBeenCalled();
    });

    it('single-tenant run uses that tenant when opted in', async () => {
      repository.getOptInStatus.mockResolvedValue(true);
      leads.listLeads.mockResolvedValue(paginated(Array.from({ length: 6 }, () => makeLead())));
      const result = await service.generateNightlyAggregates(new Date(), BUSINESS_ID);
      expect(repository.listOptInBusinessIds).not.toHaveBeenCalled();
      expect(result.businessCount).toBe(1);
    });
  });

  describe('consent', () => {
    it('optIn flips the flag and emits', async () => {
      const res = await service.optIn(BUSINESS_ID);
      expect(res.optIn).toBe(true);
      expect(repository.setOptIn).toHaveBeenCalledWith(BUSINESS_ID, true);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.intelligence.opted_in',
        expect.objectContaining({ type: 'realty.intelligence.opted_in', businessId: BUSINESS_ID }),
      );
    });

    it('optOut flips the flag and emits', async () => {
      const res = await service.optOut(BUSINESS_ID);
      expect(res.optIn).toBe(false);
      expect(repository.setOptIn).toHaveBeenCalledWith(BUSINESS_ID, false);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.intelligence.opted_out',
        expect.objectContaining({ type: 'realty.intelligence.opted_out' }),
      );
    });
  });

  describe('getSourceQualityReport', () => {
    it('reports per-source ROI over the tenant own leads (no min-n suppression)', async () => {
      leads.listLeads.mockResolvedValue(
        paginated([
          makeLead({ source: LeadSource.PORTAL, stage: LeadStage.VISITED }),
          makeLead({ source: LeadSource.REFERRAL, stage: LeadStage.NEW }),
        ]),
      );
      const report = await service.getSourceQualityReport(BUSINESS_ID);
      expect(report.totalLeads).toBe(2);
      // Both sources present even though each has only 1 lead (own-data view).
      expect(report.sources.map((s) => s.source).sort()).toEqual(
        [LeadSource.PORTAL, LeadSource.REFERRAL].sort(),
      );
    });
  });

  describe('prompt-injection reads', () => {
    it('getCorridorPriors maps repository rows to DTOs', async () => {
      repository.findLatestByCorridor.mockResolvedValue([
        {
          id: 'a1',
          business_id: BUSINESS_ID,
          corridor: 'Whitefield',
          metric_type: IntelligenceMetricType.PRICE_ELASTICITY,
          metric_value: { withBudget: 6 },
          sample_size: 6,
          min_n_threshold: 5,
          period_start: new Date('2026-01-01'),
          period_end: new Date('2026-07-01'),
          created_at: new Date(),
          updated_at: new Date(),
        } as never,
      ]);
      const priors = await service.getCorridorPriors(BUSINESS_ID, 'Whitefield');
      expect(priors).toHaveLength(1);
      expect(priors[0]!.metricType).toBe(IntelligenceMetricType.PRICE_ELASTICITY);
      expect(priors[0]!.sampleSize).toBe(6);
    });

    it('buildCorridorContext returns null with no aggregates', async () => {
      repository.findLatestByCorridor.mockResolvedValue([]);
      expect(await service.buildCorridorContext(BUSINESS_ID, 'Nowhere')).toBeNull();
      expect(await service.buildCorridorContext(BUSINESS_ID, '')).toBeNull();
    });

    it('buildCorridorContext renders a section when priors exist', async () => {
      repository.findLatestByCorridor.mockResolvedValue([
        {
          id: 'a1',
          business_id: BUSINESS_ID,
          corridor: 'Whitefield',
          metric_type: IntelligenceMetricType.PRICE_ELASTICITY,
          metric_value: { withBudget: 6, recommendedBandPaise: { low: 80_00_000 * 100, high: 1_20_00_000 * 100 } },
          sample_size: 6,
          min_n_threshold: 5,
          period_start: new Date('2026-01-01'),
          period_end: new Date('2026-07-01'),
          created_at: new Date(),
          updated_at: new Date(),
        } as never,
      ]);
      const ctx = await service.buildCorridorContext(BUSINESS_ID, 'Whitefield');
      expect(ctx).toContain('micro_market_intelligence');
      expect(ctx).toContain('Whitefield');
      expect(ctx).toContain('DO NOT quote');
    });
  });
});
