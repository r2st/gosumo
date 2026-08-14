/**
 * RealtyIntelligenceRepository unit tests.
 *
 * Two things here decide behaviour:
 *   - every aggregate query is scoped by `business_id`, and the two consent
 *     reads on `businesses` additionally exclude soft-deleted rows. This is the
 *     one module that reads across tenants (the nightly run lists every
 *     opted-in business), so a missing filter leaks one tenant's corridor
 *     statistics into another's prompt context;
 *   - `findLatestByCorridor` de-duplicates in memory, keeping the first row per
 *     metric_type — which is only the newest because of the `period_end desc`
 *     ordering. The ordering and the de-dupe are one mechanism.
 *
 * PrismaService is mocked; assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';
import type { realty_intelligence_aggregates } from '@prisma/client';

import { RealtyIntelligenceRepository } from './realty-intelligence.repository';
import type { UpsertAggregateData } from './realty-intelligence.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS_ID = '00000000-0000-4000-a000-000000000002';

function aggregate(
  overrides: Partial<realty_intelligence_aggregates> = {},
): realty_intelligence_aggregates {
  return {
    id: 'agg-1',
    business_id: BUSINESS_ID,
    corridor: 'Powai',
    metric_type: 'CADENCE_CONVERSION',
    metric_value: {},
    sample_size: 120,
    min_n_threshold: 25,
    period_start: new Date('2026-01-01T00:00:00.000Z'),
    period_end: new Date('2026-06-30T00:00:00.000Z'),
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    updated_at: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  } as realty_intelligence_aggregates;
}

describe('RealtyIntelligenceRepository', () => {
  let repository: RealtyIntelligenceRepository;
  let prisma: {
    realty_intelligence_aggregates: Record<'findMany' | 'upsert', jest.Mock>;
    businesses: Record<'findFirst' | 'findMany' | 'update', jest.Mock>;
  };

  beforeEach(async () => {
    prisma = {
      realty_intelligence_aggregates: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue(aggregate()),
      },
      businesses: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyIntelligenceRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(RealtyIntelligenceRepository);
  });

  describe('upsertAggregate', () => {
    const data: UpsertAggregateData = {
      businessId: BUSINESS_ID,
      corridor: 'Powai',
      metricType: 'CADENCE_CONVERSION' as UpsertAggregateData['metricType'],
      metricValue: { conversionRate: 0.32 },
      sampleSize: 120,
      minNThreshold: 25,
      periodStart: new Date('2026-01-01T00:00:00.000Z'),
      periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    };

    it('keys the upsert on the full (business, corridor, metric, period) window', () => {
      // Re-running the nightly job over the same window must update in place;
      // a narrower key would collapse distinct corridors or periods into one
      // row, a wider one would duplicate on every run.
      void repository.upsertAggregate(data);
      expect(
        prisma.realty_intelligence_aggregates.upsert.mock.calls[0][0].where,
      ).toEqual({
        business_id_corridor_metric_type_period_start: {
          business_id: BUSINESS_ID,
          corridor: 'Powai',
          metric_type: 'CADENCE_CONVERSION',
          period_start: data.periodStart,
        },
      });
    });

    it('writes every column on create', () => {
      void repository.upsertAggregate(data);
      expect(
        prisma.realty_intelligence_aggregates.upsert.mock.calls[0][0].create,
      ).toEqual({
        business_id: BUSINESS_ID,
        corridor: 'Powai',
        metric_type: 'CADENCE_CONVERSION',
        metric_value: { conversionRate: 0.32 },
        sample_size: 120,
        min_n_threshold: 25,
        period_start: data.periodStart,
        period_end: data.periodEnd,
      });
    });

    it('does not rewrite the identity columns on update', () => {
      // business_id, corridor, metric_type and period_start are the key; an
      // update that touched them would move the row to a different window.
      const update =
        prisma.realty_intelligence_aggregates.upsert.mock.calls[0]?.[0].update ??
        (void repository.upsertAggregate(data),
        prisma.realty_intelligence_aggregates.upsert.mock.calls[0][0].update);
      expect(update).toEqual({
        metric_value: { conversionRate: 0.32 },
        sample_size: 120,
        min_n_threshold: 25,
        period_end: data.periodEnd,
      });
      expect(update).not.toHaveProperty('business_id');
      expect(update).not.toHaveProperty('period_start');
    });

    it('returns the upserted row', async () => {
      const row = aggregate({ id: 'agg-9' });
      prisma.realty_intelligence_aggregates.upsert.mockResolvedValue(row);
      await expect(repository.upsertAggregate(data)).resolves.toBe(row);
    });
  });

  describe('findLatestByCorridor', () => {
    it('scopes to the business and corridor', async () => {
      await repository.findLatestByCorridor(BUSINESS_ID, 'Powai');
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].where,
      ).toEqual({ business_id: BUSINESS_ID, corridor: 'Powai' });
    });

    it('orders newest-last-period first within each metric', () => {
      // The in-memory de-dupe below keeps the *first* row per metric_type, so
      // it is only "latest" because of this ordering.
      void repository.findLatestByCorridor(BUSINESS_ID, 'Powai');
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].orderBy,
      ).toEqual([{ metric_type: 'asc' }, { period_end: 'desc' }]);
    });

    it('filters by metric type when asked', async () => {
      await repository.findLatestByCorridor(BUSINESS_ID, 'Powai', [
        'CADENCE_CONVERSION',
        'PRICE_ELASTICITY',
      ] as never);
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].where
          .metric_type,
      ).toEqual({ in: ['CADENCE_CONVERSION', 'PRICE_ELASTICITY'] });
    });

    it('omits the metric filter when none is given', async () => {
      await repository.findLatestByCorridor(BUSINESS_ID, 'Powai');
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('metric_type');
    });

    it('omits the metric filter for an empty array rather than matching nothing', async () => {
      // `metric_type: { in: [] }` would silently return zero rows.
      await repository.findLatestByCorridor(BUSINESS_ID, 'Powai', []);
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('metric_type');
    });

    it('keeps exactly one row per metric type', async () => {
      prisma.realty_intelligence_aggregates.findMany.mockResolvedValue([
        aggregate({ id: 'new-cadence', metric_type: 'CADENCE_CONVERSION' }),
        aggregate({ id: 'old-cadence', metric_type: 'CADENCE_CONVERSION' }),
        aggregate({ id: 'new-price', metric_type: 'PRICE_ELASTICITY' }),
      ]);
      const rows = await repository.findLatestByCorridor(BUSINESS_ID, 'Powai');
      expect(rows.map((r) => r.id)).toEqual(['new-cadence', 'new-price']);
    });

    it('keeps the first row per metric, which the ordering makes the newest', async () => {
      prisma.realty_intelligence_aggregates.findMany.mockResolvedValue([
        aggregate({ id: 'newest', period_end: new Date('2026-06-30T00:00:00.000Z') }),
        aggregate({ id: 'older', period_end: new Date('2026-03-31T00:00:00.000Z') }),
      ]);
      const rows = await repository.findLatestByCorridor(BUSINESS_ID, 'Powai');
      expect(rows.map((r) => r.id)).toEqual(['newest']);
    });

    it('returns an empty list when the corridor has no aggregates', async () => {
      await expect(
        repository.findLatestByCorridor(BUSINESS_ID, 'Nowhere'),
      ).resolves.toEqual([]);
    });
  });

  describe('listByBusiness', () => {
    it('scopes to the business', async () => {
      await repository.listByBusiness(BUSINESS_ID);
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].where,
      ).toEqual({ business_id: BUSINESS_ID });
    });

    it('applies an optional corridor filter', async () => {
      await repository.listByBusiness(BUSINESS_ID, { corridor: 'Powai' });
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].where,
      ).toEqual({ business_id: BUSINESS_ID, corridor: 'Powai' });
    });

    it('applies an optional metric filter', async () => {
      await repository.listByBusiness(BUSINESS_ID, {
        metricType: 'OBJECTION_FREQUENCY' as never,
      });
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].where
          .metric_type,
      ).toBe('OBJECTION_FREQUENCY');
    });

    it('applies both filters together', async () => {
      await repository.listByBusiness(BUSINESS_ID, {
        corridor: 'Powai',
        metricType: 'PRICE_ELASTICITY' as never,
      });
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].where,
      ).toEqual({
        business_id: BUSINESS_ID,
        corridor: 'Powai',
        metric_type: 'PRICE_ELASTICITY',
      });
    });

    it('ignores an empty corridor string rather than matching corridor=""', async () => {
      await repository.listByBusiness(BUSINESS_ID, { corridor: '' });
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('corridor');
    });

    it('sorts by corridor then metric, so the dashboard groups stably', async () => {
      await repository.listByBusiness(BUSINESS_ID);
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].orderBy,
      ).toEqual([{ corridor: 'asc' }, { metric_type: 'asc' }]);
    });

    it('returns the rows Prisma yields', async () => {
      const rows = [aggregate()];
      prisma.realty_intelligence_aggregates.findMany.mockResolvedValue(rows);
      await expect(repository.listByBusiness(BUSINESS_ID)).resolves.toBe(rows);
    });
  });

  describe('listCorridors', () => {
    it('scopes to the business and de-duplicates in the database', async () => {
      await repository.listCorridors(BUSINESS_ID);
      const call = prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ business_id: BUSINESS_ID });
      expect(call.distinct).toEqual(['corridor']);
      expect(call.orderBy).toEqual({ corridor: 'asc' });
    });

    it('selects only the corridor column', async () => {
      await repository.listCorridors(BUSINESS_ID);
      expect(
        prisma.realty_intelligence_aggregates.findMany.mock.calls[0][0].select,
      ).toEqual({ corridor: true });
    });

    it('flattens the rows to plain strings', async () => {
      prisma.realty_intelligence_aggregates.findMany.mockResolvedValue([
        { corridor: 'Andheri' },
        { corridor: 'Powai' },
      ]);
      await expect(repository.listCorridors(BUSINESS_ID)).resolves.toEqual([
        'Andheri',
        'Powai',
      ]);
    });

    it('returns an empty list for a business with no aggregates yet', async () => {
      await expect(repository.listCorridors(BUSINESS_ID)).resolves.toEqual([]);
    });
  });

  describe('getOptInStatus', () => {
    it('reads the flag for the business, excluding soft-deleted rows', async () => {
      await repository.getOptInStatus(BUSINESS_ID);
      expect(prisma.businesses.findFirst.mock.calls[0][0]).toEqual({
        where: { id: BUSINESS_ID, deleted_at: null },
        select: { intelligence_opt_in: true },
      });
    });

    it('returns the stored consent', async () => {
      prisma.businesses.findFirst.mockResolvedValue({ intelligence_opt_in: true });
      await expect(repository.getOptInStatus(BUSINESS_ID)).resolves.toBe(true);
    });

    it('defaults to false for a business that has never decided', async () => {
      // Consent must fail closed: a null here means "no record", not "yes".
      prisma.businesses.findFirst.mockResolvedValue({ intelligence_opt_in: null });
      await expect(repository.getOptInStatus(BUSINESS_ID)).resolves.toBe(false);
    });

    it('defaults to false for a missing or soft-deleted business', async () => {
      prisma.businesses.findFirst.mockResolvedValue(null);
      await expect(repository.getOptInStatus(OTHER_BUSINESS_ID)).resolves.toBe(false);
    });
  });

  describe('setOptIn', () => {
    it('grants consent for the business', async () => {
      await repository.setOptIn(BUSINESS_ID, true);
      expect(prisma.businesses.update.mock.calls[0][0]).toEqual({
        where: { id: BUSINESS_ID },
        data: { intelligence_opt_in: true },
      });
    });

    it('revokes consent', async () => {
      await repository.setOptIn(BUSINESS_ID, false);
      expect(prisma.businesses.update.mock.calls[0][0].data).toEqual({
        intelligence_opt_in: false,
      });
    });
  });

  describe('listOptInBusinessIds', () => {
    it('returns only active, non-deleted, opted-in tenants', async () => {
      // This is the one cross-tenant read in the module — it feeds the nightly
      // aggregation. Dropping any of the three conditions would pull a churned
      // or non-consenting tenant's leads into the network aggregates.
      await repository.listOptInBusinessIds();
      expect(prisma.businesses.findMany.mock.calls[0][0].where).toEqual({
        intelligence_opt_in: true,
        deleted_at: null,
        is_active: true,
      });
    });

    it('selects only the id', async () => {
      await repository.listOptInBusinessIds();
      expect(prisma.businesses.findMany.mock.calls[0][0].select).toEqual({ id: true });
    });

    it('flattens the rows to plain ids', async () => {
      prisma.businesses.findMany.mockResolvedValue([
        { id: BUSINESS_ID },
        { id: OTHER_BUSINESS_ID },
      ]);
      await expect(repository.listOptInBusinessIds()).resolves.toEqual([
        BUSINESS_ID,
        OTHER_BUSINESS_ID,
      ]);
    });

    it('returns an empty list when nobody has opted in', async () => {
      await expect(repository.listOptInBusinessIds()).resolves.toEqual([]);
    });
  });
});
