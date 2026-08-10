import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { realty_projects, realty_units, realty_assets } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

export interface CreateProjectData {
  businessId: string;
  name: string;
  locality: string;
  developer?: string | null;
  reraNumber?: string | null;
  possessionDate?: Date | null;
  status?: realty_projects['status'];
  amenities?: string[];
  priceBandMin?: Prisma.Decimal | null;
  priceBandMax?: Prisma.Decimal | null;
  factSheetDocId?: string | null;
  networkVisibility?: realty_projects['network_visibility'];
}

export interface CreateUnitData {
  businessId: string;
  projectId: string;
  config: string;
  allInPrice: Prisma.Decimal;
  basePrice?: Prisma.Decimal | null;
  carpetSqft?: number | null;
  builtupSqft?: number | null;
  floor?: number | null;
  facing?: string | null;
  availability?: realty_units['availability'];
  verifiedAt?: Date | null;
  networkVisibility?: realty_units['network_visibility'];
}

export interface CreateAssetData {
  businessId: string;
  projectId: string;
  type: realty_assets['type'];
  url?: string | null;
  waMediaId?: string | null;
  title?: string | null;
  version: number;
}

/** A unit joined with a slice of its project, for the matcher. */
export type CandidateUnit = realty_units & {
  project: Pick<realty_projects, 'id' | 'name' | 'locality'>;
};

/**
 * RealtyInventoryRepository — all Prisma queries for projects, units, and assets.
 * Every query is business_id scoped and soft-delete aware.
 */
@Injectable()
export class RealtyInventoryRepository {
  private readonly logger = new Logger(RealtyInventoryRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Projects ─────────────────────────────────

  async createProject(data: CreateProjectData): Promise<realty_projects> {
    return this.prisma.realty_projects.create({
      data: {
        business_id: data.businessId,
        name: data.name,
        locality: data.locality,
        developer: data.developer ?? null,
        rera_number: data.reraNumber ?? null,
        possession_date: data.possessionDate ?? null,
        status: data.status ?? 'UC',
        amenities: data.amenities ?? [],
        price_band_min: data.priceBandMin ?? null,
        price_band_max: data.priceBandMax ?? null,
        fact_sheet_doc_id: data.factSheetDocId ?? null,
        network_visibility: data.networkVisibility ?? 'PRIVATE',
      },
    });
  }

  async findProjectById(businessId: string, projectId: string): Promise<realty_projects | null> {
    return this.prisma.realty_projects.findFirst({
      where: { id: projectId, business_id: businessId, deleted_at: null },
    });
  }

  async updateProject(
    businessId: string,
    projectId: string,
    data: Record<string, unknown>,
  ): Promise<realty_projects> {
    return this.prisma.realty_projects.update({ where: { id: projectId, business_id: businessId }, data });
  }

  async softDeleteProject(businessId: string, projectId: string): Promise<realty_projects> {
    return this.prisma.realty_projects.update({
      where: { id: projectId, business_id: businessId },
      data: { deleted_at: new Date(), is_active: false },
    });
  }

  async listProjects(
    businessId: string,
    filters: { locality?: string; status?: string },
  ): Promise<realty_projects[]> {
    const where: Prisma.realty_projectsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };
    if (filters.locality) where.locality = { contains: filters.locality, mode: 'insensitive' };
    if (filters.status) where.status = filters.status as realty_projects['status'];
    return this.prisma.realty_projects.findMany({
      where,
      orderBy: [{ is_active: 'desc' }, { created_at: 'desc' }],
    });
  }

  // ── Units ────────────────────────────────────

  async createUnit(data: CreateUnitData): Promise<realty_units> {
    return this.prisma.realty_units.create({
      data: {
        business_id: data.businessId,
        project_id: data.projectId,
        config: data.config,
        all_in_price: data.allInPrice,
        base_price: data.basePrice ?? null,
        carpet_sqft: data.carpetSqft ?? null,
        builtup_sqft: data.builtupSqft ?? null,
        floor: data.floor ?? null,
        facing: data.facing ?? null,
        availability: data.availability ?? 'UNVERIFIED',
        verified_at: data.verifiedAt ?? null,
        network_visibility: data.networkVisibility ?? 'PRIVATE',
      },
    });
  }

  async findUnitById(businessId: string, unitId: string): Promise<realty_units | null> {
    return this.prisma.realty_units.findFirst({
      where: { id: unitId, business_id: businessId, deleted_at: null },
    });
  }

  async updateUnit(
    businessId: string,
    unitId: string,
    data: Record<string, unknown>,
  ): Promise<realty_units> {
    return this.prisma.realty_units.update({ where: { id: unitId, business_id: businessId }, data });
  }

  async softDeleteUnit(businessId: string, unitId: string): Promise<realty_units> {
    return this.prisma.realty_units.update({
      where: { id: unitId, business_id: businessId },
      data: { deleted_at: new Date() },
    });
  }

  async listUnitsByProject(businessId: string, projectId: string): Promise<realty_units[]> {
    return this.prisma.realty_units.findMany({
      where: { business_id: businessId, project_id: projectId, deleted_at: null },
      orderBy: [{ config: 'asc' }, { all_in_price: 'asc' }],
    });
  }

  /**
   * Candidate units for matching: AVAILABLE and verified within the freshness
   * window (default 24h). Stale/unverified units are excluded so the AI never
   * asserts availability it can't back with a fresh check (hard rule §14).
   */
  async findMatchCandidates(
    businessId: string,
    freshnessHours = 24,
  ): Promise<CandidateUnit[]> {
    const cutoff = new Date(Date.now() - freshnessHours * 60 * 60 * 1000);
    return this.prisma.realty_units.findMany({
      where: {
        business_id: businessId,
        deleted_at: null,
        availability: 'AVAILABLE',
        verified_at: { gte: cutoff },
      },
      include: { project: { select: { id: true, name: true, locality: true } } },
    });
  }

  // ── Assets ───────────────────────────────────

  async createAsset(data: CreateAssetData): Promise<realty_assets> {
    return this.prisma.realty_assets.create({
      data: {
        business_id: data.businessId,
        project_id: data.projectId,
        type: data.type,
        url: data.url ?? null,
        wa_media_id: data.waMediaId ?? null,
        title: data.title ?? null,
        version: data.version,
      },
    });
  }

  async findCurrentAsset(
    businessId: string,
    projectId: string,
    type: realty_assets['type'],
  ): Promise<realty_assets | null> {
    return this.prisma.realty_assets.findFirst({
      where: {
        business_id: businessId,
        project_id: projectId,
        type,
        is_current: true,
        deleted_at: null,
      },
      orderBy: { version: 'desc' },
    });
  }

  /** Supersede the current asset of the same type (versioning prevents stale sends). */
  async supersedeCurrentAssets(
    businessId: string,
    projectId: string,
    type: realty_assets['type'],
  ): Promise<void> {
    await this.prisma.realty_assets.updateMany({
      where: {
        business_id: businessId,
        project_id: projectId,
        type,
        is_current: true,
        deleted_at: null,
      },
      data: { is_current: false },
    });
  }

  async listAssetsByProject(businessId: string, projectId: string): Promise<realty_assets[]> {
    return this.prisma.realty_assets.findMany({
      where: { business_id: businessId, project_id: projectId, deleted_at: null },
      orderBy: [{ type: 'asc' }, { version: 'desc' }],
    });
  }
}
