/**
 * RealtyPilotRepository unit tests — migration runs plus the two append-only
 * ledgers (autonomy changes, no-ship incidents).
 *
 * The services above it are well covered but mock this layer, so its optional
 * arguments were never exercised on both sides. That matters most for the
 * no-ship counts: the launch gate requires each no-ship kind to be exactly 0,
 * so a `since` window that silently drops out of the WHERE turns a historical
 * incident into a present-day NO_GO — or, the other way, hides a live one
 * behind a window that was never applied.
 */

import { RealtyPilotRepository } from './realty-pilot.repository';
import type { PrismaService } from '../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-00000000000a';
const RUN_ID = '00000000-0000-4000-b000-000000000001';
const SINCE = new Date('2026-07-01T00:00:00Z');

function prismaMock() {
  return {
    realty_migration_runs: {
      create: jest.fn().mockResolvedValue({ id: RUN_ID }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    realty_autonomy_events: {
      create: jest.fn().mockResolvedValue({ id: 'evt-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    realty_no_ship_incidents: {
      create: jest.fn().mockResolvedValue({ id: 'inc-1' }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
}

describe('RealtyPilotRepository', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let repo: RealtyPilotRepository;

  beforeEach(() => {
    prisma = prismaMock();
    repo = new RealtyPilotRepository(prisma as unknown as PrismaService);
  });

  describe('migration runs', () => {
    it('stores a null actor for an unattributed import', async () => {
      // A cron- or script-driven import has no user; the column is nullable
      // rather than carrying a sentinel string.
      await repo.createMigrationRun({
        businessId: BIZ,
        kind: 'LEADS',
        status: 'COMMITTED',
        dryRun: false,
        totalRows: 3,
        createdCount: 3,
        mergedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        errors: [],
        summary: {},
      } as never);

      expect(prisma.realty_migration_runs.create.mock.calls[0][0].data).toMatchObject({
        business_id: BIZ,
        created_by: null,
      });
    });

    it('reads one run scoped to the tenant and skipping soft-deleted rows', async () => {
      await repo.findMigrationRun(BIZ, RUN_ID);

      expect(prisma.realty_migration_runs.findFirst).toHaveBeenCalledWith({
        where: { id: RUN_ID, business_id: BIZ, deleted_at: null },
      });
    });

    it('lists every kind when called with no filters at all', async () => {
      await repo.listMigrationRuns(BIZ);

      const { where } = prisma.realty_migration_runs.findMany.mock.calls[0][0];
      expect(where).toEqual({ business_id: BIZ, deleted_at: null });
      // No `kind: undefined` — in Prisma that is not "any kind".
      expect(Object.keys(where)).not.toContain('kind');
    });

    it('filters by kind when one is given', async () => {
      await repo.listMigrationRuns(BIZ, { kind: 'INVENTORY' });

      expect(prisma.realty_migration_runs.findMany.mock.calls[0][0].where).toMatchObject({
        business_id: BIZ,
        kind: 'INVENTORY',
      });
    });

    it('caps the import history and shows the newest first', async () => {
      await repo.listMigrationRuns(BIZ, {});

      expect(prisma.realty_migration_runs.findMany.mock.calls[0][0]).toMatchObject({
        orderBy: { created_at: 'desc' },
        take: 100,
      });
    });
  });

  describe('autonomy ledger', () => {
    it('stores a null actor id for a system-driven dial change', async () => {
      await repo.createAutonomyEvent({
        businessId: BIZ,
        direction: 'OPEN',
        fromLevel: 'SUPERVISED',
        toLevel: 'ASSISTED',
        fromThreshold: 0.9,
        toThreshold: 0.8,
        evidence: {},
        reason: 'evidence met',
        actorType: 'SYSTEM',
      } as never);

      expect(prisma.realty_autonomy_events.create.mock.calls[0][0].data).toMatchObject({
        business_id: BIZ,
        actor_id: null,
      });
    });

    it('defaults the ledger page to 100 newest-first', async () => {
      await repo.listAutonomyEvents(BIZ);

      expect(prisma.realty_autonomy_events.findMany).toHaveBeenCalledWith({
        where: { business_id: BIZ },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
    });

    it('honours a caller-supplied limit', async () => {
      await repo.listAutonomyEvents(BIZ, 5);

      expect(prisma.realty_autonomy_events.findMany.mock.calls[0][0].take).toBe(5);
    });
  });

  describe('no-ship ledger', () => {
    it('nulls the optional references and defaults the metadata', async () => {
      await repo.createNoShipIncident({
        businessId: BIZ,
        kind: 'UNVERIFIED_PRICE',
        detail: 'quoted a price with no fact sheet',
        source: 'QA',
      } as never);

      expect(prisma.realty_no_ship_incidents.create.mock.calls[0][0].data).toMatchObject({
        business_id: BIZ,
        lead_id: null,
        conversation_id: null,
        metadata: {},
      });
    });

    it('counts every incident ever when no window is given', async () => {
      await repo.countNoShipIncidents(BIZ);

      // No `created_at` key at all — an absent window must not become an
      // `undefined` bound that Prisma could read as a filter.
      expect(prisma.realty_no_ship_incidents.count).toHaveBeenCalledWith({
        where: { business_id: BIZ },
      });
    });

    it('counts only incidents inside the window when one is given', async () => {
      await repo.countNoShipIncidents(BIZ, SINCE);

      expect(prisma.realty_no_ship_incidents.count).toHaveBeenCalledWith({
        where: { business_id: BIZ, created_at: { gte: SINCE } },
      });
    });

    it('groups by kind across all time when no window is given', async () => {
      await repo.countNoShipByKind(BIZ);

      expect(prisma.realty_no_ship_incidents.groupBy.mock.calls[0][0].where).toEqual({
        business_id: BIZ,
      });
    });

    it('groups by kind inside the window when one is given', async () => {
      await repo.countNoShipByKind(BIZ, SINCE);

      expect(prisma.realty_no_ship_incidents.groupBy.mock.calls[0][0].where).toEqual({
        business_id: BIZ,
        created_at: { gte: SINCE },
      });
    });

    it('flattens the grouped counts into a kind-keyed record', async () => {
      prisma.realty_no_ship_incidents.groupBy.mockResolvedValueOnce([
        { kind: 'UNVERIFIED_PRICE', _count: { _all: 2 } },
        { kind: 'OPTED_OUT_SEND', _count: { _all: 1 } },
      ]);

      await expect(repo.countNoShipByKind(BIZ)).resolves.toEqual({
        UNVERIFIED_PRICE: 2,
        OPTED_OUT_SEND: 1,
      });
    });

    it('reports no incidents as an empty record, not a missing one', async () => {
      // The launch gate reads each kind out of this; it must be indexable.
      await expect(repo.countNoShipByKind(BIZ)).resolves.toEqual({});
    });

    it('defaults the incident page to 100 newest-first', async () => {
      await repo.listNoShipIncidents(BIZ);

      expect(prisma.realty_no_ship_incidents.findMany).toHaveBeenCalledWith({
        where: { business_id: BIZ },
        orderBy: { created_at: 'desc' },
        take: 100,
      });
    });

    it('honours a caller-supplied limit', async () => {
      await repo.listNoShipIncidents(BIZ, 10);

      expect(prisma.realty_no_ship_incidents.findMany.mock.calls[0][0].take).toBe(10);
    });
  });
});
