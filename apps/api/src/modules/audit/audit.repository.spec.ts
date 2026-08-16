import { AuditAction } from '@prisma/client';
import { AuditRepository, type AuditLogFilters } from './audit.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { MAX_AUDIT_EXPORT_ROWS } from './audit.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

function makeFilters(overrides: Partial<AuditLogFilters> = {}): AuditLogFilters {
  return {
    from: new Date('2026-02-01T00:00:00Z'),
    to: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

describe('AuditRepository', () => {
  let prisma: {
    audit_logs: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
  };
  let repository: AuditRepository;

  beforeEach(() => {
    prisma = {
      audit_logs: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
    };
    repository = new AuditRepository(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('scopes both the page and the count to the business', async () => {
      // The count drives totalPages. A count that forgot the tenant would leak
      // the size of every other business's trail through the pagination.
      await repository.list(BUSINESS_ID, makeFilters(), 0, 50);

      expect(prisma.audit_logs.findMany.mock.calls[0]![0].where).toMatchObject({
        business_id: BUSINESS_ID,
      });
      expect(prisma.audit_logs.count.mock.calls[0]![0].where).toMatchObject({
        business_id: BUSINESS_ID,
      });
    });

    it('uses the same predicate for both queries', async () => {
      await repository.list(
        BUSINESS_ID,
        makeFilters({ actorType: 'TEAM_MEMBER' }),
        0,
        50,
      );
      expect(prisma.audit_logs.count.mock.calls[0]![0].where).toEqual(
        prisma.audit_logs.findMany.mock.calls[0]![0].where,
      );
    });

    it('bounds the query by the window', async () => {
      await repository.list(BUSINESS_ID, makeFilters(), 0, 50);
      expect(prisma.audit_logs.findMany.mock.calls[0]![0].where.created_at).toEqual({
        gte: new Date('2026-02-01T00:00:00Z'),
        lte: new Date('2026-03-01T00:00:00Z'),
      });
    });

    it('breaks the sort tie on id so a row cannot straddle two pages', async () => {
      // `created_at` is a timestamp and two rows written in one transaction can
      // share it exactly. Ordering on it alone lets the tie break differently
      // per query, so a row shows up twice or not at all while paging.
      await repository.list(BUSINESS_ID, makeFilters(), 0, 50);
      expect(prisma.audit_logs.findMany.mock.calls[0]![0].orderBy).toEqual([
        { created_at: 'desc' },
        { id: 'desc' },
      ]);
    });

    it('passes skip and take straight through', async () => {
      await repository.list(BUSINESS_ID, makeFilters(), 40, 20);
      expect(prisma.audit_logs.findMany.mock.calls[0]![0]).toMatchObject({
        skip: 40,
        take: 20,
      });
    });

    it('omits filters the caller did not set', async () => {
      await repository.list(BUSINESS_ID, makeFilters(), 0, 50);
      const where = prisma.audit_logs.findMany.mock.calls[0]![0].where;

      expect(where).not.toHaveProperty('action');
      expect(where).not.toHaveProperty('actor_type');
      expect(where).not.toHaveProperty('resource_type');
    });

    it('omits an empty action list rather than matching nothing', async () => {
      // `{ action: { in: [] } }` matches no rows at all, which would turn
      // "filter cleared" into "no results".
      await repository.list(BUSINESS_ID, makeFilters({ actions: [] }), 0, 50);
      expect(prisma.audit_logs.findMany.mock.calls[0]![0].where).not.toHaveProperty(
        'action',
      );
    });

    it('maps each filter onto its column', async () => {
      await repository.list(
        BUSINESS_ID,
        makeFilters({
          actions: [AuditAction.UPDATE],
          actorType: 'AI',
          actorId: '00000000-0000-4000-c000-000000000001',
          resourceType: 'team_member',
          resourceId: '00000000-0000-4000-d000-000000000001',
        }),
        0,
        50,
      );

      expect(prisma.audit_logs.findMany.mock.calls[0]![0].where).toMatchObject({
        action: { in: [AuditAction.UPDATE] },
        actor_type: 'AI',
        actor_id: '00000000-0000-4000-c000-000000000001',
        resource_type: 'team_member',
        resource_id: '00000000-0000-4000-d000-000000000001',
      });
    });

    it('never selects rows with a null business_id', async () => {
      // Platform-level events carry no business. An equality predicate excludes
      // NULL in SQL, which is the behaviour wanted — but it is load-bearing, so
      // it is asserted rather than assumed.
      await repository.list(BUSINESS_ID, makeFilters(), 0, 50);
      const where = prisma.audit_logs.findMany.mock.calls[0]![0].where;
      expect(where.business_id).toBe(BUSINESS_ID);
      expect(typeof where.business_id).toBe('string');
    });
  });

  describe('findById', () => {
    it('scopes the lookup to the business', async () => {
      await repository.findById(BUSINESS_ID, '00000000-0000-4000-b000-000000000001');
      expect(prisma.audit_logs.findFirst.mock.calls[0]![0].where).toEqual({
        id: '00000000-0000-4000-b000-000000000001',
        business_id: BUSINESS_ID,
      });
    });
  });

  describe('listAll', () => {
    it('caps the export at the ceiling even when asked for more', async () => {
      await repository.listAll(BUSINESS_ID, makeFilters(), MAX_AUDIT_EXPORT_ROWS * 10);
      expect(prisma.audit_logs.findMany.mock.calls[0]![0].take).toBe(
        MAX_AUDIT_EXPORT_ROWS,
      );
    });

    it('honours a smaller explicit limit', async () => {
      await repository.listAll(BUSINESS_ID, makeFilters(), 25);
      expect(prisma.audit_logs.findMany.mock.calls[0]![0].take).toBe(25);
    });

    it('defaults to the ceiling', async () => {
      await repository.listAll(BUSINESS_ID, makeFilters());
      expect(prisma.audit_logs.findMany.mock.calls[0]![0].take).toBe(
        MAX_AUDIT_EXPORT_ROWS,
      );
    });
  });

  describe('aggregates', () => {
    it('groups actions within the tenant and window', async () => {
      await repository.countByAction(BUSINESS_ID, makeFilters());
      const args = prisma.audit_logs.groupBy.mock.calls[0]![0];
      expect(args.by).toEqual(['action']);
      expect(args.where).toMatchObject({ business_id: BUSINESS_ID });
    });

    it('groups actors within the tenant and window', async () => {
      await repository.countByActor(BUSINESS_ID, makeFilters());
      const args = prisma.audit_logs.groupBy.mock.calls[0]![0];
      expect(args.by).toEqual(['actor_id', 'actor_email']);
      expect(args.where).toMatchObject({ business_id: BUSINESS_ID });
    });

    it('flattens the Prisma count shape', async () => {
      prisma.audit_logs.groupBy.mockResolvedValue([
        { action: AuditAction.UPDATE, _count: { _all: 4 } },
      ]);
      await expect(repository.countByAction(BUSINESS_ID, makeFilters())).resolves.toEqual([
        { action: AuditAction.UPDATE, count: 4 },
      ]);
    });
  });

  it('exposes no write methods', () => {
    // `audit_logs` refuses UPDATE and DELETE in the database, so any write here
    // would be a runtime error waiting to be called.
    const methods = Object.getOwnPropertyNames(AuditRepository.prototype);
    expect(methods.filter((m) => /create|update|delete|upsert/i.test(m))).toEqual([]);
  });
});
