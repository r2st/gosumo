/**
 * ParserHealthRepository unit tests — the platform-ops parser-health log.
 *
 * This table is deliberately NOT tenant-scoped: parsers are global code and the
 * rows hold no tenant data, so there is no `business_id` to filter on. That
 * makes the usual isolation assertions inapplicable and leaves two things worth
 * pinning instead:
 *
 *   - `record` maps the camelCase input onto the snake_case columns. A slipped
 *     pair (pass/fail, sample/empty) inverts an ops dashboard silently.
 *   - `latestAll` returns one row per portal via `DISTINCT ON`, in Postgres.
 *     Prisma's `distinct` looks like the same thing and is not: it reads every
 *     row and de-duplicates in Node.
 */

import { RealtyParserHealthStatus } from '@prisma/client';
import type { realty_parser_health_checks } from '@prisma/client';

import { ParserHealthRepository } from './parser-health.repository';
import type { PrismaService } from '../../../common/services/prisma.service';

function prismaMock() {
  return {
    realty_parser_health_checks: {
      create: jest.fn().mockResolvedValue({ id: 'chk-1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function checkRow(over: Partial<realty_parser_health_checks> = {}): realty_parser_health_checks {
  return {
    id: 'chk-1',
    portal: '99ACRES',
    status: RealtyParserHealthStatus.HEALTHY,
    sample_count: 3,
    pass_count: 3,
    fail_count: 0,
    empty_count: 0,
    details: {},
    checked_at: new Date('2026-08-10T00:00:00Z'),
    created_at: new Date('2026-08-10T00:00:00Z'),
    ...over,
  } as realty_parser_health_checks;
}

describe('ParserHealthRepository', () => {
  let prisma: ReturnType<typeof prismaMock>;
  let repo: ParserHealthRepository;

  beforeEach(() => {
    prisma = prismaMock();
    repo = new ParserHealthRepository(prisma as unknown as PrismaService);
  });

  describe('record', () => {
    it('maps every count onto its own column', async () => {
      // Distinct values throughout, so a transposed pair cannot pass.
      await repo.record({
        portal: 'MAGICBRICKS',
        status: RealtyParserHealthStatus.DEGRADED,
        sampleCount: 9,
        passCount: 5,
        failCount: 3,
        emptyCount: 1,
        details: { missingFields: ['phone'] },
      });

      expect(prisma.realty_parser_health_checks.create).toHaveBeenCalledWith({
        data: {
          portal: 'MAGICBRICKS',
          status: RealtyParserHealthStatus.DEGRADED,
          sample_count: 9,
          pass_count: 5,
          fail_count: 3,
          empty_count: 1,
          details: { missingFields: ['phone'] },
        },
      });
    });

    it('returns the created row', async () => {
      const created = checkRow();
      prisma.realty_parser_health_checks.create.mockResolvedValueOnce(created);

      await expect(
        repo.record({
          portal: '99ACRES',
          status: RealtyParserHealthStatus.HEALTHY,
          sampleCount: 3,
          passCount: 3,
          failCount: 0,
          emptyCount: 0,
          details: {},
        }),
      ).resolves.toBe(created);
    });
  });

  describe('latest', () => {
    it('takes the newest check for one portal', async () => {
      const row = checkRow();
      prisma.realty_parser_health_checks.findFirst.mockResolvedValueOnce(row);

      await expect(repo.latest('99ACRES')).resolves.toBe(row);
      expect(prisma.realty_parser_health_checks.findFirst).toHaveBeenCalledWith({
        where: { portal: '99ACRES' },
        // Descending, or "latest" means "oldest".
        orderBy: { checked_at: 'desc' },
      });
    });

    it('returns null for a portal that has never been checked', async () => {
      await expect(repo.latest('UNKNOWN_PORTAL')).resolves.toBeNull();
    });
  });

  describe('latestAll', () => {
    it('returns the row set as given', async () => {
      const rows = [checkRow(), checkRow({ id: 'chk-2', portal: 'HOUSING' })];
      prisma.$queryRaw.mockResolvedValueOnce(rows);

      await expect(repo.latestAll()).resolves.toEqual(rows);
    });

    /**
     * The reason this method is raw at all. Prisma's `distinct: ['portal']`
     * reads every health check ever written and de-duplicates in Node; the
     * table has no retention sweep and every row carries a `details` JSONB, so
     * that read only grows. `DISTINCT ON` makes Postgres stop at the first row
     * of each portal on the `(portal, checked_at DESC)` index.
     */
    it('de-duplicates in Postgres, not in Node', async () => {
      await repo.latestAll();

      expect(prisma.realty_parser_health_checks.findMany).not.toHaveBeenCalled();

      const sql = prisma.$queryRaw.mock.calls[0][0].join('?').replace(/\s+/g, ' ');
      expect(sql).toContain('DISTINCT ON (portal)');
      // DISTINCT ON picks the first row per group, so the ORDER BY has to lead
      // with the same expression and then sort by recency — otherwise Postgres
      // returns an arbitrary check rather than the latest one.
      expect(sql).toContain('ORDER BY portal ASC, checked_at DESC');
    });

    it('returns an empty list before any check has run', async () => {
      await expect(repo.latestAll()).resolves.toEqual([]);
    });
  });
});
