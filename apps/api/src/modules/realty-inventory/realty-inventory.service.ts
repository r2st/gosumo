import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { realty_projects, realty_units, realty_assets } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  UnitAvailability,
} from '@gosumo/shared';
import type {
  UnitMatch,
  RealtyProjectCreatedEvent,
  RealtyUnitAvailabilityChangedEvent,
  RealtyAssetPublishedEvent,
} from '@gosumo/shared';
import { RealtyInventoryRepository } from './realty-inventory.repository';
import type { CandidateUnit } from './realty-inventory.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { matchUnits } from './unit-matching.util';
import type { MatchCriteria, MatchCandidate } from './unit-matching.util';
import {
  CreateProjectDto,
  UpdateProjectDto,
  CreateUnitDto,
  UpdateUnitDto,
  CreateAssetDto,
  MatchQueryDto,
} from './dto';

// ── Money helpers (rupees Decimal ↔ paise at the boundary) ──
function paiseToDecimal(paise: number): Prisma.Decimal {
  return new Prisma.Decimal(paise).div(100);
}
function decimalToPaise(d: Prisma.Decimal | null): number | null {
  if (d === null || d === undefined) return null;
  return new Prisma.Decimal(d).mul(100).round().toNumber();
}

export interface ProjectResponseDto {
  id: string;
  businessId: string;
  name: string;
  developer: string | null;
  locality: string;
  reraNumber: string | null;
  possessionDate: Date | null;
  status: string;
  amenities: string[];
  priceBandMinPaise: number | null;
  priceBandMaxPaise: number | null;
  factSheetDocId: string | null;
  /**
   * CP commission terms (free-form JSON). PRIVATE — the AI/buyer-facing layer
   * strips this; it is only ever returned on this JWT-guarded broker console.
   */
  commissionTerms: Record<string, unknown>;
  networkVisibility: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UnitResponseDto {
  id: string;
  businessId: string;
  projectId: string;
  config: string;
  carpetSqft: number | null;
  builtupSqft: number | null;
  floor: number | null;
  facing: string | null;
  basePricePaise: number | null;
  allInPricePaise: number;
  availability: string;
  verifiedAt: Date | null;
  /** Whether the availability is fresh enough for the AI to assert (24h rule). */
  isFresh: boolean;
  networkVisibility: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetResponseDto {
  id: string;
  projectId: string;
  type: string;
  url: string | null;
  waMediaId: string | null;
  title: string | null;
  version: number;
  isCurrent: boolean;
  createdAt: Date;
}

const FRESHNESS_HOURS = 24;

/**
 * RealtyInventoryService — the grounding layer (blueprint §14). Verified projects,
 * units, and assets are the sole ground truth the AI may quote, and the matcher
 * turns a buyer's BLTC profile into the 1–3 best-fit AVAILABLE units.
 */
@Injectable()
export class RealtyInventoryService {
  private readonly logger = new Logger(RealtyInventoryService.name);

  constructor(
    private readonly repository: RealtyInventoryRepository,
    private readonly leadsService: RealtyLeadsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Projects ─────────────────────────────────

  async createProject(businessId: string, dto: CreateProjectDto): Promise<ProjectResponseDto> {
    const project = await this.repository.createProject({
      businessId,
      name: dto.name,
      locality: dto.locality,
      developer: dto.developer,
      reraNumber: dto.reraNumber,
      possessionDate: dto.possessionDate ? new Date(dto.possessionDate) : null,
      status: dto.status as realty_projects['status'],
      amenities: dto.amenities,
      priceBandMin: dto.priceBandMinPaise != null ? paiseToDecimal(dto.priceBandMinPaise) : null,
      priceBandMax: dto.priceBandMaxPaise != null ? paiseToDecimal(dto.priceBandMaxPaise) : null,
      factSheetDocId: dto.factSheetDocId,
      networkVisibility: dto.networkVisibility as realty_projects['network_visibility'],
    });

    this.emit<RealtyProjectCreatedEvent>('realty.project.created', {
      ...this.baseEvent(businessId),
      type: 'realty.project.created',
      projectId: project.id,
      reraNumber: project.rera_number ?? undefined,
      locality: project.locality,
    });
    this.logger.log(`Created project ${project.id} (${project.locality}) for ${businessId}`);
    return this.mapProject(project);
  }

  async getProject(businessId: string, projectId: string): Promise<ProjectResponseDto> {
    return this.mapProject(await this.mustFindProject(businessId, projectId));
  }

  async listProjects(
    businessId: string,
    filters: { locality?: string; status?: string },
  ): Promise<ProjectResponseDto[]> {
    const projects = await this.repository.listProjects(businessId, filters);
    return projects.map((p) => this.mapProject(p));
  }

  async updateProject(
    businessId: string,
    projectId: string,
    dto: UpdateProjectDto,
  ): Promise<ProjectResponseDto> {
    await this.mustFindProject(businessId, projectId);
    const d: Record<string, unknown> = {};
    if (dto.name !== undefined) d['name'] = dto.name;
    if (dto.locality !== undefined) d['locality'] = dto.locality;
    if (dto.developer !== undefined) d['developer'] = dto.developer;
    if (dto.reraNumber !== undefined) d['rera_number'] = dto.reraNumber;
    if (dto.possessionDate !== undefined) d['possession_date'] = new Date(dto.possessionDate);
    if (dto.status !== undefined) d['status'] = dto.status;
    if (dto.amenities !== undefined) d['amenities'] = dto.amenities;
    if (dto.priceBandMinPaise !== undefined) d['price_band_min'] = paiseToDecimal(dto.priceBandMinPaise);
    if (dto.priceBandMaxPaise !== undefined) d['price_band_max'] = paiseToDecimal(dto.priceBandMaxPaise);
    if (dto.networkVisibility !== undefined) d['network_visibility'] = dto.networkVisibility;
    if (dto.isActive !== undefined) d['is_active'] = dto.isActive;
    return this.mapProject(await this.repository.updateProject(businessId, projectId, d));
  }

  async deleteProject(businessId: string, projectId: string): Promise<void> {
    await this.mustFindProject(businessId, projectId);
    await this.repository.softDeleteProject(businessId, projectId);
  }

  // ── Units ────────────────────────────────────

  async createUnit(
    businessId: string,
    projectId: string,
    dto: CreateUnitDto,
  ): Promise<UnitResponseDto> {
    await this.mustFindProject(businessId, projectId);
    // Setting availability at creation stamps verified_at so freshness is honest.
    const availability = (dto.availability ?? UnitAvailability.UNVERIFIED) as realty_units['availability'];
    const unit = await this.repository.createUnit({
      businessId,
      projectId,
      config: dto.config,
      allInPrice: paiseToDecimal(dto.allInPricePaise),
      basePrice: dto.basePricePaise != null ? paiseToDecimal(dto.basePricePaise) : null,
      carpetSqft: dto.carpetSqft,
      builtupSqft: dto.builtupSqft,
      floor: dto.floor,
      facing: dto.facing,
      availability,
      verifiedAt: availability === UnitAvailability.AVAILABLE ? new Date() : null,
      networkVisibility: dto.networkVisibility as realty_units['network_visibility'],
    });
    return this.mapUnit(unit);
  }

  async listUnits(businessId: string, projectId: string): Promise<UnitResponseDto[]> {
    await this.mustFindProject(businessId, projectId);
    const units = await this.repository.listUnitsByProject(businessId, projectId);
    return units.map((u) => this.mapUnit(u));
  }

  /**
   * Units for many projects in one query, keyed by project id.
   *
   * Unlike `listUnits` this does not re-verify each project exists — the
   * caller supplies ids it just read for this tenant, and the query is
   * business-scoped, so a foreign id simply returns nothing.
   */
  async listUnitsForProjects(
    businessId: string,
    projectIds: string[],
  ): Promise<Map<string, UnitResponseDto[]>> {
    const rows = await this.repository.listUnitsByProjects(businessId, projectIds);
    const mapped = new Map<string, UnitResponseDto[]>();
    for (const [projectId, units] of rows) {
      mapped.set(projectId, units.map((u) => this.mapUnit(u)));
    }
    return mapped;
  }

  /** Fetch a single unit (used e.g. to resolve a lead's matched unit → project). */
  async getUnit(businessId: string, unitId: string): Promise<UnitResponseDto> {
    return this.mapUnit(await this.mustFindUnit(businessId, unitId));
  }

  async updateUnit(
    businessId: string,
    unitId: string,
    dto: UpdateUnitDto,
  ): Promise<UnitResponseDto> {
    await this.mustFindUnit(businessId, unitId);
    const d: Record<string, unknown> = {};
    if (dto.config !== undefined) d['config'] = dto.config;
    if (dto.allInPricePaise !== undefined) d['all_in_price'] = paiseToDecimal(dto.allInPricePaise);
    if (dto.basePricePaise !== undefined) d['base_price'] = paiseToDecimal(dto.basePricePaise);
    if (dto.carpetSqft !== undefined) d['carpet_sqft'] = dto.carpetSqft;
    if (dto.builtupSqft !== undefined) d['builtup_sqft'] = dto.builtupSqft;
    if (dto.floor !== undefined) d['floor'] = dto.floor;
    if (dto.facing !== undefined) d['facing'] = dto.facing;
    if (dto.networkVisibility !== undefined) d['network_visibility'] = dto.networkVisibility;
    return this.mapUnit(await this.repository.updateUnit(businessId, unitId, d));
  }

  /**
   * Set availability and re-stamp verified_at — the single action that keeps a
   * unit inside the 24h freshness window the AI checks before asserting availability.
   */
  async setAvailability(
    businessId: string,
    unitId: string,
    availability: UnitAvailability,
  ): Promise<UnitResponseDto> {
    const unit = await this.mustFindUnit(businessId, unitId);
    const updated = await this.repository.updateUnit(businessId, unitId, {
      availability,
      verified_at: new Date(),
    });
    this.emit<RealtyUnitAvailabilityChangedEvent>('realty.unit.availability_changed', {
      ...this.baseEvent(businessId),
      type: 'realty.unit.availability_changed',
      unitId,
      projectId: unit.project_id,
      availability,
    });
    return this.mapUnit(updated);
  }

  async deleteUnit(businessId: string, unitId: string): Promise<void> {
    await this.mustFindUnit(businessId, unitId);
    await this.repository.softDeleteUnit(businessId, unitId);
  }

  // ── Assets ───────────────────────────────────

  async publishAsset(
    businessId: string,
    projectId: string,
    dto: CreateAssetDto,
  ): Promise<AssetResponseDto> {
    await this.mustFindProject(businessId, projectId);
    const type = dto.type as realty_assets['type'];
    const current = await this.repository.findCurrentAsset(businessId, projectId, type);
    const version = (current?.version ?? 0) + 1;
    // Supersede any previous current asset of this type — prevents stale sends.
    await this.repository.supersedeCurrentAssets(businessId, projectId, type);

    const asset = await this.repository.createAsset({
      businessId,
      projectId,
      type,
      url: dto.url,
      waMediaId: dto.waMediaId,
      title: dto.title,
      version,
    });
    this.emit<RealtyAssetPublishedEvent>('realty.asset.published', {
      ...this.baseEvent(businessId),
      type: 'realty.asset.published',
      assetId: asset.id,
      projectId,
      assetType: type,
      version,
    });
    return this.mapAsset(asset);
  }

  async listAssets(businessId: string, projectId: string): Promise<AssetResponseDto[]> {
    await this.mustFindProject(businessId, projectId);
    const assets = await this.repository.listAssetsByProject(businessId, projectId);
    return assets.map((a) => this.mapAsset(a));
  }

  // ── Matching ─────────────────────────────────

  /** Rank the best-fit AVAILABLE + fresh units for an ad-hoc BLTC criteria set. */
  async match(businessId: string, query: MatchQueryDto): Promise<UnitMatch[]> {
    const criteria: MatchCriteria = {
      budgetMinPaise: query.budgetMinPaise ?? null,
      budgetMaxPaise: query.budgetMaxPaise ?? null,
      localities: query.localities,
      config: query.config ?? null,
    };
    const candidates = await this.loadCandidates(businessId);
    return matchUnits(criteria, candidates, query.limit ?? 3);
  }

  /**
   * Match a stored lead's BLTC profile and record the matched unit ids back on
   * the lead (so the hot-dossier and the AI can reference them).
   */
  async matchForLead(businessId: string, leadId: string, limit = 3): Promise<UnitMatch[]> {
    const lead = await this.leadsService.getLead(businessId, leadId);
    const criteria: MatchCriteria = {
      budgetMinPaise: lead.bltc.budgetMinPaise,
      budgetMaxPaise: lead.bltc.budgetMaxPaise,
      localities: lead.bltc.localities,
      config: lead.bltc.config,
    };
    const candidates = await this.loadCandidates(businessId);
    const matches = matchUnits(criteria, candidates, limit);
    await this.leadsService.setMatchedUnits(businessId, leadId, matches.map((m) => m.unitId));
    return matches;
  }

  private async loadCandidates(businessId: string): Promise<MatchCandidate[]> {
    const rows = await this.repository.findMatchCandidates(businessId, FRESHNESS_HOURS);
    return rows.map((u: CandidateUnit) => ({
      unitId: u.id,
      projectId: u.project_id,
      projectName: u.project.name,
      locality: u.project.locality,
      config: u.config,
      allInPricePaise: decimalToPaise(u.all_in_price) ?? 0,
    }));
  }

  // ── Helpers ──────────────────────────────────

  private async mustFindProject(businessId: string, projectId: string): Promise<realty_projects> {
    const p = await this.repository.findProjectById(businessId, projectId);
    if (!p) throw new NotFoundException(`Project ${projectId} not found`);
    return p;
  }

  private async mustFindUnit(businessId: string, unitId: string): Promise<realty_units> {
    const u = await this.repository.findUnitById(businessId, unitId);
    if (!u) throw new NotFoundException(`Unit ${unitId} not found`);
    return u;
  }

  private isFresh(unit: realty_units): boolean {
    if (unit.availability !== 'AVAILABLE' || !unit.verified_at) return false;
    return unit.verified_at.getTime() >= Date.now() - FRESHNESS_HOURS * 60 * 60 * 1000;
  }

  private baseEvent(businessId: string) {
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
    };
  }

  private emit<T>(name: string, payload: T): void {
    this.eventEmitter.emit(name, payload);
  }

  private mapProject(p: realty_projects): ProjectResponseDto {
    return {
      id: p.id,
      businessId: p.business_id,
      name: p.name,
      developer: p.developer,
      locality: p.locality,
      reraNumber: p.rera_number,
      possessionDate: p.possession_date,
      status: p.status,
      amenities: p.amenities ?? [],
      priceBandMinPaise: decimalToPaise(p.price_band_min),
      priceBandMaxPaise: decimalToPaise(p.price_band_max),
      factSheetDocId: p.fact_sheet_doc_id,
      commissionTerms: (p.commission_terms as Record<string, unknown> | null) ?? {},
      networkVisibility: p.network_visibility,
      isActive: p.is_active,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    };
  }

  private mapUnit(u: realty_units): UnitResponseDto {
    return {
      id: u.id,
      businessId: u.business_id,
      projectId: u.project_id,
      config: u.config,
      carpetSqft: u.carpet_sqft,
      builtupSqft: u.builtup_sqft,
      floor: u.floor,
      facing: u.facing,
      basePricePaise: decimalToPaise(u.base_price),
      allInPricePaise: decimalToPaise(u.all_in_price) ?? 0,
      availability: u.availability,
      verifiedAt: u.verified_at,
      isFresh: this.isFresh(u),
      networkVisibility: u.network_visibility,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
    };
  }

  private mapAsset(a: realty_assets): AssetResponseDto {
    return {
      id: a.id,
      projectId: a.project_id,
      type: a.type,
      url: a.url,
      waMediaId: a.wa_media_id,
      title: a.title,
      version: a.version,
      isCurrent: a.is_current,
      createdAt: a.created_at,
    };
  }
}
