import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  realty_syndications,
  realty_reliability_scores,
  realty_resale_listings,
  realty_units,
  realty_projects,
} from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

export interface CreateSyndicationData {
  businessId: string;
  leadId: string;
  fromBusinessId: string;
  toBusinessId: string;
  developerId?: string | null;
  splitTerms: Prisma.InputJsonValue;
  buyerConsentAt?: Date | null;
}

export interface CreateResaleListingData {
  businessId: string;
  projectId?: string | null;
  locality: string;
  config: string;
  carpetSqft?: number | null;
  askingPrice: Prisma.Decimal;
  sellerPhone: string;
  verifiedAt?: Date | null;
}

export interface UpsertReliabilityScoreData {
  businessId: string;
  targetBusinessId: string;
  responseSpeedScore: number;
  showupIntegrityScore: number;
  splitHonoringScore: number;
  documentationHygieneScore: number;
  compositeScore: number;
  periodStart: Date;
  periodEnd: Date;
}

/** A network-supply unit joined with the slice of its project the matcher needs. */
export type ExchangeUnitCandidate = realty_units & {
  project: Pick<realty_projects, 'id' | 'name' | 'locality'>;
};

/**
 * RealtyExchangeRepository — all Prisma for the co-broking exchange.
 *
 * Ordinary CRUD is business_id scoped and soft-delete aware. Two deliberate
 * cross-tenant reads power the network and are called out inline: the exchange
 * supply lookups (another member's ACTIVE resale + EXCHANGE-visible units) and
 * the reliability aggregation (a member's deals on either side of the ledger).
 */
@Injectable()
export class RealtyExchangeRepository {
  private readonly logger = new Logger(RealtyExchangeRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Syndications ─────────────────────────────

  async createSyndication(data: CreateSyndicationData): Promise<realty_syndications> {
    return this.prisma.realty_syndications.create({
      data: {
        business_id: data.businessId,
        lead_id: data.leadId,
        from_business_id: data.fromBusinessId,
        to_business_id: data.toBusinessId,
        developer_id: data.developerId ?? null,
        split_terms: data.splitTerms,
        buyer_consent_at: data.buyerConsentAt ?? null,
      },
    });
  }

  /** Visible to either party of the deal (originator or counterparty). */
  async findSyndicationById(
    businessId: string,
    syndicationId: string,
  ): Promise<realty_syndications | null> {
    return this.prisma.realty_syndications.findFirst({
      where: {
        id: syndicationId,
        deleted_at: null,
        OR: [{ business_id: businessId }, { to_business_id: businessId }],
      },
    });
  }

  /**
   * Writable by either party of the deal, so the predicate mirrors
   * `findSyndicationById` rather than pinning `business_id` alone — the
   * counterparty legitimately drives ACCEPTED/VISIT/CLOSED transitions.
   */
  async updateSyndication(
    businessId: string,
    syndicationId: string,
    data: Prisma.realty_syndicationsUpdateInput,
  ): Promise<realty_syndications> {
    return this.prisma.realty_syndications.update({
      where: {
        id: syndicationId,
        OR: [{ business_id: businessId }, { to_business_id: businessId }],
      },
      data,
    });
  }

  async softDeleteSyndication(
    businessId: string,
    syndicationId: string,
  ): Promise<realty_syndications> {
    return this.prisma.realty_syndications.update({
      where: {
        id: syndicationId,
        OR: [{ business_id: businessId }, { to_business_id: businessId }],
      },
      data: { deleted_at: new Date() },
    });
  }

  async listSyndications(
    businessId: string,
    filters: { state?: realty_syndications['state']; role?: 'from' | 'to' },
  ): Promise<realty_syndications[]> {
    const where: Prisma.realty_syndicationsWhereInput = { deleted_at: null };
    if (filters.role === 'from') where.business_id = businessId;
    else if (filters.role === 'to') where.to_business_id = businessId;
    else where.OR = [{ business_id: businessId }, { to_business_id: businessId }];
    if (filters.state) where.state = filters.state;
    return this.prisma.realty_syndications.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Reliability input: every non-deleted syndication the member was party to,
   * on either side. Two-party by nature, so the predicate matches either the
   * originator column or the counterparty column — never neither.
   */
  async findSyndicationsInvolving(businessId: string): Promise<realty_syndications[]> {
    return this.prisma.realty_syndications.findMany({
      where: {
        deleted_at: null,
        // `business_id` mirrors `from_business_id` on every row (see the schema
        // and `createSyndication`), so naming the tenant column here is the same
        // set of rows — and makes the predicate legible as tenant-scoped.
        OR: [{ business_id: businessId }, { to_business_id: businessId }],
      },
      orderBy: { created_at: 'desc' },
    });
  }

  // ── Resale listings ──────────────────────────

  async createResaleListing(data: CreateResaleListingData): Promise<realty_resale_listings> {
    return this.prisma.realty_resale_listings.create({
      data: {
        business_id: data.businessId,
        project_id: data.projectId ?? null,
        locality: data.locality,
        config: data.config,
        carpet_sqft: data.carpetSqft ?? null,
        asking_price: data.askingPrice,
        seller_phone: data.sellerPhone,
        verified_at: data.verifiedAt ?? null,
      },
    });
  }

  async findResaleListingById(
    businessId: string,
    listingId: string,
  ): Promise<realty_resale_listings | null> {
    return this.prisma.realty_resale_listings.findFirst({
      where: { id: listingId, business_id: businessId, deleted_at: null },
    });
  }

  async updateResaleListing(
    businessId: string,
    listingId: string,
    data: Prisma.realty_resale_listingsUpdateInput,
  ): Promise<realty_resale_listings> {
    return this.prisma.realty_resale_listings.update({
      where: { id: listingId, business_id: businessId },
      data,
    });
  }

  async softDeleteResaleListing(
    businessId: string,
    listingId: string,
  ): Promise<realty_resale_listings> {
    return this.prisma.realty_resale_listings.update({
      where: { id: listingId, business_id: businessId },
      data: { deleted_at: new Date() },
    });
  }

  async listResaleListings(
    businessId: string,
    filters: { status?: realty_resale_listings['status']; locality?: string },
  ): Promise<realty_resale_listings[]> {
    const where: Prisma.realty_resale_listingsWhereInput = {
      business_id: businessId,
      deleted_at: null,
    };
    if (filters.status) where.status = filters.status;
    if (filters.locality) where.locality = { contains: filters.locality, mode: 'insensitive' };
    return this.prisma.realty_resale_listings.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
  }

  // ── Exchange supply (deliberate cross-tenant reads) ──

  /**
   * ACTIVE resale listings from OTHER businesses — the secondary-market half of
   * the network's matchable supply. Cross-tenant by design (that is the exchange).
   */
  async findExchangeResaleSupply(
    requesterBusinessId: string,
    filters: { locality?: string; config?: string },
  ): Promise<realty_resale_listings[]> {
    const where: Prisma.realty_resale_listingsWhereInput = {
      deleted_at: null,
      status: 'ACTIVE',
      business_id: { not: requesterBusinessId },
    };
    if (filters.locality) where.locality = { contains: filters.locality, mode: 'insensitive' };
    if (filters.config) where.config = { contains: filters.config, mode: 'insensitive' };
    return this.prisma.realty_resale_listings.findMany({ where });
  }

  /**
   * EXCHANGE-visible, AVAILABLE units from OTHER businesses — the primary-market
   * half of the matchable supply. Cross-tenant by design.
   */
  async findExchangeUnitSupply(requesterBusinessId: string): Promise<ExchangeUnitCandidate[]> {
    return this.prisma.realty_units.findMany({
      where: {
        deleted_at: null,
        availability: 'AVAILABLE',
        network_visibility: 'EXCHANGE',
        business_id: { not: requesterBusinessId },
      },
      include: { project: { select: { id: true, name: true, locality: true } } },
    });
  }

  // ── Reliability scores ───────────────────────

  async upsertReliabilityScore(
    data: UpsertReliabilityScoreData,
  ): Promise<realty_reliability_scores> {
    const scores = {
      response_speed_score: new Prisma.Decimal(data.responseSpeedScore),
      showup_integrity_score: new Prisma.Decimal(data.showupIntegrityScore),
      split_honoring_score: new Prisma.Decimal(data.splitHonoringScore),
      documentation_hygiene_score: new Prisma.Decimal(data.documentationHygieneScore),
      composite_score: new Prisma.Decimal(data.compositeScore),
      period_end: data.periodEnd,
    };
    return this.prisma.realty_reliability_scores.upsert({
      where: {
        business_id_target_business_id_period_start: {
          business_id: data.businessId,
          target_business_id: data.targetBusinessId,
          period_start: data.periodStart,
        },
      },
      create: {
        business_id: data.businessId,
        target_business_id: data.targetBusinessId,
        period_start: data.periodStart,
        ...scores,
      },
      update: scores,
    });
  }

  /** Latest scoring row a tenant holds for a target member. */
  async findLatestReliabilityScore(
    businessId: string,
    targetBusinessId: string,
  ): Promise<realty_reliability_scores | null> {
    return this.prisma.realty_reliability_scores.findFirst({
      where: { business_id: businessId, target_business_id: targetBusinessId },
      orderBy: { period_start: 'desc' },
    });
  }

  async listReliabilityScores(businessId: string): Promise<realty_reliability_scores[]> {
    return this.prisma.realty_reliability_scores.findMany({
      where: { business_id: businessId },
      orderBy: { composite_score: 'desc' },
    });
  }
}
