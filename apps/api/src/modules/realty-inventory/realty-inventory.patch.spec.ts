/**
 * RealtyInventoryService — partial-update, listing, and freshness branches.
 *
 * `realty-inventory.spec.ts` covers creation, availability, assets and
 * matching. What it does not reach is the PATCH surface, and that surface is
 * where this module's remaining branches live: `updateProject` and `updateUnit`
 * are each a run of `!== undefined` guards translating camelCase DTO fields
 * onto snake_case columns.
 *
 * Two things make those guards worth testing rather than eyeballing:
 *
 *   - `undefined` and `null` must part ways. A broker clearing a possession
 *     date or unsetting a price band is sending `null`; a broker renaming a
 *     project is sending everything else as `undefined`. A truthiness check
 *     collapses the two and silently wipes columns on every edit.
 *   - Money crosses a boundary here. Prices arrive as integer paise and are
 *     stored as `Decimal` rupees, so each price guard has to convert, and
 *     converting `undefined` is how you write a `NaN` into a money column.
 *
 * `isFresh` is included for the same reason: it gates whether a unit can be
 * shown to a buyer at all, and its three branches (not available, never
 * verified, verified too long ago) all produce the same visible answer as a
 * fresh unit if the guard is wrong — a stale price quoted as current.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProjectStatus, UnitAvailability } from '@gosumo/shared';

import { RealtyInventoryService } from './realty-inventory.service';
import { RealtyInventoryRepository } from './realty-inventory.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const PROJECT_ID = '00000000-0000-4000-a000-000000000100';
const UNIT_ID = '00000000-0000-4000-a000-000000000200';

/** 92 lakh, the module's canonical paise↔Decimal example. */
const NINETY_TWO_LAKH_PAISE = 920_000_000;

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    business_id: BUSINESS_ID,
    name: 'Serene Heights',
    developer: 'Acme',
    locality: 'Baner',
    geo: null,
    rera_number: 'P52100012345',
    possession_date: null,
    status: 'UC',
    amenities: [] as string[],
    price_band_min: null as Prisma.Decimal | null,
    price_band_max: null as Prisma.Decimal | null,
    fact_sheet_doc_id: null,
    commission_terms: {},
    network_visibility: 'PRIVATE',
    is_active: true,
    metadata: {},
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

function makeUnit(overrides: Record<string, unknown> = {}) {
  return {
    id: UNIT_ID,
    business_id: BUSINESS_ID,
    project_id: PROJECT_ID,
    config: '2BHK',
    carpet_sqft: 1050,
    builtup_sqft: null,
    floor: 7,
    facing: 'East',
    base_price: null as Prisma.Decimal | null,
    all_in_price: new Prisma.Decimal('9200000'),
    availability: 'AVAILABLE',
    verified_at: new Date(),
    network_visibility: 'PRIVATE',
    metadata: {},
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

describe('RealtyInventoryService — partial updates and freshness', () => {
  let service: RealtyInventoryService;
  let repository: jest.Mocked<RealtyInventoryRepository>;

  beforeEach(async () => {
    const mockRepository: Partial<Record<keyof RealtyInventoryRepository, jest.Mock>> = {
      createProject: jest.fn(),
      findProjectById: jest.fn().mockResolvedValue(makeProject()),
      updateProject: jest.fn().mockResolvedValue(makeProject()),
      softDeleteProject: jest.fn().mockResolvedValue(makeProject()),
      listProjects: jest.fn().mockResolvedValue([makeProject()]),
      createUnit: jest.fn(),
      findUnitById: jest.fn().mockResolvedValue(makeUnit()),
      updateUnit: jest.fn().mockResolvedValue(makeUnit()),
      softDeleteUnit: jest.fn().mockResolvedValue(makeUnit()),
      listUnitsByProject: jest.fn().mockResolvedValue([makeUnit()]),
      findMatchCandidates: jest.fn().mockResolvedValue([]),
      createAsset: jest.fn(),
      findCurrentAsset: jest.fn(),
      supersedeCurrentAssets: jest.fn(),
      listAssetsByProject: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyInventoryService,
        { provide: RealtyInventoryRepository, useValue: mockRepository },
        {
          provide: RealtyLeadsService,
          useValue: { getLead: jest.fn(), setMatchedUnits: jest.fn() },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(RealtyInventoryService);
    repository = module.get(RealtyInventoryRepository) as jest.Mocked<RealtyInventoryRepository>;
    jest.clearAllMocks();
  });

  const projectPatch = () =>
    repository.updateProject.mock.calls[0]?.[2] as Record<string, unknown>;
  const unitPatch = () => repository.updateUnit.mock.calls[0]?.[2] as Record<string, unknown>;

  // ─────────────────────────────────────────────
  // updateProject
  // ─────────────────────────────────────────────

  describe('updateProject', () => {
    it('404s before writing when the project is not this tenant\'s', async () => {
      repository.findProjectById.mockResolvedValue(null);

      await expect(
        service.updateProject(BUSINESS_ID, PROJECT_ID, { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(repository.updateProject).not.toHaveBeenCalled();
    });

    it('sends only the field the caller changed', async () => {
      await service.updateProject(BUSINESS_ID, PROJECT_ID, { name: 'Serene Heights II' });

      expect(projectPatch()).toEqual({ name: 'Serene Heights II' });
    });

    it('sends nothing at all for an empty patch', async () => {
      // An empty object is a valid no-op PATCH; it must not become a write of
      // undefineds across every column.
      await service.updateProject(BUSINESS_ID, PROJECT_ID, {});

      expect(projectPatch()).toEqual({});
    });

    it('maps every DTO field onto its column', async () => {
      await service.updateProject(BUSINESS_ID, PROJECT_ID, {
        name: 'Serene Heights II',
        locality: 'Balewadi',
        developer: 'Acme Developers',
        reraNumber: 'P52100099999',
        possessionDate: '2027-12-01T00:00:00.000Z',
        status: ProjectStatus.RTM,
        amenities: ['gym', 'pool'],
        priceBandMinPaise: NINETY_TWO_LAKH_PAISE,
        priceBandMaxPaise: 1_200_000_000,
        networkVisibility: 'NETWORK',
        isActive: false,
      } as never);

      expect(projectPatch()).toEqual({
        name: 'Serene Heights II',
        locality: 'Balewadi',
        developer: 'Acme Developers',
        rera_number: 'P52100099999',
        possession_date: new Date('2027-12-01T00:00:00.000Z'),
        status: ProjectStatus.RTM,
        amenities: ['gym', 'pool'],
        price_band_min: expect.anything(),
        price_band_max: expect.anything(),
        network_visibility: 'NETWORK',
        is_active: false,
      });
    });

    it('converts a price band from paise to rupees on the way to the column', async () => {
      // Root rule #4: stored in paise at the API boundary, Decimal rupees in
      // the column. 920_000_000 paise is ₹92,00,000.
      await service.updateProject(BUSINESS_ID, PROJECT_ID, {
        priceBandMinPaise: NINETY_TWO_LAKH_PAISE,
      } as never);

      expect(String(projectPatch()['price_band_min'])).toBe('9200000');
    });

    it('treats isActive: false as a change, not as an omission', async () => {
      // The regression a truthiness check produces: deactivating a project
      // becomes a silent no-op and it keeps showing to buyers.
      await service.updateProject(BUSINESS_ID, PROJECT_ID, { isActive: false } as never);

      expect(projectPatch()).toHaveProperty('is_active', false);
    });

    it('treats an empty amenities array as a change', async () => {
      await service.updateProject(BUSINESS_ID, PROJECT_ID, { amenities: [] } as never);

      expect(projectPatch()).toHaveProperty('amenities', []);
    });

    it('scopes the lookup and the write to the caller\'s tenant', async () => {
      await service.updateProject(BUSINESS_ID, PROJECT_ID, { name: 'X' });

      expect(repository.findProjectById).toHaveBeenCalledWith(BUSINESS_ID, PROJECT_ID);
      expect(repository.updateProject).toHaveBeenCalledWith(
        BUSINESS_ID,
        PROJECT_ID,
        expect.anything(),
      );
    });
  });

  // ─────────────────────────────────────────────
  // updateUnit
  // ─────────────────────────────────────────────

  describe('updateUnit', () => {
    it('404s before writing when the unit is not this tenant\'s', async () => {
      repository.findUnitById.mockResolvedValue(null);

      await expect(
        service.updateUnit(BUSINESS_ID, UNIT_ID, { floor: 9 } as never),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(repository.updateUnit).not.toHaveBeenCalled();
    });

    it('sends only the field the caller changed', async () => {
      await service.updateUnit(BUSINESS_ID, UNIT_ID, { floor: 9 } as never);

      expect(unitPatch()).toEqual({ floor: 9 });
    });

    it('maps every DTO field onto its column', async () => {
      await service.updateUnit(BUSINESS_ID, UNIT_ID, {
        config: '3BHK',
        allInPricePaise: NINETY_TWO_LAKH_PAISE,
        basePricePaise: 850_000_000,
        carpetSqft: 1250,
        builtupSqft: 1500,
        floor: 11,
        facing: 'West',
        networkVisibility: 'NETWORK',
      } as never);

      expect(unitPatch()).toEqual({
        config: '3BHK',
        all_in_price: expect.anything(),
        base_price: expect.anything(),
        carpet_sqft: 1250,
        builtup_sqft: 1500,
        floor: 11,
        facing: 'West',
        network_visibility: 'NETWORK',
      });
    });

    it('converts prices from paise rather than storing the integer', async () => {
      await service.updateUnit(BUSINESS_ID, UNIT_ID, {
        allInPricePaise: NINETY_TWO_LAKH_PAISE,
      } as never);

      expect(String(unitPatch()['all_in_price'])).toBe('9200000');
    });

    it('treats floor 0 as a change', async () => {
      // Ground floor is a real floor, and `0` is exactly the value a
      // truthiness check drops.
      await service.updateUnit(BUSINESS_ID, UNIT_ID, { floor: 0 } as never);

      expect(unitPatch()).toHaveProperty('floor', 0);
    });

    it('sends nothing at all for an empty patch', async () => {
      await service.updateUnit(BUSINESS_ID, UNIT_ID, {} as never);
      expect(unitPatch()).toEqual({});
    });
  });

  // ─────────────────────────────────────────────
  // Deletes stay soft and stay scoped
  // ─────────────────────────────────────────────

  describe('soft deletes', () => {
    it('refuses to delete a project the tenant cannot see', async () => {
      repository.findProjectById.mockResolvedValue(null);

      await expect(service.deleteProject(BUSINESS_ID, PROJECT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.softDeleteProject).not.toHaveBeenCalled();
    });

    it('soft-deletes a project it can see', async () => {
      await service.deleteProject(BUSINESS_ID, PROJECT_ID);

      // Root rule #5: business data is never hard-deleted.
      expect(repository.softDeleteProject).toHaveBeenCalledWith(BUSINESS_ID, PROJECT_ID);
    });

    it('refuses to delete a unit the tenant cannot see', async () => {
      repository.findUnitById.mockResolvedValue(null);

      await expect(service.deleteUnit(BUSINESS_ID, UNIT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.softDeleteUnit).not.toHaveBeenCalled();
    });

    it('soft-deletes a unit it can see', async () => {
      await service.deleteUnit(BUSINESS_ID, UNIT_ID);
      expect(repository.softDeleteUnit).toHaveBeenCalledWith(BUSINESS_ID, UNIT_ID);
    });
  });

  // ─────────────────────────────────────────────
  // Freshness — what a buyer is allowed to be shown
  // ─────────────────────────────────────────────

  describe('unit freshness', () => {
    /** Read the mapped `isFresh` for a unit row, via the listing path. */
    async function freshnessOf(unit: Record<string, unknown>): Promise<boolean> {
      repository.listUnitsByProject.mockResolvedValue([unit] as never);
      const [mapped] = await service.listUnits(BUSINESS_ID, PROJECT_ID);
      return mapped!.isFresh;
    }

    it('is fresh when available and verified just now', async () => {
      expect(await freshnessOf(makeUnit({ verified_at: new Date() }))).toBe(true);
    });

    it('is stale when the unit is not AVAILABLE, however recent the check', async () => {
      // A unit verified a minute ago but marked HOLD is not sellable; the
      // recency must not override the availability.
      expect(
        await freshnessOf(
          makeUnit({ availability: UnitAvailability.HOLD, verified_at: new Date() }),
        ),
      ).toBe(false);
    });

    it('is stale when it has never been verified', async () => {
      expect(await freshnessOf(makeUnit({ verified_at: null }))).toBe(false);
    });

    it('is stale once the verification ages out', async () => {
      // Quoting a price nobody has re-checked in days is how a buyer is told a
      // unit is available after it sold.
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      expect(await freshnessOf(makeUnit({ verified_at: longAgo }))).toBe(false);
    });
  });

  // ─────────────────────────────────────────────
  // Mapping — nullable columns get usable defaults
  // ─────────────────────────────────────────────

  describe('response mapping', () => {
    it('defaults absent amenities and commission terms rather than emitting null', async () => {
      repository.listProjects.mockResolvedValue([
        makeProject({ amenities: null, commission_terms: null }),
      ] as never);

      const [project] = await service.listProjects(BUSINESS_ID, {} as never);

      expect(project!.amenities).toEqual([]);
      expect(project!.commissionTerms).toEqual({});
    });

    it('preserves amenities and commission terms when present', async () => {
      repository.listProjects.mockResolvedValue([
        makeProject({ amenities: ['gym'], commission_terms: { pct: 2 } }),
      ] as never);

      const [project] = await service.listProjects(BUSINESS_ID, {} as never);

      expect(project!.amenities).toEqual(['gym']);
      expect(project!.commissionTerms).toEqual({ pct: 2 });
    });

    it('exposes prices as integer paise', async () => {
      repository.listProjects.mockResolvedValue([
        makeProject({ price_band_min: new Prisma.Decimal('9200000') }),
      ] as never);

      const [project] = await service.listProjects(BUSINESS_ID, {} as never);

      expect(project!.priceBandMinPaise).toBe(NINETY_TWO_LAKH_PAISE);
    });

    it('reports a missing all-in price as 0 rather than null', async () => {
      // `allInPricePaise` is non-nullable on the DTO; a null column would
      // otherwise reach the dashboard as `null` and render as "NaN".
      repository.listUnitsByProject.mockResolvedValue([
        makeUnit({ all_in_price: null, base_price: null }),
      ] as never);

      const [unit] = await service.listUnits(BUSINESS_ID, PROJECT_ID);

      expect(unit!.allInPricePaise).toBe(0);
      expect(unit!.basePricePaise).toBeNull();
    });
  });
});
