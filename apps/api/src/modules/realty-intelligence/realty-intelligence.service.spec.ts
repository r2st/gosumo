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
import type { AggregationLead } from '../realty-leads/realty-leads.service';
import { LlmClientService, LlmUnavailableError } from '../ai-engine/pipeline/llm-client.service';
import {
  INTELLIGENCE_SUMMARY_MODEL,
  AGGREGATION_LOOKBACK_DAYS,
  LEAD_FETCH_CAP,
  LEAD_FETCH_PAGE_SIZE,
} from './realty-intelligence.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

/**
 * One row of the aggregation projection — the narrow shape
 * `RealtyLeadsService.listLeadsForAggregation` returns. Budgets already in
 * paise and objections already flattened to text: the widening from database
 * row to this shape is the leads module's job and is tested there.
 */
function makeLead(overrides: Partial<AggregationLead> = {}): AggregationLead {
  return {
    source: LeadSource.PORTAL,
    stage: LeadStage.VISIT_BOOKED,
    qualScore: 70,
    localities: ['Whitefield'],
    budgetMinPaise: 80_00_000 * 100,
    budgetMaxPaise: 1_00_00_000 * 100,
    config: '2BHK',
    objections: ['too expensive'],
    firstTouchAt: new Date('2026-03-10T00:00:00Z'),
    lastActivityAt: new Date('2026-03-12T00:00:00Z'),
    ...overrides,
  };
}

function fetched(leads: AggregationLead[], truncated = false) {
  return { leads, truncated };
}

describe('RealtyIntelligenceService', () => {
  let service: RealtyIntelligenceService;
  let repository: jest.Mocked<RealtyIntelligenceRepository>;
  let leads: { listLeadsForAggregation: jest.Mock };
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

    leads = { listLeadsForAggregation: jest.fn().mockResolvedValue(fetched([])) };
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
      leads.listLeadsForAggregation.mockResolvedValue(
        fetched(Array.from({ length: 6 }, () => makeLead())),
      );

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
      leads.listLeadsForAggregation.mockResolvedValue(fetched([makeLead(), makeLead()])); // only 2
      const result = await service.generateNightlyAggregates();
      expect(result.aggregateCount).toBe(0);
      expect(repository.upsertAggregate).not.toHaveBeenCalled();
    });

    it('single-tenant run skips a business that has not opted in', async () => {
      repository.getOptInStatus.mockResolvedValue(false);
      const result = await service.generateNightlyAggregates(new Date(), BUSINESS_ID);
      expect(result.businessCount).toBe(0);
      expect(leads.listLeadsForAggregation).not.toHaveBeenCalled();
    });

    it('single-tenant run uses that tenant when opted in', async () => {
      repository.getOptInStatus.mockResolvedValue(true);
      leads.listLeadsForAggregation.mockResolvedValue(
        fetched(Array.from({ length: 6 }, () => makeLead())),
      );
      const result = await service.generateNightlyAggregates(new Date(), BUSINESS_ID);
      expect(repository.listOptInBusinessIds).not.toHaveBeenCalled();
      expect(result.businessCount).toBe(1);
    });

    // ─────────────────────────────────────────────
    // Per-tenant isolation
    //
    // The loop had no try/catch, so the first tenant that threw ended the run
    // and every tenant after it kept yesterday's priors — indistinguishable,
    // from outside, from a tenant that simply had nothing to aggregate.
    // ─────────────────────────────────────────────
    describe('a tenant that fails', () => {
      const BIZ_B = '00000000-0000-4000-b000-00000000000b';
      const BIZ_C = '00000000-0000-4000-b000-00000000000c';

      beforeEach(() => {
        repository.listOptInBusinessIds.mockResolvedValue([BUSINESS_ID, BIZ_B, BIZ_C]);
      });

      it('does not stop the tenants queued behind it', async () => {
        leads.listLeadsForAggregation.mockImplementation(async (bid: string) => {
          if (bid === BUSINESS_ID) throw new Error('projection blew up');
          return fetched(Array.from({ length: 6 }, () => makeLead()));
        });

        const result = await service.generateNightlyAggregates();

        // B and C still got fresh priors.
        expect(result.businessCount).toBe(2);
        expect(result.businessesFailed).toBe(1);
        expect(result.aggregateCount).toBe(10); // 5 metrics × 2 tenants
      });

      it('isolates a failure in the upsert half of the loop too', async () => {
        leads.listLeadsForAggregation.mockResolvedValue(
          fetched(Array.from({ length: 6 }, () => makeLead())),
        );
        repository.upsertAggregate.mockImplementation((async (arg: {
          businessId: string;
        }) => {
          if (arg.businessId === BIZ_B) throw new Error('constraint violation');
          return undefined;
        }) as never);

        const result = await service.generateNightlyAggregates();

        expect(result.businessesFailed).toBe(1);
        expect(result.businessCount).toBe(2);
      });

      it('reports every tenant failing without throwing the run away', async () => {
        leads.listLeadsForAggregation.mockRejectedValue(new Error('database down'));

        const result = await service.generateNightlyAggregates();

        expect(result.businessCount).toBe(0);
        expect(result.businessesFailed).toBe(3);
        expect(result.aggregateCount).toBe(0);
      });

      it('counts no failures on a clean run', async () => {
        leads.listLeadsForAggregation.mockResolvedValue(
          fetched(Array.from({ length: 6 }, () => makeLead())),
        );
        const result = await service.generateNightlyAggregates();
        expect(result.businessesFailed).toBe(0);
        expect(result.businessCount).toBe(3);
      });
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
      leads.listLeadsForAggregation.mockResolvedValue(
        fetched([
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

  // ── lead fetch for aggregation ──

  /**
   * Paging, the lookback window and the row→projection widening all live in
   * `RealtyLeadsService.listLeadsForAggregation` now (and are tested against the
   * repository in realty-leads.spec.ts). What is left here is the contract this
   * service holds with that method: the window it asks for, the cap it imposes,
   * and what it does when the cap is hit.
   */
  describe('lead fetch for aggregation', () => {
    it('asks for exactly the lookback window, capped and paged', async () => {
      const now = new Date('2026-07-03T00:00:00Z');
      await service.generateNightlyAggregates(now);

      expect(leads.listLeadsForAggregation).toHaveBeenCalledTimes(1);
      const [businessId, since, cap, pageSize] = leads.listLeadsForAggregation.mock.calls[0]!;
      expect(businessId).toBe(BUSINESS_ID);
      expect(cap).toBe(LEAD_FETCH_CAP);
      expect(pageSize).toBe(LEAD_FETCH_PAGE_SIZE);

      // The window closes at `now` and opens AGGREGATION_LOOKBACK_DAYS earlier.
      expect((since as Date).toISOString()).toBe('2025-07-03T00:00:00.000Z');
      const spanDays = (now.getTime() - (since as Date).getTime()) / 86_400_000;
      expect(spanDays).toBe(AGGREGATION_LOOKBACK_DAYS);
    });

    /**
     * Hitting the cap silently would publish corridor stats computed from the
     * tenant's oldest leads only — a biased sample that reads like a complete
     * one. The run still proceeds; it just says so.
     */
    it('warns when a tenant hits the aggregation cap', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      leads.listLeadsForAggregation.mockResolvedValue(
        fetched(Array.from({ length: 6 }, () => makeLead()), true),
      );

      const result = await service.generateNightlyAggregates();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('aggregation cap'));
      // Capped or not, the aggregates for this run are still written.
      expect(result.aggregateCount).toBe(5);
      warn.mockRestore();
    });

    it('stays quiet when the tenant is under the cap', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      leads.listLeadsForAggregation.mockResolvedValue(
        fetched(Array.from({ length: 6 }, () => makeLead()), false),
      );

      await service.generateNightlyAggregates();

      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // ── lead projection ──

  describe('lead projection', () => {
    /**
     * A sparse lead has to reduce to explicit nulls rather than undefined — the
     * aggregation maths branches on null, and undefined would slip past those
     * guards.
     */
    it('normalises a lead with no budget, config, objections or last activity', async () => {
      leads.listLeadsForAggregation.mockResolvedValue(
        fetched([
          makeLead({
            localities: [],
            budgetMinPaise: null,
            budgetMaxPaise: null,
            config: null,
            objections: [],
            lastActivityAt: null,
          }),
        ]),
      );

      const report = await service.getSourceQualityReport(BUSINESS_ID);
      expect(report.totalLeads).toBe(1);
      expect(report.sources).toHaveLength(1);
    });

    /**
     * The projection re-wraps both timestamps in `new Date`. Prisma hands back
     * real Dates, but the aggregation maths does arithmetic on them, so a row
     * that arrived as an ISO string (a JSON round-trip through a cache, say)
     * must not reach it as a string.
     */
    it('coerces timestamps that arrive as ISO strings', async () => {
      leads.listLeadsForAggregation.mockResolvedValue(
        fetched([
          makeLead({
            firstTouchAt: '2026-03-10T00:00:00Z' as unknown as Date,
            lastActivityAt: '2026-03-12T00:00:00Z' as unknown as Date,
          }),
        ]),
      );

      const report = await service.getSourceQualityReport(BUSINESS_ID);
      expect(report.totalLeads).toBe(1);
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

    /**
     * Both cases above assert the *call*, never the *result* — the repository
     * was stubbed empty, so the row-to-DTO mapping never ran. This drives a
     * real row through it. What matters: the three timestamps serialise, and
     * `min_n_threshold` survives the rename, because that field is what tells
     * the dashboard an aggregate is suppression-safe.
     */
    it('maps each row to the DTO the dashboard consumes', async () => {
      repository.listByBusiness.mockResolvedValue([
        {
          id: 'agg-1',
          business_id: BUSINESS_ID,
          corridor: 'Whitefield',
          metric_type: IntelligenceMetricType.SOURCE_QUALITY,
          metric_value: { bySource: { '99acres': { qualifiedRate: 0.42 } } },
          sample_size: 37,
          min_n_threshold: 5,
          period_start: new Date('2026-06-01T00:00:00Z'),
          period_end: new Date('2026-07-01T00:00:00Z'),
          created_at: new Date('2026-07-01T02:30:00Z'),
          updated_at: new Date('2026-07-01T02:30:00Z'),
        },
      ] as unknown as Awaited<ReturnType<RealtyIntelligenceRepository['listByBusiness']>>);

      const [dto] = await service.listAggregates(BUSINESS_ID);

      expect(dto).toEqual({
        id: 'agg-1',
        corridor: 'Whitefield',
        metricType: IntelligenceMetricType.SOURCE_QUALITY,
        metricValue: { bySource: { '99acres': { qualifiedRate: 0.42 } } },
        sampleSize: 37,
        minNThreshold: 5,
        periodStart: '2026-06-01T00:00:00.000Z',
        periodEnd: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T02:30:00.000Z',
      });
      // The tenant discriminator is not part of the response body.
      expect(dto).not.toHaveProperty('business_id');
    });
  });

  describe('listCorridors', () => {
    it('returns the tenant’s corridors from the repository', async () => {
      repository.listCorridors.mockResolvedValue(['Hinjewadi', 'Wakad']);

      await expect(service.listCorridors(BUSINESS_ID)).resolves.toEqual(['Hinjewadi', 'Wakad']);
      expect(repository.listCorridors).toHaveBeenCalledWith(BUSINESS_ID);
    });
  });

  describe('getOptInStatus', () => {
    // Consent is opt-in only, so the read has to report both states faithfully
    // — a stuck `true` would enrol a tenant's leads into the network.
    it.each([true, false])('reports the stored consent flag (%s)', async (flag) => {
      repository.getOptInStatus.mockResolvedValue(flag);

      await expect(service.getOptInStatus(BUSINESS_ID)).resolves.toBe(flag);
      expect(repository.getOptInStatus).toHaveBeenCalledWith(BUSINESS_ID);
    });
  });
});
