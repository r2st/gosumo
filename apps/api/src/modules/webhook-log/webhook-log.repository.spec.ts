/**
 * WebhookLogRepository unit tests.
 *
 * The whole module is read-only, so the risk here is entirely in the queries it
 * emits rather than in any state it changes:
 *
 *   - `buildWhere` is an all-optional filter builder. An omitted filter must be
 *     absent from the `where` (not present as `undefined`, which Prisma treats
 *     differently from "unset" for some operators), and the `received_at` range
 *     must degrade to a half-open range when only one bound is supplied.
 *   - `processed`/`signatureValid` are booleans, so `false` has to survive the
 *     "was this filter supplied?" check — a truthiness test would drop them.
 *   - Pagination defaults, and `totalPages` flooring to 1 on an empty result so
 *     the dashboard never renders "page 1 of 0".
 *
 * Every query must carry `business_id`; that is asserted throughout.
 *
 * PrismaService is mocked — assertions are on the emitted query.
 */

import { Test, TestingModule } from '@nestjs/testing';

import { WebhookLogRepository } from './webhook-log.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const EVENT_ID = '00000000-0000-4000-b000-000000000001';

const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-06-30T00:00:00Z');

describe('WebhookLogRepository', () => {
  let repository: WebhookLogRepository;
  let prisma: {
    webhook_events: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      webhook_events: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookLogRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(WebhookLogRepository);
  });

  describe('findMany — pagination', () => {
    it('defaults to page 1 with a limit of 20', async () => {
      prisma.webhook_events.count.mockResolvedValue(0);

      const result = await repository.findMany(BUSINESS_ID, {});

      expect(prisma.webhook_events.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('translates an explicit page/limit into skip/take', async () => {
      prisma.webhook_events.count.mockResolvedValue(95);

      const result = await repository.findMany(BUSINESS_ID, {
        page: 3,
        limit: 25,
      });

      expect(prisma.webhook_events.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 50, take: 25 }),
      );
      expect(result.totalPages).toBe(4);
    });

    it('reports at least one page when there are no events', async () => {
      prisma.webhook_events.count.mockResolvedValue(0);

      const result = await repository.findMany(BUSINESS_ID, {});

      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(1);
    });

    it('returns newest deliveries first', async () => {
      await repository.findMany(BUSINESS_ID, {});

      expect(prisma.webhook_events.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { received_at: 'desc' } }),
      );
    });

    it('counts against the same where clause it lists with', async () => {
      await repository.findMany(BUSINESS_ID, { source: 'whatsapp' });

      const listWhere = prisma.webhook_events.findMany.mock.calls[0]?.[0].where;
      const countWhere = prisma.webhook_events.count.mock.calls[0]?.[0].where;
      expect(countWhere).toEqual(listWhere);
    });
  });

  describe('findMany — filters', () => {
    async function whereFor(
      filters: Parameters<WebhookLogRepository['findMany']>[1],
    ): Promise<Record<string, unknown>> {
      await repository.findMany(BUSINESS_ID, filters);
      return prisma.webhook_events.findMany.mock.calls[0]?.[0].where as Record<
        string,
        unknown
      >;
    }

    it('scopes to the tenant and omits every unsupplied filter', async () => {
      const where = await whereFor({});

      expect(where).toEqual({ business_id: BUSINESS_ID });
      expect(where).not.toHaveProperty('source');
      expect(where).not.toHaveProperty('event_type');
      expect(where).not.toHaveProperty('processed');
      expect(where).not.toHaveProperty('signature_valid');
      expect(where).not.toHaveProperty('received_at');
    });

    it('applies the source and event-type filters', async () => {
      const where = await whereFor({
        source: 'razorpay',
        eventType: 'payment.captured',
      });

      expect(where).toMatchObject({
        business_id: BUSINESS_ID,
        source: 'razorpay',
        event_type: 'payment.captured',
      });
    });

    it('keeps processed=false rather than dropping it as falsy', async () => {
      const where = await whereFor({ processed: false });

      expect(where).toMatchObject({ processed: false });
    });

    it('keeps signatureValid=false — the forged-delivery query', async () => {
      const where = await whereFor({ signatureValid: false });

      expect(where).toMatchObject({ signature_valid: false });
    });

    it('applies processed=true and signatureValid=true', async () => {
      const where = await whereFor({ processed: true, signatureValid: true });

      expect(where).toMatchObject({ processed: true, signature_valid: true });
    });

    it('builds a closed range when both bounds are given', async () => {
      const where = await whereFor({ from: FROM, to: TO });

      expect(where.received_at).toEqual({ gte: FROM, lt: TO });
    });

    it('builds a half-open range from a lower bound alone', async () => {
      const where = await whereFor({ from: FROM });

      expect(where.received_at).toEqual({ gte: FROM });
    });

    it('builds a half-open range from an upper bound alone', async () => {
      const where = await whereFor({ to: TO });

      expect(where.received_at).toEqual({ lt: TO });
    });
  });

  describe('findById', () => {
    it('scopes the lookup to the tenant', async () => {
      await repository.findById(BUSINESS_ID, EVENT_ID);

      expect(prisma.webhook_events.findFirst).toHaveBeenCalledWith({
        where: { id: EVENT_ID, business_id: BUSINESS_ID },
      });
    });

    it('returns null for an id belonging to another tenant', async () => {
      prisma.webhook_events.findFirst.mockResolvedValue(null);

      await expect(repository.findById(BUSINESS_ID, EVENT_ID)).resolves.toBeNull();
    });
  });

  describe('getStats', () => {
    it('derives the unprocessed count from total minus processed', async () => {
      prisma.webhook_events.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(88) // processed
        .mockResolvedValueOnce(3); // invalid signature

      const stats = await repository.getStats(BUSINESS_ID, FROM, TO);

      expect(stats.total).toBe(100);
      expect(stats.processed).toBe(88);
      expect(stats.unprocessed).toBe(12);
      expect(stats.invalidSignature).toBe(3);
    });

    it('scopes every count to the tenant and the window', async () => {
      await repository.getStats(BUSINESS_ID, FROM, TO);

      for (const call of prisma.webhook_events.count.mock.calls) {
        expect(call[0].where).toMatchObject({
          business_id: BUSINESS_ID,
          received_at: { gte: FROM, lt: TO },
        });
      }
      expect(prisma.webhook_events.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['source'],
          where: expect.objectContaining({ business_id: BUSINESS_ID }),
        }),
      );
    });

    it('flattens the groupBy rows into source/count pairs', async () => {
      prisma.webhook_events.groupBy.mockResolvedValue([
        { source: 'whatsapp', _count: { _all: 70 } },
        { source: 'razorpay', _count: { _all: 30 } },
      ]);

      const stats = await repository.getStats(BUSINESS_ID, FROM, TO);

      expect(stats.bySource).toEqual([
        { source: 'whatsapp', count: 70 },
        { source: 'razorpay', count: 30 },
      ]);
    });

    it('returns an empty breakdown for a window with no deliveries', async () => {
      const stats = await repository.getStats(BUSINESS_ID, FROM, TO);

      expect(stats).toEqual({
        total: 0,
        processed: 0,
        unprocessed: 0,
        invalidSignature: 0,
        bySource: [],
      });
    });
  });
});
