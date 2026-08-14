/**
 * RealtyExchangeRepository unit tests.
 *
 * The exchange is the one place in the codebase where reads deliberately cross
 * tenants, so the predicates carry more weight than usual and are asserted
 * directly on the emitted query:
 *
 *  - Syndications are two-party. Every read/write must resolve for *either*
 *    side, never `business_id` alone, or the counterparty is locked out of the
 *    transitions it legitimately drives.
 *  - The two supply reads must exclude the requester (`business_id != me`) and
 *    hold their status gates (ACTIVE resale, AVAILABLE + EXCHANGE units) —
 *    those gates are the only thing keeping private inventory off the network.
 *  - Soft-delete filtering and optional-filter assembly on every list.
 *
 * PrismaService is mocked; the assertions are on the query, not on a DB.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { RealtyExchangeRepository } from './realty-exchange.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_ID = '00000000-0000-4000-a000-000000000002';
const LEAD_ID = '00000000-0000-4000-a000-000000000100';
const SYND_ID = '00000000-0000-4000-a000-000000000200';
const LISTING_ID = '00000000-0000-4000-a000-000000000300';

/** Either party of a deal resolves the row — never the tenant column alone. */
const EITHER_PARTY = [{ business_id: BUSINESS_ID }, { to_business_id: BUSINESS_ID }];

describe('RealtyExchangeRepository', () => {
  let repository: RealtyExchangeRepository;
  let prisma: {
    realty_syndications: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    realty_resale_listings: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
    realty_units: { findMany: jest.Mock };
    realty_reliability_scores: { upsert: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock };
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      realty_syndications: {
        create: jest.fn().mockResolvedValue({ id: SYND_ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: SYND_ID }),
      },
      realty_resale_listings: {
        create: jest.fn().mockResolvedValue({ id: LISTING_ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: LISTING_ID }),
      },
      realty_units: { findMany: jest.fn().mockResolvedValue([]) },
      realty_reliability_scores: {
        upsert: jest.fn().mockResolvedValue({ id: 'sc' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyExchangeRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(RealtyExchangeRepository);
  });

  // ── Syndications ─────────────────────────────

  describe('createSyndication', () => {
    const base = {
      businessId: BUSINESS_ID,
      leadId: LEAD_ID,
      fromBusinessId: BUSINESS_ID,
      toBusinessId: OTHER_ID,
      splitTerms: { originatorPct: 50, counterpartyPct: 50 },
    };

    it('writes the attribution columns and defaults the optional legs to null', async () => {
      await repository.createSyndication(base);

      expect(prisma.realty_syndications.create).toHaveBeenCalledWith({
        data: {
          business_id: BUSINESS_ID,
          lead_id: LEAD_ID,
          from_business_id: BUSINESS_ID,
          to_business_id: OTHER_ID,
          developer_id: null,
          split_terms: base.splitTerms,
          buyer_consent_at: null,
        },
      });
    });

    it('carries an explicit developer and consent stamp through', async () => {
      const consentAt = new Date('2026-08-01T00:00:00Z');
      await repository.createSyndication({
        ...base,
        developerId: 'dev-1',
        buyerConsentAt: consentAt,
      });

      const { data } = prisma.realty_syndications.create.mock.calls[0]![0];
      expect(data.developer_id).toBe('dev-1');
      expect(data.buyer_consent_at).toBe(consentAt);
    });
  });

  describe('findSyndicationById', () => {
    it('resolves for either party and skips soft-deleted rows', async () => {
      await repository.findSyndicationById(BUSINESS_ID, SYND_ID);

      expect(prisma.realty_syndications.findFirst).toHaveBeenCalledWith({
        where: { id: SYND_ID, deleted_at: null, OR: EITHER_PARTY },
      });
    });
  });

  describe('updateSyndication', () => {
    /**
     * The counterparty drives ACCEPTED/VISIT/CLOSED, so pinning `business_id`
     * here would leave those transitions unreachable for the side that performs
     * them. The predicate must mirror the read.
     */
    it('lets either party write, not just the originating tenant', async () => {
      await repository.updateSyndication(BUSINESS_ID, SYND_ID, { state: 'ACCEPTED' });

      expect(prisma.realty_syndications.update).toHaveBeenCalledWith({
        where: { id: SYND_ID, OR: EITHER_PARTY },
        data: { state: 'ACCEPTED' },
      });
    });
  });

  describe('softDeleteSyndication', () => {
    it('stamps deleted_at rather than removing the ledger row', async () => {
      await repository.softDeleteSyndication(BUSINESS_ID, SYND_ID);

      const call = prisma.realty_syndications.update.mock.calls[0]![0];
      expect(call.where).toEqual({ id: SYND_ID, OR: EITHER_PARTY });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });
  });

  describe('listSyndications', () => {
    it('spans both sides of the ledger when no role is given', async () => {
      await repository.listSyndications(BUSINESS_ID, {});

      expect(prisma.realty_syndications.findMany).toHaveBeenCalledWith({
        where: { deleted_at: null, OR: EITHER_PARTY },
        orderBy: { created_at: 'desc' },
      });
    });

    it('narrows to deals the tenant originated', async () => {
      await repository.listSyndications(BUSINESS_ID, { role: 'from' });

      const { where } = prisma.realty_syndications.findMany.mock.calls[0]![0];
      expect(where).toEqual({ deleted_at: null, business_id: BUSINESS_ID });
      expect(where.OR).toBeUndefined();
    });

    it('narrows to deals routed to the tenant', async () => {
      await repository.listSyndications(BUSINESS_ID, { role: 'to' });

      const { where } = prisma.realty_syndications.findMany.mock.calls[0]![0];
      expect(where).toEqual({ deleted_at: null, to_business_id: BUSINESS_ID });
    });

    it('layers a state filter on top of the role predicate', async () => {
      await repository.listSyndications(BUSINESS_ID, { role: 'to', state: 'CLOSED' });

      const { where } = prisma.realty_syndications.findMany.mock.calls[0]![0];
      expect(where).toEqual({
        deleted_at: null,
        to_business_id: BUSINESS_ID,
        state: 'CLOSED',
      });
    });
  });

  describe('findSyndicationsInvolving', () => {
    it('collects every live deal the member was party to on either side', async () => {
      await repository.findSyndicationsInvolving(BUSINESS_ID);

      expect(prisma.realty_syndications.findMany).toHaveBeenCalledWith({
        where: { deleted_at: null, OR: EITHER_PARTY },
        orderBy: { created_at: 'desc' },
      });
    });
  });

  // ── Resale listings ──────────────────────────

  describe('createResaleListing', () => {
    const base = {
      businessId: BUSINESS_ID,
      locality: 'Baner',
      config: '2BHK',
      askingPrice: new Prisma.Decimal(10_000_000),
      sellerPhone: '+919999999999',
    };

    it('defaults the optional project, carpet area and verification to null', async () => {
      await repository.createResaleListing(base);

      const { data } = prisma.realty_resale_listings.create.mock.calls[0]![0];
      expect(data.project_id).toBeNull();
      expect(data.carpet_sqft).toBeNull();
      expect(data.verified_at).toBeNull();
      expect(data.business_id).toBe(BUSINESS_ID);
    });

    it('carries an explicit project, carpet area and verification stamp', async () => {
      const verifiedAt = new Date('2026-08-01T00:00:00Z');
      await repository.createResaleListing({
        ...base,
        projectId: 'p1',
        carpetSqft: 950,
        verifiedAt,
      });

      const { data } = prisma.realty_resale_listings.create.mock.calls[0]![0];
      expect(data.project_id).toBe('p1');
      expect(data.carpet_sqft).toBe(950);
      expect(data.verified_at).toBe(verifiedAt);
    });
  });

  describe('findResaleListingById', () => {
    it('scopes to the owning tenant and skips soft-deleted rows', async () => {
      await repository.findResaleListingById(BUSINESS_ID, LISTING_ID);

      expect(prisma.realty_resale_listings.findFirst).toHaveBeenCalledWith({
        where: { id: LISTING_ID, business_id: BUSINESS_ID, deleted_at: null },
      });
    });
  });

  describe('updateResaleListing', () => {
    it('pins the tenant on the update predicate', async () => {
      await repository.updateResaleListing(BUSINESS_ID, LISTING_ID, { locality: 'Wakad' });

      expect(prisma.realty_resale_listings.update).toHaveBeenCalledWith({
        where: { id: LISTING_ID, business_id: BUSINESS_ID },
        data: { locality: 'Wakad' },
      });
    });
  });

  describe('softDeleteResaleListing', () => {
    it('stamps deleted_at within the tenant scope', async () => {
      await repository.softDeleteResaleListing(BUSINESS_ID, LISTING_ID);

      const call = prisma.realty_resale_listings.update.mock.calls[0]![0];
      expect(call.where).toEqual({ id: LISTING_ID, business_id: BUSINESS_ID });
      expect(call.data.deleted_at).toBeInstanceOf(Date);
    });
  });

  describe('listResaleListings', () => {
    it('returns the tenant’s live listings when unfiltered', async () => {
      await repository.listResaleListings(BUSINESS_ID, {});

      expect(prisma.realty_resale_listings.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, deleted_at: null },
        orderBy: { created_at: 'desc' },
      });
    });

    it('adds a status filter when one is supplied', async () => {
      await repository.listResaleListings(BUSINESS_ID, { status: 'ACTIVE' });

      const { where } = prisma.realty_resale_listings.findMany.mock.calls[0]![0];
      expect(where.status).toBe('ACTIVE');
      expect(where.locality).toBeUndefined();
    });

    it('matches locality case-insensitively on a substring', async () => {
      await repository.listResaleListings(BUSINESS_ID, { locality: 'ban' });

      const { where } = prisma.realty_resale_listings.findMany.mock.calls[0]![0];
      expect(where.locality).toEqual({ contains: 'ban', mode: 'insensitive' });
    });

    it('combines status and locality', async () => {
      await repository.listResaleListings(BUSINESS_ID, { status: 'SOLD', locality: 'Wakad' });

      const { where } = prisma.realty_resale_listings.findMany.mock.calls[0]![0];
      expect(where).toEqual({
        business_id: BUSINESS_ID,
        deleted_at: null,
        status: 'SOLD',
        locality: { contains: 'Wakad', mode: 'insensitive' },
      });
    });
  });

  // ── Exchange supply (the deliberate cross-tenant reads) ──

  describe('findExchangeResaleSupply', () => {
    /**
     * This is one of exactly two reads in the module that leave the tenant. The
     * requester exclusion plus the ACTIVE gate is the whole safety story: without
     * them a member would see its own board back, or another member's withdrawn
     * and sold stock.
     */
    it('excludes the requester and exposes only ACTIVE, non-deleted supply', async () => {
      await repository.findExchangeResaleSupply(BUSINESS_ID, {});

      expect(prisma.realty_resale_listings.findMany).toHaveBeenCalledWith({
        where: {
          deleted_at: null,
          status: 'ACTIVE',
          business_id: { not: BUSINESS_ID },
        },
      });
    });

    it('applies the optional locality pre-filter', async () => {
      await repository.findExchangeResaleSupply(BUSINESS_ID, { locality: 'Baner' });

      const { where } = prisma.realty_resale_listings.findMany.mock.calls[0]![0];
      expect(where.locality).toEqual({ contains: 'Baner', mode: 'insensitive' });
      expect(where.config).toBeUndefined();
    });

    it('applies the optional config pre-filter', async () => {
      await repository.findExchangeResaleSupply(BUSINESS_ID, { config: '2BHK' });

      const { where } = prisma.realty_resale_listings.findMany.mock.calls[0]![0];
      expect(where.config).toEqual({ contains: '2BHK', mode: 'insensitive' });
    });

    it('keeps the requester exclusion when both pre-filters are set', async () => {
      await repository.findExchangeResaleSupply(BUSINESS_ID, {
        locality: 'Baner',
        config: '2BHK',
      });

      const { where } = prisma.realty_resale_listings.findMany.mock.calls[0]![0];
      expect(where.business_id).toEqual({ not: BUSINESS_ID });
      expect(where.status).toBe('ACTIVE');
    });
  });

  describe('findExchangeUnitSupply', () => {
    it('exposes only AVAILABLE, EXCHANGE-visible units from other members', async () => {
      await repository.findExchangeUnitSupply(BUSINESS_ID);

      expect(prisma.realty_units.findMany).toHaveBeenCalledWith({
        where: {
          deleted_at: null,
          availability: 'AVAILABLE',
          network_visibility: 'EXCHANGE',
          business_id: { not: BUSINESS_ID },
        },
        include: { project: { select: { id: true, name: true, locality: true } } },
      });
    });

    /** The matcher needs the project name and locality; nothing else leaks. */
    it('selects only the project slice the matcher consumes', async () => {
      await repository.findExchangeUnitSupply(BUSINESS_ID);

      const { include } = prisma.realty_units.findMany.mock.calls[0]![0];
      expect(Object.keys(include.project.select).sort()).toEqual(['id', 'locality', 'name']);
    });
  });

  // ── Reliability scores ───────────────────────

  describe('upsertReliabilityScore', () => {
    const data = {
      businessId: BUSINESS_ID,
      targetBusinessId: BUSINESS_ID,
      responseSpeedScore: 80,
      showupIntegrityScore: 70,
      splitHonoringScore: 90,
      documentationHygieneScore: 60,
      compositeScore: 76.5,
      periodStart: new Date('2026-08-01T00:00:00Z'),
      periodEnd: new Date('2026-08-10T00:00:00Z'),
    };

    it('keys the row on (business, target, period) so a month stays one row', async () => {
      await repository.upsertReliabilityScore(data);

      const call = prisma.realty_reliability_scores.upsert.mock.calls[0]![0];
      expect(call.where).toEqual({
        business_id_target_business_id_period_start: {
          business_id: BUSINESS_ID,
          target_business_id: BUSINESS_ID,
          period_start: data.periodStart,
        },
      });
    });

    it('converts the numeric scores to Decimal on both branches of the upsert', async () => {
      await repository.upsertReliabilityScore(data);

      const call = prisma.realty_reliability_scores.upsert.mock.calls[0]![0];
      expect(call.create.composite_score.toNumber()).toBe(76.5);
      expect(call.update.composite_score.toNumber()).toBe(76.5);
      expect(call.create.period_start).toBe(data.periodStart);
      // period_start is the key, so the update leg must not try to move it.
      expect(call.update.period_start).toBeUndefined();
      expect(call.update.period_end).toBe(data.periodEnd);
    });
  });

  describe('findLatestReliabilityScore', () => {
    it('takes the newest period for the (holder, target) pair', async () => {
      await repository.findLatestReliabilityScore(BUSINESS_ID, OTHER_ID);

      expect(prisma.realty_reliability_scores.findFirst).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID, target_business_id: OTHER_ID },
        orderBy: { period_start: 'desc' },
      });
    });
  });

  describe('findLatestSelfReliabilityScores', () => {
    /** The SQL of the last $queryRaw call, whitespace collapsed. */
    function lastRawSql(): string {
      const call = prisma.$queryRaw.mock.calls[prisma.$queryRaw.mock.calls.length - 1]!;
      return (call[0] as string[]).join('?').replace(/\s+/g, ' ').trim();
    }

    /** The interpolated values, in order, of the last $queryRaw call. */
    function lastRawParams(): unknown[] {
      const call = prisma.$queryRaw.mock.calls[prisma.$queryRaw.mock.calls.length - 1]!;
      return call.slice(1);
    }

    it('does not touch the database for an empty id list', async () => {
      expect(await repository.findLatestSelfReliabilityScores([])).toEqual(new Map());
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('reads one row per member regardless of how many are asked for', async () => {
      // DISTINCT ON is the whole point: the alternative is either a query per
      // member or every historical period read into Node to be reduced there.
      await repository.findLatestSelfReliabilityScores([BUSINESS_ID, OTHER_ID]);

      const sql = lastRawSql();
      expect(sql).toContain('DISTINCT ON (business_id)');
      expect(sql).toContain('ORDER BY business_id, period_start DESC');
    });

    it('restricts to canonical self-rows, not scores one member holds on another', async () => {
      // A member's canonical score is the row they hold on themselves. Without
      // this predicate the query would also return A's opinion of B and pick
      // whichever happened to be newest.
      await repository.findLatestSelfReliabilityScores([BUSINESS_ID]);
      expect(lastRawSql()).toContain('business_id = target_business_id');
    });

    it('binds the ids as a uuid array rather than interpolating them', async () => {
      await repository.findLatestSelfReliabilityScores([BUSINESS_ID, OTHER_ID]);

      expect(lastRawSql()).toContain('business_id = ANY(');
      expect(lastRawParams()).toEqual([[BUSINESS_ID, OTHER_ID]]);
    });

    it('de-duplicates the ids it is handed', async () => {
      await repository.findLatestSelfReliabilityScores([BUSINESS_ID, OTHER_ID, BUSINESS_ID]);
      expect(lastRawParams()).toEqual([[BUSINESS_ID, OTHER_ID]]);
    });

    it('keys the returned map by business, carrying the composite through', async () => {
      prisma.$queryRaw.mockResolvedValue([
        { business_id: BUSINESS_ID, composite_score: new Prisma.Decimal(72.5) },
        { business_id: OTHER_ID, composite_score: new Prisma.Decimal(41) },
      ]);

      const scores = await repository.findLatestSelfReliabilityScores([BUSINESS_ID, OTHER_ID]);

      expect(scores.size).toBe(2);
      expect(scores.get(BUSINESS_ID)!.toString()).toBe('72.5');
      expect(scores.get(OTHER_ID)!.toString()).toBe('41');
    });

    it('omits a member with no score row rather than inventing a zero', async () => {
      // The caller reads absence as "unscored" and substitutes the neutral 50.
      // A 0 here would mean "scored, and terrible" — a new member would never
      // be matched again.
      prisma.$queryRaw.mockResolvedValue([
        { business_id: BUSINESS_ID, composite_score: new Prisma.Decimal(72.5) },
      ]);

      const scores = await repository.findLatestSelfReliabilityScores([BUSINESS_ID, OTHER_ID]);
      expect(scores.has(OTHER_ID)).toBe(false);
    });
  });

  describe('listReliabilityScores', () => {
    it('lists the tenant’s scores strongest first', async () => {
      await repository.listReliabilityScores(BUSINESS_ID);

      expect(prisma.realty_reliability_scores.findMany).toHaveBeenCalledWith({
        where: { business_id: BUSINESS_ID },
        orderBy: { composite_score: 'desc' },
      });
    });
  });
});
