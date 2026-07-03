import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import type { realty_syndications, realty_resale_listings, realty_reliability_scores } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
  SyndicationState,
  SettlementState,
  ResaleListingStatus,
} from '@gosumo/shared';
import type {
  SplitTerms,
  ExchangeMatch,
  ReliabilityScoreBreakdown,
  RealtySyndicationOfferedEvent,
  RealtySyndicationAcceptedEvent,
  RealtySyndicationClosedEvent,
  RealtySyndicationDisputedEvent,
} from '@gosumo/shared';
import { RealtyExchangeRepository } from './realty-exchange.repository';
import type { ExchangeUnitCandidate } from './realty-exchange.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';
import { matchExchange } from './exchange-matching.util';
import type { ExchangeCandidate, ExchangeCriteria } from './exchange-matching.util';
import { computeReliabilityScore } from './reliability-scoring.util';
import type { ReliabilitySignals } from './reliability-scoring.util';
import {
  CreateSyndicationDto,
  CloseSyndicationDto,
  RateSyndicationDto,
  CreateResaleListingDto,
  UpdateResaleListingDto,
} from './dto';

// ── Money helpers (rupees Decimal ↔ paise at the boundary) ──
function paiseToDecimal(paise: number): Prisma.Decimal {
  return new Prisma.Decimal(paise).div(100);
}
function decimalToPaise(d: Prisma.Decimal | null): number {
  if (d === null || d === undefined) return 0;
  return new Prisma.Decimal(d).mul(100).round().toNumber();
}
function decimalToNumber(d: Prisma.Decimal | null): number {
  if (d === null || d === undefined) return 0;
  return new Prisma.Decimal(d).toNumber();
}

/** Platform fee band on the commission pool (blueprint §19). Default sits mid-band. */
export const DEFAULT_PLATFORM_FEE_RATE = 0.06;
export const MIN_PLATFORM_FEE_RATE = 0.05;
export const MAX_PLATFORM_FEE_RATE = 0.08;

/** Reliability recompute window — one stable row per member per calendar month. */
function currentPeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface SyndicationResponseDto {
  id: string;
  businessId: string;
  leadId: string;
  fromBusinessId: string;
  toBusinessId: string;
  developerId: string | null;
  splitTerms: SplitTerms;
  buyerConsentAt: Date | null;
  state: string;
  commissionPoolPaise: number;
  platformFeePaise: number;
  settlementState: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResaleListingResponseDto {
  id: string;
  businessId: string;
  projectId: string | null;
  locality: string;
  config: string;
  carpetSqft: number | null;
  askingPricePaise: number;
  sellerPhone: string;
  status: string;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReliabilityScoreResponseDto {
  id: string;
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

export interface ExchangeMatchResult {
  leadId: string;
  matches: ExchangeMatch[];
  /** Optional AI-written note (OpenRouter). Null when disabled or unavailable. */
  aiRationale: string | null;
}

/** The neutral composite used for a counterparty with no scored history yet. */
const NEUTRAL_COMPOSITE = 50;

/**
 * RealtyExchangeService — the L2 co-broking exchange (blueprint §19).
 *
 * Formalises India's informal 50:50 deal-sharing into a trustable network:
 * an immutable syndication ledger with a strict state machine, buyer-consent
 * gating, platform-fee settlement, cross-network inventory matching ranked by
 * fit × counterparty reliability, resale supply, and reliability scoring.
 */
@Injectable()
export class RealtyExchangeService {
  private readonly logger = new Logger(RealtyExchangeService.name);

  constructor(
    private readonly repository: RealtyExchangeRepository,
    private readonly leadsService: RealtyLeadsService,
    private readonly llm: LlmClientService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Syndications ─────────────────────────────

  /**
   * Create an OFFERED syndication. Gated on the buyer's share consent (a lead
   * may only cross the network once the buyer has agreed) and a well-formed
   * split (percentages must sum to 100). Stamps buyer_consent_at at offer time.
   */
  async createSyndication(
    fromBusinessId: string,
    dto: CreateSyndicationDto,
  ): Promise<SyndicationResponseDto> {
    if (dto.toBusinessId === fromBusinessId) {
      throw new BadRequestException('Cannot syndicate a lead to your own business');
    }
    this.assertSplitValid(dto.splitTerms);

    // Buyer-consent gate — read the lead in the originator's tenant scope.
    const lead = await this.leadsService.getLead(fromBusinessId, dto.leadId);
    if (!lead.shareConsent) {
      throw new ForbiddenException(
        'Buyer has not consented to share this lead across the exchange',
      );
    }

    const syndication = await this.repository.createSyndication({
      businessId: fromBusinessId,
      leadId: dto.leadId,
      fromBusinessId,
      toBusinessId: dto.toBusinessId,
      developerId: dto.developerId ?? null,
      splitTerms: dto.splitTerms as unknown as Prisma.InputJsonValue,
      buyerConsentAt: new Date(),
    });

    this.emit<RealtySyndicationOfferedEvent>('realty.syndication.offered', {
      ...this.baseEvent(fromBusinessId),
      type: 'realty.syndication.offered',
      syndicationId: syndication.id,
      leadId: syndication.lead_id,
      fromBusinessId,
      toBusinessId: dto.toBusinessId,
    });
    this.logger.log(`Syndication ${syndication.id} OFFERED ${fromBusinessId} → ${dto.toBusinessId}`);
    return this.mapSyndication(syndication);
  }

  async getSyndication(businessId: string, syndicationId: string): Promise<SyndicationResponseDto> {
    return this.mapSyndication(await this.mustFindSyndication(businessId, syndicationId));
  }

  async listSyndications(
    businessId: string,
    filters: { state?: SyndicationState; role?: 'from' | 'to' },
  ): Promise<SyndicationResponseDto[]> {
    const rows = await this.repository.listSyndications(businessId, {
      state: filters.state as realty_syndications['state'] | undefined,
      role: filters.role,
    });
    return rows.map((s) => this.mapSyndication(s));
  }

  /** OFFERED → ACCEPTED (counterparty takes the deal on). */
  async acceptSyndication(businessId: string, syndicationId: string): Promise<SyndicationResponseDto> {
    const syndication = await this.mustFindSyndication(businessId, syndicationId);
    this.assertState(syndication, [SyndicationState.OFFERED]);
    const updated = await this.repository.updateSyndication(syndicationId, {
      state: SyndicationState.ACCEPTED,
    });
    this.emit<RealtySyndicationAcceptedEvent>('realty.syndication.accepted', {
      ...this.baseEvent(businessId),
      type: 'realty.syndication.accepted',
      syndicationId,
      leadId: syndication.lead_id,
      toBusinessId: syndication.to_business_id,
    });
    return this.mapSyndication(updated);
  }

  /** ACCEPTED → VISIT (the buyer physically visited with the counterparty). */
  async recordVisit(businessId: string, syndicationId: string): Promise<SyndicationResponseDto> {
    const syndication = await this.mustFindSyndication(businessId, syndicationId);
    this.assertState(syndication, [SyndicationState.ACCEPTED]);
    const updated = await this.repository.updateSyndication(syndicationId, {
      state: SyndicationState.VISIT,
    });
    return this.mapSyndication(updated);
  }

  /**
   * → CLOSED. Books the commission pool, computes the platform fee (5–8% band),
   * and moves settlement to PENDING. Allowed from ACCEPTED or VISIT (some deals
   * close without a fresh visit record).
   */
  async closeSyndication(
    businessId: string,
    syndicationId: string,
    dto: CloseSyndicationDto,
  ): Promise<SyndicationResponseDto> {
    const syndication = await this.mustFindSyndication(businessId, syndicationId);
    this.assertState(syndication, [SyndicationState.ACCEPTED, SyndicationState.VISIT]);

    const rate = this.resolveFeeRate(dto.platformFeeRate);
    const poolDecimal = paiseToDecimal(dto.commissionPoolPaise);
    const feeDecimal = poolDecimal.mul(rate);

    const updated = await this.repository.updateSyndication(syndicationId, {
      state: SyndicationState.CLOSED,
      commission_pool: poolDecimal,
      platform_fee: feeDecimal,
      settlement_state: SettlementState.PENDING,
    });

    this.emit<RealtySyndicationClosedEvent>('realty.syndication.closed', {
      ...this.baseEvent(businessId),
      type: 'realty.syndication.closed',
      syndicationId,
      leadId: syndication.lead_id,
      commissionPoolPaise: dto.commissionPoolPaise,
      platformFeePaise: decimalToPaise(feeDecimal),
    });
    this.logger.log(
      `Syndication ${syndicationId} CLOSED — pool ₹${poolDecimal.toString()} fee@${rate}`,
    );
    return this.mapSyndication(updated);
  }

  /** Any non-terminal state → EXPIRED (offer lapsed unaccepted or abandoned). */
  async expireSyndication(businessId: string, syndicationId: string): Promise<SyndicationResponseDto> {
    const syndication = await this.mustFindSyndication(businessId, syndicationId);
    this.assertState(syndication, [
      SyndicationState.OFFERED,
      SyndicationState.ACCEPTED,
      SyndicationState.VISIT,
    ]);
    const updated = await this.repository.updateSyndication(syndicationId, {
      state: SyndicationState.EXPIRED,
    });
    return this.mapSyndication(updated);
  }

  /** Any non-terminal, non-expired state → DISPUTED; unwinds any pending settlement. */
  async disputeSyndication(
    businessId: string,
    syndicationId: string,
    reason: string,
  ): Promise<SyndicationResponseDto> {
    const syndication = await this.mustFindSyndication(businessId, syndicationId);
    this.assertState(syndication, [
      SyndicationState.OFFERED,
      SyndicationState.ACCEPTED,
      SyndicationState.VISIT,
      SyndicationState.CLOSED,
    ]);
    const updated = await this.repository.updateSyndication(syndicationId, {
      state: SyndicationState.DISPUTED,
      settlement_state: SettlementState.REVERSED,
      metadata: this.mergeMetadata(syndication, { disputeReason: reason }),
    });
    this.emit<RealtySyndicationDisputedEvent>('realty.syndication.disputed', {
      ...this.baseEvent(businessId),
      type: 'realty.syndication.disputed',
      syndicationId,
      leadId: syndication.lead_id,
      reason,
    });
    return this.mapSyndication(updated);
  }

  /**
   * Post-deal rating that feeds the counterparty's reliability score. The rating
   * is stored keyed by the *rated* party (the other side of the deal), then that
   * member's composite is recomputed so the network view stays current.
   */
  async rateSyndication(
    syndicationId: string,
    ratingBusinessId: string,
    ratings: RateSyndicationDto,
  ): Promise<ReliabilityScoreResponseDto> {
    const syndication = await this.mustFindSyndication(ratingBusinessId, syndicationId);
    const ratedBusinessId = this.otherParty(syndication, ratingBusinessId);

    const existing = this.readRatings(syndication);
    existing[ratedBusinessId] = { ...(existing[ratedBusinessId] ?? {}), ...ratings };
    await this.repository.updateSyndication(syndicationId, {
      metadata: this.mergeMetadata(syndication, { ratings: existing }),
    });

    return this.calculateReliabilityScore(ratedBusinessId);
  }

  // ── Reliability ──────────────────────────────

  /**
   * Recompute a member's composite reliability from every deal they were party
   * to, and upsert it as the member's canonical self-row (business_id ==
   * target_business_id) for the current period. Returns the fresh breakdown.
   */
  async calculateReliabilityScore(
    targetBusinessId: string,
  ): Promise<ReliabilityScoreResponseDto> {
    const rows = await this.repository.findSyndicationsInvolving(targetBusinessId);
    const signals = this.buildSignals(targetBusinessId, rows);
    const breakdown = computeReliabilityScore(signals);

    const now = new Date();
    const periodStart = currentPeriodStart(now);
    const saved = await this.repository.upsertReliabilityScore({
      businessId: targetBusinessId,
      targetBusinessId,
      responseSpeedScore: breakdown.responseSpeedScore,
      showupIntegrityScore: breakdown.showupIntegrityScore,
      splitHonoringScore: breakdown.splitHonoringScore,
      documentationHygieneScore: breakdown.documentationHygieneScore,
      compositeScore: breakdown.compositeScore,
      periodStart,
      periodEnd: now,
    });
    return this.mapReliability(saved);
  }

  async listReliabilityScores(businessId: string): Promise<ReliabilityScoreResponseDto[]> {
    const rows = await this.repository.listReliabilityScores(businessId);
    return rows.map((r) => this.mapReliability(r));
  }

  // ── Matching ─────────────────────────────────

  /**
   * Find matching verified supply from OTHER businesses on the network for a
   * lead, ranked by BLTC fit blended with the counterparty's reliability. This
   * is the liquidity engine of the exchange. Optionally attaches an AI-written
   * rationale (OpenRouter) — best-effort, never blocks the deterministic result.
   */
  async matchLeadToExchange(
    businessId: string,
    leadId: string,
    opts: { limit?: number; aiRationale?: boolean } = {},
  ): Promise<ExchangeMatchResult> {
    const lead = await this.leadsService.getLead(businessId, leadId);
    const criteria: ExchangeCriteria = {
      budgetMinPaise: lead.bltc.budgetMinPaise,
      budgetMaxPaise: lead.bltc.budgetMaxPaise,
      localities: lead.bltc.localities,
      config: lead.bltc.config,
    };

    const candidates = await this.loadExchangeSupply(businessId, {
      localities: lead.bltc.localities,
      config: lead.bltc.config,
    });
    const matches = matchExchange(criteria, candidates, opts.limit ?? 5);

    let aiRationale: string | null = null;
    if (opts.aiRationale && matches.length > 0) {
      aiRationale = await this.generateMatchRationale(lead, matches);
    }
    return { leadId, matches, aiRationale };
  }

  /**
   * Assemble cross-network supply (other members' ACTIVE resale + EXCHANGE units)
   * and attach each owner's cached composite reliability (neutral if unscored).
   */
  private async loadExchangeSupply(
    requesterBusinessId: string,
    filters: { localities: string[]; config: string | null },
  ): Promise<ExchangeCandidate[]> {
    const locality = filters.localities[0];
    const [resale, units] = await Promise.all([
      this.repository.findExchangeResaleSupply(requesterBusinessId, {
        // Locality/config are soft pre-filters; the scorer does the real ranking.
        locality: undefined,
        config: undefined,
      }),
      this.repository.findExchangeUnitSupply(requesterBusinessId),
    ]);
    void locality;

    const ownerIds = new Set<string>([
      ...resale.map((r) => r.business_id),
      ...units.map((u) => u.business_id),
    ]);
    const reliabilityByOwner = new Map<string, number>();
    await Promise.all(
      [...ownerIds].map(async (ownerId) => {
        const self = await this.repository.findLatestReliabilityScore(ownerId, ownerId);
        reliabilityByOwner.set(ownerId, self ? decimalToNumber(self.composite_score) : NEUTRAL_COMPOSITE);
      }),
    );

    const resaleCandidates: ExchangeCandidate[] = resale.map((r) => ({
      listingId: r.id,
      sourceType: 'RESALE',
      ownerBusinessId: r.business_id,
      projectName: null,
      locality: r.locality,
      config: r.config,
      askingPricePaise: decimalToPaise(r.asking_price),
      reliabilityScore: reliabilityByOwner.get(r.business_id) ?? NEUTRAL_COMPOSITE,
    }));

    const unitCandidates: ExchangeCandidate[] = units.map((u: ExchangeUnitCandidate) => ({
      listingId: u.id,
      sourceType: 'UNIT',
      ownerBusinessId: u.business_id,
      projectName: u.project.name,
      locality: u.project.locality,
      config: u.config,
      askingPricePaise: decimalToPaise(u.all_in_price),
      reliabilityScore: reliabilityByOwner.get(u.business_id) ?? NEUTRAL_COMPOSITE,
    }));

    return [...resaleCandidates, ...unitCandidates];
  }

  /** Best-effort OpenRouter rationale. Degrades to null on any error. */
  private async generateMatchRationale(
    lead: { bltc: { config: string | null; localities: string[] } },
    matches: ExchangeMatch[],
  ): Promise<string | null> {
    try {
      const top = matches.slice(0, 3).map(
        (m, i) =>
          `${i + 1}. ${m.config} in ${m.locality} — fit ${m.fitScore}, reliability ${m.reliabilityScore}`,
      );
      const result = await this.llm.complete({
        system:
          'You are a co-broking desk assistant for Indian real estate. In 2 sentences, ' +
          'advise a broker which network match to syndicate first and why, weighing buyer ' +
          'fit against counterparty reliability. Be concrete and concise.',
        user:
          `Buyer wants ${lead.bltc.config ?? 'any config'} in ` +
          `${lead.bltc.localities.join(', ') || 'any locality'}.\nTop matches:\n${top.join('\n')}`,
        temperature: 0.3,
        maxTokens: 160,
      });
      return result.text || null;
    } catch (err) {
      this.logger.warn(`AI rationale unavailable: ${(err as Error).message}`);
      return null;
    }
  }

  // ── Resale listings ──────────────────────────

  async createResaleListing(
    businessId: string,
    dto: CreateResaleListingDto,
  ): Promise<ResaleListingResponseDto> {
    const listing = await this.repository.createResaleListing({
      businessId,
      projectId: dto.projectId ?? null,
      locality: dto.locality,
      config: dto.config,
      carpetSqft: dto.carpetSqft ?? null,
      askingPrice: paiseToDecimal(dto.askingPricePaise),
      sellerPhone: dto.sellerPhone,
      verifiedAt: new Date(),
    });
    return this.mapResale(listing);
  }

  async listResaleListings(
    businessId: string,
    filters: { status?: ResaleListingStatus; locality?: string },
  ): Promise<ResaleListingResponseDto[]> {
    const rows = await this.repository.listResaleListings(businessId, {
      status: filters.status as realty_resale_listings['status'] | undefined,
      locality: filters.locality,
    });
    return rows.map((r) => this.mapResale(r));
  }

  async getResaleListing(businessId: string, listingId: string): Promise<ResaleListingResponseDto> {
    return this.mapResale(await this.mustFindResale(businessId, listingId));
  }

  async updateResaleListing(
    businessId: string,
    listingId: string,
    dto: UpdateResaleListingDto,
  ): Promise<ResaleListingResponseDto> {
    await this.mustFindResale(businessId, listingId);
    const data: Prisma.realty_resale_listingsUpdateInput = {};
    if (dto.locality !== undefined) data.locality = dto.locality;
    if (dto.config !== undefined) data.config = dto.config;
    if (dto.carpetSqft !== undefined) data.carpet_sqft = dto.carpetSqft;
    if (dto.askingPricePaise !== undefined) data.asking_price = paiseToDecimal(dto.askingPricePaise);
    if (dto.sellerPhone !== undefined) data.seller_phone = dto.sellerPhone;
    if (dto.status !== undefined) {
      data.status = dto.status;
      // Re-verify freshness whenever a seller reconfirms the listing is ACTIVE.
      if (dto.status === ResaleListingStatus.ACTIVE) data.verified_at = new Date();
    }
    return this.mapResale(await this.repository.updateResaleListing(listingId, data));
  }

  async deleteResaleListing(businessId: string, listingId: string): Promise<void> {
    await this.mustFindResale(businessId, listingId);
    await this.repository.softDeleteResaleListing(listingId);
  }

  // ── Helpers ──────────────────────────────────

  private resolveFeeRate(rate?: number): number {
    if (rate == null) return DEFAULT_PLATFORM_FEE_RATE;
    return Math.min(MAX_PLATFORM_FEE_RATE, Math.max(MIN_PLATFORM_FEE_RATE, rate));
  }

  private assertSplitValid(split: SplitTerms): void {
    const total = split.originatorPct + split.counterpartyPct + (split.developerPct ?? 0);
    if (total !== 100) {
      throw new BadRequestException(`Split terms must sum to 100 (got ${total})`);
    }
  }

  private assertState(syndication: realty_syndications, allowed: SyndicationState[]): void {
    if (!allowed.includes(syndication.state as SyndicationState)) {
      throw new BadRequestException(
        `Syndication is ${syndication.state}; expected one of ${allowed.join(', ')}`,
      );
    }
  }

  private otherParty(syndication: realty_syndications, actor: string): string {
    if (actor === syndication.from_business_id) return syndication.to_business_id;
    if (actor === syndication.to_business_id) return syndication.from_business_id;
    throw new ForbiddenException('Rating business is not a party to this syndication');
  }

  private buildSignals(
    memberId: string,
    rows: realty_syndications[],
  ): ReliabilitySignals {
    let visitsScheduled = 0;
    let visitsHonored = 0;
    let splitsHonored = 0;
    let syndicationsWithDocs = 0;
    const responseTimes: number[] = [];
    let disputes = 0;
    let syndicationsClosed = 0;

    for (const row of rows) {
      if (row.state === SyndicationState.DISPUTED) disputes += 1;
      if (row.state === SyndicationState.CLOSED) syndicationsClosed += 1;
      const rating = this.readRatings(row)[memberId];
      if (!rating) continue;
      if (typeof rating.responseMinutes === 'number') responseTimes.push(rating.responseMinutes);
      if (typeof rating.showedUp === 'boolean') {
        visitsScheduled += 1;
        if (rating.showedUp) visitsHonored += 1;
      }
      if (rating.splitHonored === true) splitsHonored += 1;
      if (rating.documented === true) syndicationsWithDocs += 1;
    }

    return {
      avgFirstResponseMinutes:
        responseTimes.length > 0
          ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
          : null,
      visitsScheduled,
      visitsHonored,
      syndicationsClosed,
      splitsHonored,
      disputes,
      syndicationsWithDocs,
      syndicationsTotal: rows.length,
    };
  }

  private readRatings(syndication: realty_syndications): Record<string, RatingRecord> {
    const meta = (syndication.metadata ?? {}) as { ratings?: Record<string, RatingRecord> };
    return { ...(meta.ratings ?? {}) };
  }

  private mergeMetadata(
    syndication: realty_syndications,
    patch: Record<string, unknown>,
  ): Prisma.InputJsonValue {
    const base = (syndication.metadata ?? {}) as Record<string, unknown>;
    return { ...base, ...patch } as Prisma.InputJsonValue;
  }

  private async mustFindSyndication(
    businessId: string,
    syndicationId: string,
  ): Promise<realty_syndications> {
    const s = await this.repository.findSyndicationById(businessId, syndicationId);
    if (!s) throw new NotFoundException(`Syndication ${syndicationId} not found`);
    return s;
  }

  private async mustFindResale(
    businessId: string,
    listingId: string,
  ): Promise<realty_resale_listings> {
    const r = await this.repository.findResaleListingById(businessId, listingId);
    if (!r) throw new NotFoundException(`Resale listing ${listingId} not found`);
    return r;
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

  private mapSyndication(s: realty_syndications): SyndicationResponseDto {
    return {
      id: s.id,
      businessId: s.business_id,
      leadId: s.lead_id,
      fromBusinessId: s.from_business_id,
      toBusinessId: s.to_business_id,
      developerId: s.developer_id,
      splitTerms: (s.split_terms ?? {}) as unknown as SplitTerms,
      buyerConsentAt: s.buyer_consent_at,
      state: s.state,
      commissionPoolPaise: decimalToPaise(s.commission_pool),
      platformFeePaise: decimalToPaise(s.platform_fee),
      settlementState: s.settlement_state,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    };
  }

  private mapResale(r: realty_resale_listings): ResaleListingResponseDto {
    return {
      id: r.id,
      businessId: r.business_id,
      projectId: r.project_id,
      locality: r.locality,
      config: r.config,
      carpetSqft: r.carpet_sqft,
      askingPricePaise: decimalToPaise(r.asking_price),
      sellerPhone: r.seller_phone,
      status: r.status,
      verifiedAt: r.verified_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private mapReliability(r: realty_reliability_scores): ReliabilityScoreResponseDto {
    return {
      id: r.id,
      businessId: r.business_id,
      targetBusinessId: r.target_business_id,
      responseSpeedScore: decimalToNumber(r.response_speed_score),
      showupIntegrityScore: decimalToNumber(r.showup_integrity_score),
      splitHonoringScore: decimalToNumber(r.split_honoring_score),
      documentationHygieneScore: decimalToNumber(r.documentation_hygiene_score),
      compositeScore: decimalToNumber(r.composite_score),
      periodStart: r.period_start,
      periodEnd: r.period_end,
    };
  }
}

/** A single stored rating about a member on one deal. */
interface RatingRecord {
  responseMinutes?: number;
  showedUp?: boolean;
  splitHonored?: boolean;
  documented?: boolean;
}
