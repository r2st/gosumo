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
  });
});
