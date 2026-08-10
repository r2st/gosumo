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

import { Logger } from '@nestjs/common';
import { IntelligenceMetricType, LeadStage, LeadSource } from '@gosumo/shared';
import { RealtyIntelligenceService } from './realty-intelligence.service';
import { RealtyIntelligenceRepository } from './realty-intelligence.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { LlmClientService, LlmUnavailableError } from '../ai-engine/pipeline/llm-client.service';
import { INTELLIGENCE_SUMMARY_MODEL } from './realty-intelligence.constants';

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

  // ── lead paging ──

  describe('lead paging for aggregation', () => {
    function page(data: unknown[], pageNo: number, totalPages: number) {
      return { data, total: data.length, page: pageNo, limit: 500, totalPages };
    }

    /** A full page means there may be more; a short one is the end of the road. */
    it('walks every page until a short page arrives', async () => {
      const full = Array.from({ length: 500 }, () => makeLead());
      leads.listLeads
        .mockResolvedValueOnce(page(full, 1, 3))
        .mockResolvedValueOnce(page(full, 2, 3))
        .mockResolvedValueOnce(page([makeLead()], 3, 3));

      const report = await service.getSourceQualityReport(BUSINESS_ID);

      expect(leads.listLeads).toHaveBeenCalledTimes(3);
      expect(report.totalLeads).toBe(1001);
      expect(leads.listLeads.mock.calls[2]![1]).toEqual({ page: 3, limit: 500 });
    });

    /**
     * A page that is exactly full but is also the last page must not trigger a
     * fourth read — `totalPages` is the second stop condition for a reason.
     */
    it('stops on the last page even when it is exactly full', async () => {
      const full = Array.from({ length: 500 }, () => makeLead());
      leads.listLeads
        .mockResolvedValueOnce(page(full, 1, 2))
        .mockResolvedValueOnce(page(full, 2, 2));

      await service.getSourceQualityReport(BUSINESS_ID);
      expect(leads.listLeads).toHaveBeenCalledTimes(2);
    });

    it('drops leads whose first touch predates the lookback window', async () => {
      leads.listLeads.mockResolvedValue(
        paginated([
          makeLead({ firstTouchAt: new Date('2020-01-01T00:00:00Z') }),
          makeLead({ firstTouchAt: new Date() }),
        ]),
      );

      const report = await service.getSourceQualityReport(BUSINESS_ID);
      expect(report.totalLeads).toBe(1);
    });
  });

  // ── lead projection ──

  describe('lead projection', () => {
    /**
     * The projection is fed by the leads service DTO, where every BLTC field and
     * the objection list are individually nullable. A sparse lead has to reduce
     * to explicit nulls rather than undefined — the aggregation maths branches
     * on null, and undefined would slip past those guards.
     */
    it('normalises a lead with no BLTC, objections or last activity', async () => {
      leads.listLeads.mockResolvedValue(
        paginated([
          makeLead({
            bltc: {
              budgetMinPaise: null,
              budgetMaxPaise: null,
              localities: null,
              timelineMonths: null,
              config: null,
              purpose: null,
              financing: null,
            },
            objections: null,
            lastActivityAt: null,
          }),
        ]),
      );

      const report = await service.getSourceQualityReport(BUSINESS_ID);
      expect(report.totalLeads).toBe(1);
      expect(report.sources).toHaveLength(1);
    });

    it('drops objections that carry no text', async () => {
      leads.listLeads.mockResolvedValue(
        paginated([
          makeLead({
            objections: [
              { text: '', at: '2026-03-10T00:00:00Z' },
              { text: 'too expensive', at: '2026-03-10T00:00:00Z' },
            ],
          }),
        ]),
      );

      await expect(service.getSourceQualityReport(BUSINESS_ID)).resolves.toBeDefined();
    });
  });

  // ── narration ──

  describe('getCorridorNarrative', () => {
    const priorRow = {
      id: 'a1',
      business_id: BUSINESS_ID,
      corridor: 'Whitefield',
      metric_type: IntelligenceMetricType.PRICE_ELASTICITY,
      metric_value: {
        withBudget: 6,
        recommendedBandPaise: { low: 80_00_000 * 100, high: 1_20_00_000 * 100 },
      },
      sample_size: 6,
      min_n_threshold: 5,
      period_start: new Date('2026-01-01'),
      period_end: new Date('2026-07-01'),
      created_at: new Date(),
      updated_at: new Date(),
    };

    it('returns null for a corridor with no priors at all', async () => {
      repository.findLatestByCorridor.mockResolvedValue([]);
      expect(await service.getCorridorNarrative(BUSINESS_ID, 'Nowhere')).toBeNull();
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('returns the model sentence when OpenRouter answers', async () => {
      repository.findLatestByCorridor.mockResolvedValue([priorRow as never]);
      llm.complete.mockResolvedValue({ text: '  Buyers here anchor near ₹1cr.  ' });

      expect(await service.getCorridorNarrative(BUSINESS_ID, 'Whitefield')).toBe(
        'Buyers here anchor near ₹1cr.',
      );
      expect(llm.complete.mock.calls[0]![0].model).toBe(INTELLIGENCE_SUMMARY_MODEL);
    });

    /**
     * Narration is a nicety layered over a deterministic string. Every failure
     * mode — empty completion, provider outage, unexpected throw — degrades to
     * that string rather than to null, so the caller always has priors to show.
     */
    it('falls back to the deterministic context when the model returns nothing', async () => {
      repository.findLatestByCorridor.mockResolvedValue([priorRow as never]);
      llm.complete.mockResolvedValue({ text: '   ' });

      const res = await service.getCorridorNarrative(BUSINESS_ID, 'Whitefield');
      expect(res).toContain('micro_market_intelligence');
    });

    it('falls back quietly when the provider is unavailable', async () => {
      repository.findLatestByCorridor.mockResolvedValue([priorRow as never]);
      llm.complete.mockRejectedValue(new LlmUnavailableError('no key configured'));

      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const res = await service.getCorridorNarrative(BUSINESS_ID, 'Whitefield');
      expect(res).toContain('micro_market_intelligence');
      // A missing OpenRouter key is an expected deployment state, not a warning.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('warns and falls back on an unexpected model failure', async () => {
      repository.findLatestByCorridor.mockResolvedValue([priorRow as never]);
      llm.complete.mockRejectedValue(new Error('502 from upstream'));

      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      const res = await service.getCorridorNarrative(BUSINESS_ID, 'Whitefield');
      expect(res).toContain('micro_market_intelligence');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('502 from upstream'));
      warn.mockRestore();
    });

    it('survives a thrown non-Error value', async () => {
      repository.findLatestByCorridor.mockResolvedValue([priorRow as never]);
      llm.complete.mockRejectedValue('socket hang up');

      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);

      await expect(
        service.getCorridorNarrative(BUSINESS_ID, 'Whitefield'),
      ).resolves.toContain('micro_market_intelligence');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
      warn.mockRestore();
    });
  });

  // ── dashboard feed ──

  describe('listAggregates', () => {
    it('lists everything for the tenant when called with no filters', async () => {
      repository.listByBusiness.mockResolvedValue([]);
      expect(await service.listAggregates(BUSINESS_ID)).toEqual([]);
      expect(repository.listByBusiness).toHaveBeenCalledWith(BUSINESS_ID, {});
    });

    it('passes corridor and metric filters through', async () => {
      repository.listByBusiness.mockResolvedValue([]);
      await service.listAggregates(BUSINESS_ID, {
        corridor: 'Whitefield',
        metricType: IntelligenceMetricType.SOURCE_QUALITY,
      });
      expect(repository.listByBusiness).toHaveBeenCalledWith(BUSINESS_ID, {
        corridor: 'Whitefield',
        metricType: IntelligenceMetricType.SOURCE_QUALITY,
      });
    });
  });
});
