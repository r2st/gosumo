/**
 * RealtyInventory module unit tests.
 *
 * Coverage:
 *  1. Projects — create (event, paise→Decimal), get NotFound
 *  2. Units — create stamps verified_at only when AVAILABLE; setAvailability
 *     re-stamps verified_at and emits availability_changed; freshness flag
 *  3. Assets — publish auto-versions and supersedes the prior current asset + event
 *  4. Matching — match ad-hoc criteria; matchForLead reads the lead's BLTC and
 *     records matched unit ids back on the lead
 *
 * Repository, RealtyLeadsService, and EventEmitter2 are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ProjectStatus,
  UnitAvailability,
  RealtyAssetType,
} from '@gosumo/shared';

import { RealtyInventoryService } from './realty-inventory.service';
import { RealtyInventoryRepository } from './realty-inventory.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const PROJECT_ID = '00000000-0000-4000-a000-000000000100';
const UNIT_ID = '00000000-0000-4000-a000-000000000200';
const LEAD_ID = '00000000-0000-4000-a000-000000000300';

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
    amenities: [],
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

describe('RealtyInventoryService', () => {
  let service: RealtyInventoryService;
  let repository: jest.Mocked<RealtyInventoryRepository>;
  let leadsService: jest.Mocked<RealtyLeadsService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const mockRepository: Partial<Record<keyof RealtyInventoryRepository, jest.Mock>> = {
      createProject: jest.fn(),
      findProjectById: jest.fn(),
      updateProject: jest.fn(),
      softDeleteProject: jest.fn(),
      listProjects: jest.fn(),
      createUnit: jest.fn(),
      findUnitById: jest.fn(),
      updateUnit: jest.fn(),
      softDeleteUnit: jest.fn(),
      listUnitsByProject: jest.fn(),
      listUnitsByProjects: jest.fn(),
      findMatchCandidates: jest.fn(),
      createAsset: jest.fn(),
      findCurrentAsset: jest.fn(),
      supersedeCurrentAssets: jest.fn(),
      listAssetsByProject: jest.fn(),
    };
    const mockLeads: Partial<Record<keyof RealtyLeadsService, jest.Mock>> = {
      getLead: jest.fn(),
      setMatchedUnits: jest.fn(),
    };
    const mockEventEmitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyInventoryService,
        { provide: RealtyInventoryRepository, useValue: mockRepository },
        { provide: RealtyLeadsService, useValue: mockLeads },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get(RealtyInventoryService);
    repository = module.get(RealtyInventoryRepository) as jest.Mocked<RealtyInventoryRepository>;
    leadsService = module.get(RealtyLeadsService) as jest.Mocked<RealtyLeadsService>;
    eventEmitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── Projects ──
  describe('createProject', () => {
    it('creates a project, converts paise→Decimal, and emits an event', async () => {
      repository.createProject.mockResolvedValue(makeProject() as never);
      const result = await service.createProject(BUSINESS_ID, {
        name: 'Serene Heights',
        locality: 'Baner',
        status: ProjectStatus.UC,
        priceBandMinPaise: 900000000,
      });
      expect(repository.createProject).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BUSINESS_ID, locality: 'Baner' }),
      );
      const arg = repository.createProject.mock.calls[0]![0] as { priceBandMin: Prisma.Decimal };
      expect(arg.priceBandMin.mul(100).toNumber()).toBe(900000000);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.project.created',
        expect.objectContaining({ type: 'realty.project.created', locality: 'Baner' }),
      );
      expect(result.reraNumber).toBe('P52100012345');
    });

    it('parses a possession date and converts both price-band ends', async () => {
      repository.createProject.mockResolvedValue(makeProject() as never);

      await service.createProject(BUSINESS_ID, {
        name: 'Serene Heights',
        locality: 'Baner',
        status: ProjectStatus.UC,
        possessionDate: '2028-12-01T00:00:00.000Z',
        priceBandMaxPaise: 1500000000,
      });

      const arg = repository.createProject.mock.calls[0]![0] as {
        possessionDate: Date | null;
        priceBandMin: Prisma.Decimal | null;
        priceBandMax: Prisma.Decimal;
      };
      expect(arg.possessionDate).toEqual(new Date('2028-12-01T00:00:00.000Z'));
      // An omitted band end stays null rather than becoming Decimal(0), which
      // would read as "priced at zero" to the matcher.
      expect(arg.priceBandMin).toBeNull();
      expect(arg.priceBandMax.mul(100).toNumber()).toBe(1500000000);
    });

    it('emits an undefined reraNumber for a project registered without one', async () => {
      repository.createProject.mockResolvedValue(makeProject({ rera_number: null }) as never);

      await service.createProject(BUSINESS_ID, {
        name: 'Pre-RERA Plot',
        locality: 'Wagholi',
        status: ProjectStatus.UC,
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.project.created',
        expect.objectContaining({ reraNumber: undefined }),
      );
    });
  });

  describe('getProject', () => {
    it('throws NotFound for a missing project', async () => {
      repository.findProjectById.mockResolvedValue(null);
      await expect(service.getProject(BUSINESS_ID, PROJECT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── Units ──
  describe('createUnit', () => {
    it('stamps verified_at when created AVAILABLE', async () => {
      repository.findProjectById.mockResolvedValue(makeProject() as never);
      repository.createUnit.mockResolvedValue(makeUnit() as never);

      await service.createUnit(BUSINESS_ID, PROJECT_ID, {
        config: '2BHK',
        allInPricePaise: 920000000,
        availability: UnitAvailability.AVAILABLE,
      });

      const arg = repository.createUnit.mock.calls[0]![0] as { verifiedAt: Date | null };
      expect(arg.verifiedAt).toBeInstanceOf(Date);
    });

    it('does not stamp verified_at when UNVERIFIED', async () => {
      repository.findProjectById.mockResolvedValue(makeProject() as never);
      repository.createUnit.mockResolvedValue(makeUnit({ availability: 'UNVERIFIED', verified_at: null }) as never);

      await service.createUnit(BUSINESS_ID, PROJECT_ID, {
        config: '2BHK',
        allInPricePaise: 920000000,
        availability: UnitAvailability.UNVERIFIED,
      });

      const arg = repository.createUnit.mock.calls[0]![0] as { verifiedAt: Date | null };
      expect(arg.verifiedAt).toBeNull();
    });

    it('defaults an omitted availability to UNVERIFIED and converts an optional base price', async () => {
      repository.findProjectById.mockResolvedValue(makeProject() as never);
      repository.createUnit.mockResolvedValue(
        makeUnit({ availability: 'UNVERIFIED', verified_at: null }) as never,
      );

      await service.createUnit(BUSINESS_ID, PROJECT_ID, {
        config: '3BHK',
        allInPricePaise: 1200000000,
        basePricePaise: 1050000000,
      });

      const arg = repository.createUnit.mock.calls[0]![0] as {
        availability: string;
        verifiedAt: Date | null;
        basePrice: Prisma.Decimal;
      };
      // Defaulting to AVAILABLE would put an unchecked unit in front of buyers.
      expect(arg.availability).toBe(UnitAvailability.UNVERIFIED);
      expect(arg.verifiedAt).toBeNull();
      expect(arg.basePrice.mul(100).toNumber()).toBe(1050000000);
    });
  });

  describe('setAvailability', () => {
    it('re-stamps verified_at and emits availability_changed', async () => {
      repository.findUnitById.mockResolvedValue(makeUnit() as never);
      repository.updateUnit.mockResolvedValue(makeUnit({ availability: 'SOLD' }) as never);

      await service.setAvailability(BUSINESS_ID, UNIT_ID, UnitAvailability.SOLD);

      const data = repository.updateUnit.mock.calls[0]![2] as { availability: string; verified_at: Date };
      expect(data.availability).toBe('SOLD');
      expect(data.verified_at).toBeInstanceOf(Date);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.unit.availability_changed',
        expect.objectContaining({ availability: 'SOLD', unitId: UNIT_ID }),
      );
    });
  });

  describe('unit freshness flag', () => {
    it('marks a stale AVAILABLE unit as not fresh', async () => {
      const stale = makeUnit({ verified_at: new Date(Date.now() - 48 * 3600 * 1000) });
      repository.findProjectById.mockResolvedValue(makeProject() as never);
      repository.listUnitsByProject.mockResolvedValue([stale] as never);

      const units = await service.listUnits(BUSINESS_ID, PROJECT_ID);
      expect(units[0]!.isFresh).toBe(false);
    });

    it('marks a recently-verified AVAILABLE unit as fresh', async () => {
      repository.findProjectById.mockResolvedValue(makeProject() as never);
      repository.listUnitsByProject.mockResolvedValue([makeUnit()] as never);

      const units = await service.listUnits(BUSINESS_ID, PROJECT_ID);
      expect(units[0]!.isFresh).toBe(true);
    });
  });

  // ── Assets ──
  describe('publishAsset', () => {
    it('auto-versions and supersedes the prior current asset, then emits', async () => {
      repository.findProjectById.mockResolvedValue(makeProject() as never);
      repository.findCurrentAsset.mockResolvedValue({ version: 2 } as never);
      repository.supersedeCurrentAssets.mockResolvedValue(undefined as never);
      repository.createAsset.mockResolvedValue({
        id: 'a1',
        project_id: PROJECT_ID,
        type: 'PRICESHEET',
        url: 'https://cdn/x.pdf',
        wa_media_id: null,
        title: null,
        version: 3,
        is_current: true,
        created_at: new Date(),
      } as never);

      const result = await service.publishAsset(BUSINESS_ID, PROJECT_ID, {
        type: RealtyAssetType.PRICESHEET,
        url: 'https://cdn/x.pdf',
      });

      expect(repository.supersedeCurrentAssets).toHaveBeenCalledWith(BUSINESS_ID, PROJECT_ID, 'PRICESHEET');
      expect(repository.createAsset).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
      expect(result.version).toBe(3);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.asset.published',
        expect.objectContaining({ version: 3, assetType: 'PRICESHEET' }),
      );
    });

    it('starts at version 1 when no prior asset exists', async () => {
      repository.findProjectById.mockResolvedValue(makeProject() as never);
      repository.findCurrentAsset.mockResolvedValue(null);
      repository.supersedeCurrentAssets.mockResolvedValue(undefined as never);
      repository.createAsset.mockResolvedValue({
        id: 'a2', project_id: PROJECT_ID, type: 'BROCHURE', url: null, wa_media_id: null,
        title: null, version: 1, is_current: true, created_at: new Date(),
      } as never);

      await service.publishAsset(BUSINESS_ID, PROJECT_ID, { type: RealtyAssetType.BROCHURE });
      expect(repository.createAsset).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }));
    });
  });

  // ── Matching ──
  describe('match', () => {
    it('ranks fresh AVAILABLE candidates by fit', async () => {
      repository.findMatchCandidates.mockResolvedValue([
        { ...makeUnit({ id: 'u1', all_in_price: new Prisma.Decimal('9200000') }), project: { id: PROJECT_ID, name: 'Serene Heights', locality: 'Baner' } },
      ] as never);

      const matches = await service.match(BUSINESS_ID, {
        budgetMaxPaise: 950000000,
        localities: ['Baner'],
        config: '2BHK',
      });

      expect(matches).toHaveLength(1);
      expect(matches[0]!.projectName).toBe('Serene Heights');
      expect(matches[0]!.fitScore).toBeGreaterThan(0);
    });

    it('treats an unconstrained query as null criteria and returns the top 3', async () => {
      repository.findMatchCandidates.mockResolvedValue(
        ['u1', 'u2', 'u3', 'u4'].map((id) => ({
          ...makeUnit({ id }),
          project: { id: PROJECT_ID, name: 'Serene Heights', locality: 'Baner' },
        })) as never,
      );

      const matches = await service.match(BUSINESS_ID, {});

      expect(matches).toHaveLength(3);
      expect(matches.every((m) => m.projectName === 'Serene Heights')).toBe(true);
    });

    it('scores a candidate with no all-in price as 0 paise instead of skipping it', async () => {
      repository.findMatchCandidates.mockResolvedValue([
        {
          ...makeUnit({ id: 'u1', all_in_price: null }),
          project: { id: PROJECT_ID, name: 'Serene Heights', locality: 'Baner' },
        },
      ] as never);

      const matches = await service.match(BUSINESS_ID, { localities: ['Baner'] });

      expect(matches[0]).toMatchObject({ unitId: 'u1', allInPricePaise: 0 });
    });
  });

  describe('matchForLead', () => {
    it('reads the lead BLTC, matches, and records matched unit ids on the lead', async () => {
      leadsService.getLead.mockResolvedValue({
        bltc: {
          budgetMinPaise: 850000000,
          budgetMaxPaise: 950000000,
          localities: ['Baner'],
          timelineMonths: 6,
          config: '2BHK',
          purpose: 'END_USE',
          financing: 'NEEDS_LOAN',
        },
      } as never);
      repository.findMatchCandidates.mockResolvedValue([
        { ...makeUnit({ id: 'u1' }), project: { id: PROJECT_ID, name: 'Serene Heights', locality: 'Baner' } },
      ] as never);
      leadsService.setMatchedUnits.mockResolvedValue({} as never);

      const matches = await service.matchForLead(BUSINESS_ID, LEAD_ID, 3);

      expect(matches[0]!.unitId).toBe('u1');
      expect(leadsService.setMatchedUnits).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, ['u1']);
    });

    it('defaults to the top 3 matches when the caller omits a limit', async () => {
      leadsService.getLead.mockResolvedValue({
        bltc: {
          budgetMinPaise: null,
          budgetMaxPaise: 950000000,
          localities: ['Baner'],
          timelineMonths: null,
          config: '2BHK',
          purpose: null,
          financing: null,
        },
      } as never);
      repository.findMatchCandidates.mockResolvedValue(
        ['u1', 'u2', 'u3', 'u4'].map((id) => ({
          ...makeUnit({ id }),
          project: { id: PROJECT_ID, name: 'Serene Heights', locality: 'Baner' },
        })) as never,
      );
      leadsService.setMatchedUnits.mockResolvedValue({} as never);

      const matches = await service.matchForLead(BUSINESS_ID, LEAD_ID);

      expect(matches).toHaveLength(3);
      expect(leadsService.setMatchedUnits).toHaveBeenCalledWith(BUSINESS_ID, LEAD_ID, [
        'u1',
        'u2',
        'u3',
      ]);
    });
  });

  // ── Bulk / single reads ──
  describe('listUnitsForProjects', () => {
    it('maps each project bucket to DTOs without re-verifying project ownership', async () => {
      repository.listUnitsByProjects.mockResolvedValue(
        new Map([
          [PROJECT_ID, [makeUnit({ id: 'u1' }), makeUnit({ id: 'u2' })]],
          ['project-b', [makeUnit({ id: 'u3', project_id: 'project-b' })]],
        ]) as never,
      );

      const result = await service.listUnitsForProjects(BUSINESS_ID, [PROJECT_ID, 'project-b']);

      expect(repository.listUnitsByProjects).toHaveBeenCalledWith(BUSINESS_ID, [
        PROJECT_ID,
        'project-b',
      ]);
      expect(repository.findProjectById).not.toHaveBeenCalled();
      expect(result.get(PROJECT_ID)!.map((u) => u.id)).toEqual(['u1', 'u2']);
      expect(result.get('project-b')![0]!.projectId).toBe('project-b');
    });

    it('returns an empty map when no project has units', async () => {
      repository.listUnitsByProjects.mockResolvedValue(new Map() as never);

      expect((await service.listUnitsForProjects(BUSINESS_ID, [PROJECT_ID])).size).toBe(0);
    });
  });

  describe('getUnit', () => {
    it('returns the mapped unit', async () => {
      repository.findUnitById.mockResolvedValue(makeUnit() as never);

      const unit = await service.getUnit(BUSINESS_ID, UNIT_ID);

      expect(unit).toMatchObject({ id: UNIT_ID, config: '2BHK', allInPricePaise: 920000000 });
    });

    it('reports a priceless unit as 0 paise rather than null', async () => {
      repository.findUnitById.mockResolvedValue(makeUnit({ all_in_price: null }) as never);

      expect((await service.getUnit(BUSINESS_ID, UNIT_ID)).allInPricePaise).toBe(0);
    });

    it('throws NotFound for a unit outside the tenant', async () => {
      repository.findUnitById.mockResolvedValue(null);

      await expect(service.getUnit(BUSINESS_ID, UNIT_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listAssets', () => {
    it('verifies the project then maps its assets', async () => {
      repository.findProjectById.mockResolvedValue(makeProject() as never);
      repository.listAssetsByProject.mockResolvedValue([
        {
          id: 'a1',
          project_id: PROJECT_ID,
          type: 'PRICESHEET',
          url: 'https://cdn/x.pdf',
          wa_media_id: null,
          title: 'Aug price sheet',
          version: 2,
          is_current: true,
          created_at: new Date('2026-08-01T00:00:00Z'),
        },
      ] as never);

      const assets = await service.listAssets(BUSINESS_ID, PROJECT_ID);

      expect(assets).toEqual([
        expect.objectContaining({ id: 'a1', type: 'PRICESHEET', version: 2, isCurrent: true }),
      ]);
    });

    it('throws NotFound before touching assets when the project is missing', async () => {
      repository.findProjectById.mockResolvedValue(null);

      await expect(service.listAssets(BUSINESS_ID, PROJECT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.listAssetsByProject).not.toHaveBeenCalled();
    });
  });
});
