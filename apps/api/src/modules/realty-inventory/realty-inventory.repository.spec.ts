/**
 * RealtyInventoryRepository unit tests — the grounding layer's Prisma access.
 *
 * The service spec mocks this repository wholesale, so the query shapes it
 * builds were never asserted anywhere. Three of them decide what the AI is
 * allowed to say, which is why they are worth pinning here:
 *
 *   - `listProjects` builds its WHERE conditionally. An optional filter that
 *     leaks in as `undefined` matches nothing in Prisma, so the failure mode is
 *     an empty portfolio rather than an error.
 *   - `listUnitsByProjects` exists to replace N round trips with one, and
 *     groups the flat result in Node. The grouping is where a project's units
 *     can end up on another project's key.
 *   - `findMatchCandidates` enforces the 24-hour freshness rule (hard rule
 *     §14): a stale unit that slips into the candidate set is the AI asserting
 *     availability it cannot back.
 *
 * Every method is asserted to carry `business_id`; the codebase-wide ratchet in
 * `repository-contract.spec.ts` enforces that generally, and these pin the
 * filter semantics it cannot see.
 */

import { Prisma } from '@prisma/client';
import type { realty_units } from '@prisma/client';

import { RealtyInventoryRepository } from './realty-inventory.repository';
import { AVAILABILITY_FRESHNESS_HOURS } from './realty-inventory.constants';
import type { PrismaService } from '../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-00000000000a';
const PROJECT_A = '00000000-0000-4000-b000-000000000001';
const PROJECT_B = '00000000-0000-4000-b000-000000000002';

function prismaMock() {
  return {
    realty_projects: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    realty_units: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    realty_assets: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function unitRow(over: Partial<realty_units> = {}): realty_units {
  return {
    id: 'unit-1',
    business_id: BIZ,
    project_id: PROJECT_A,
    config: '2BHK',
    all_in_price: new Prisma.Decimal(6_500_000),
    availability: 'AVAILABLE',
    deleted_at: null,
    ...over,
  } as realty_units;
}

describe('RealtyInventoryRepository', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let repo: RealtyInventoryRepository;

  beforeEach(() => {
    prisma = prismaMock();
    repo = new RealtyInventoryRepository(prisma as unknown as PrismaService);
  });

  describe('listProjects', () => {
    it('scopes to the tenant and hides soft-deleted rows when no filter is given', async () => {
      await repo.listProjects(BIZ, {});

      const { where } = prisma.realty_projects.findMany.mock.calls[0][0];
      expect(where).toEqual({ business_id: BIZ, deleted_at: null });
      // No stray `locality: undefined` — in Prisma that is not "any locality".
      expect(Object.keys(where)).not.toContain('locality');
      expect(Object.keys(where)).not.toContain('status');
    });

    it('matches a locality case-insensitively and as a substring', async () => {
      // Brokers type "wakad" for "Wakad, Pune"; an exact match finds nothing.
      await repo.listProjects(BIZ, { locality: 'wakad' });

      expect(prisma.realty_projects.findMany.mock.calls[0][0].where).toMatchObject({
        business_id: BIZ,
        locality: { contains: 'wakad', mode: 'insensitive' },
      });
    });

    it('filters by status', async () => {
      await repo.listProjects(BIZ, { status: 'READY' });

      expect(prisma.realty_projects.findMany.mock.calls[0][0].where).toMatchObject({
        business_id: BIZ,
        status: 'READY',
      });
    });

    it('applies both filters together', async () => {
      await repo.listProjects(BIZ, { locality: 'Baner', status: 'UNDER_CONSTRUCTION' });

      expect(prisma.realty_projects.findMany.mock.calls[0][0].where).toMatchObject({
        business_id: BIZ,
        deleted_at: null,
        locality: { contains: 'Baner', mode: 'insensitive' },
        status: 'UNDER_CONSTRUCTION',
      });
    });

    it('surfaces active projects before inactive ones, newest first', async () => {
      await repo.listProjects(BIZ, {});

      expect(prisma.realty_projects.findMany.mock.calls[0][0].orderBy).toEqual([
        { is_active: 'desc' },
        { created_at: 'desc' },
      ]);
    });
  });

  describe('listUnitsByProjects', () => {
    it('asks Postgres nothing when there are no projects to ask about', async () => {
      // The whole point of the method is to collapse N round trips into one;
      // for an empty portfolio that number is zero, not one.
      await expect(repo.listUnitsByProjects(BIZ, [])).resolves.toEqual(new Map());
      expect(prisma.realty_units.findMany).not.toHaveBeenCalled();
    });

    it('fetches every project’s units in a single tenant-scoped read', async () => {
      await repo.listUnitsByProjects(BIZ, [PROJECT_A, PROJECT_B]);

      expect(prisma.realty_units.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.realty_units.findMany.mock.calls[0][0].where).toEqual({
        business_id: BIZ,
        project_id: { in: [PROJECT_A, PROJECT_B] },
        deleted_at: null,
      });
    });

    it('groups the flat result under each unit’s own project', async () => {
      // Interleaved on purpose: grouping that assumes the rows arrive already
      // clustered by project would put a unit on the wrong key.
      prisma.realty_units.findMany.mockResolvedValueOnce([
        unitRow({ id: 'a1', project_id: PROJECT_A }),
        unitRow({ id: 'b1', project_id: PROJECT_B }),
        unitRow({ id: 'a2', project_id: PROJECT_A }),
      ]);

      const grouped = await repo.listUnitsByProjects(BIZ, [PROJECT_A, PROJECT_B]);

      expect(grouped.get(PROJECT_A)?.map((u) => u.id)).toEqual(['a1', 'a2']);
      expect(grouped.get(PROJECT_B)?.map((u) => u.id)).toEqual(['b1']);
    });

    it('omits a project with no units rather than mapping it to an empty list', async () => {
      prisma.realty_units.findMany.mockResolvedValueOnce([unitRow({ project_id: PROJECT_A })]);

      const grouped = await repo.listUnitsByProjects(BIZ, [PROJECT_A, PROJECT_B]);

      expect(grouped.has(PROJECT_B)).toBe(false);
      expect(grouped.size).toBe(1);
    });
  });

  describe('findMatchCandidates', () => {
    it('defaults to the 24-hour freshness window', async () => {
      const before = Date.now();
      await repo.findMatchCandidates(BIZ);

      const { where } = prisma.realty_units.findMany.mock.calls[0][0];
      expect(where).toMatchObject({
        business_id: BIZ,
        deleted_at: null,
        // Hard rule §14: only AVAILABLE units, only freshly verified ones.
        availability: 'AVAILABLE',
      });

      const cutoff = (where.verified_at as { gte: Date }).gte.getTime();
      const expected = before - AVAILABILITY_FRESHNESS_HOURS * 3600_000;
      expect(cutoff).toBeGreaterThanOrEqual(expected - 1000);
      expect(cutoff).toBeLessThanOrEqual(Date.now() - AVAILABILITY_FRESHNESS_HOURS * 3600_000);
    });

    it('honours a caller-supplied window', async () => {
      const before = Date.now();
      await repo.findMatchCandidates(BIZ, 1);

      const { where } = prisma.realty_units.findMany.mock.calls[0][0];
      const cutoff = (where.verified_at as { gte: Date }).gte.getTime();
      // One hour back, not twenty-four.
      expect(cutoff).toBeGreaterThanOrEqual(before - 3600_000 - 1000);
      expect(cutoff).toBeLessThanOrEqual(Date.now() - 3600_000);
    });
  });
});
