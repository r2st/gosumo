/**
 * RealtyExchange service unit tests.
 *
 * Coverage:
 *  1. createSyndication — consent gate, split validation, self-syndication guard, event
 *  2. State machine — accept/visit/close/expire/dispute + invalid-transition guards
 *  3. closeSyndication — platform-fee calc + clamp, settlement PENDING, closed event
 *  4. disputeSyndication — REVERSED settlement + disputed event
 *  5. rateSyndication — stores rating keyed by rated party, recomputes reliability
 *  6. calculateReliabilityScore — signal building from ledger + upsert
 *  7. matchLeadToExchange — supply assembly, reliability blend, AI rationale off by default
 *  8. Resale CRUD
 *
 * Repository, RealtyLeadsService, LlmClientService, and EventEmitter2 are mocked.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SyndicationState, SettlementState, ResaleListingStatus } from '@gosumo/shared';

import { RealtyExchangeService } from './realty-exchange.service';
import { RealtyExchangeRepository } from './realty-exchange.repository';
import { RealtyLeadsService } from '../realty-leads/realty-leads.service';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';

const FROM = '00000000-0000-4000-a000-000000000001';
const TO = '00000000-0000-4000-a000-000000000002';
const OTHER = '00000000-0000-4000-a000-000000000003';
const LEAD = '00000000-0000-4000-a000-000000000100';
const SYND = '00000000-0000-4000-a000-000000000200';
const LISTING = '00000000-0000-4000-a000-000000000300';

function makeSyndication(overrides: Record<string, unknown> = {}) {
  return {
    id: SYND,
    business_id: FROM,
    lead_id: LEAD,
    from_business_id: FROM,
    to_business_id: TO,
    developer_id: null,
    split_terms: { originatorPct: 50, counterpartyPct: 50 },
    buyer_consent_at: new Date('2026-07-01T00:00:00Z'),
    state: SyndicationState.OFFERED,
    commission_pool: new Prisma.Decimal(0),
    platform_fee: new Prisma.Decimal(0),
    settlement_state: SettlementState.UNSETTLED,
    metadata: {},
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

function makeResale(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING,
    business_id: FROM,
    project_id: null,
    locality: 'Baner',
    config: '2BHK',
    carpet_sqft: 950,
    asking_price: new Prisma.Decimal(10_000_000),
    seller_phone: '+919999999999',
    status: ResaleListingStatus.ACTIVE,
    verified_at: new Date('2026-07-01T00:00:00Z'),
    metadata: {},
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    deleted_at: null,
    ...overrides,
  };
}

function leadWith(overrides: Record<string, unknown> = {}) {
  return {
    id: LEAD,
    businessId: FROM,
    shareConsent: true,
    bltc: {
      budgetMinPaise: 800_000_000,
      budgetMaxPaise: 1_200_000_000,
      localities: ['Baner'],
      timelineMonths: 6,
      config: '2BHK',
      purpose: null,
      financing: null,
    },
    ...overrides,
  };
}

describe('RealtyExchangeService', () => {
  let service: RealtyExchangeService;
  let repo: jest.Mocked<RealtyExchangeRepository>;
  let leads: { getLead: jest.Mock };
  let llm: { complete: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    repo = {
      createSyndication: jest.fn(),
      findSyndicationById: jest.fn(),
      updateSyndication: jest.fn(),
      softDeleteSyndication: jest.fn(),
      listSyndications: jest.fn(),
      findSyndicationsInvolving: jest.fn(),
      createResaleListing: jest.fn(),
      findResaleListingById: jest.fn(),
      updateResaleListing: jest.fn(),
      softDeleteResaleListing: jest.fn(),
      listResaleListings: jest.fn(),
      findExchangeResaleSupply: jest.fn(),
      findExchangeUnitSupply: jest.fn(),
      upsertReliabilityScore: jest.fn(),
      findLatestReliabilityScore: jest.fn(),
      listReliabilityScores: jest.fn(),
    } as unknown as jest.Mocked<RealtyExchangeRepository>;
    leads = { getLead: jest.fn() };
    llm = { complete: jest.fn() };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RealtyExchangeService,
        { provide: RealtyExchangeRepository, useValue: repo },
        { provide: RealtyLeadsService, useValue: leads },
        { provide: LlmClientService, useValue: llm },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();

    service = module.get(RealtyExchangeService);
    // Default: update echoes the row merged with the patch (Decimals preserved).
    repo.updateSyndication.mockImplementation(async (_businessId, _id, data) =>
      makeSyndication((data ?? {}) as Record<string, unknown>),
    );
  });

  // ── createSyndication ──

  describe('createSyndication', () => {
    const dto = { leadId: LEAD, toBusinessId: TO, splitTerms: { originatorPct: 50, counterpartyPct: 50 } };

    it('offers a consented lead, stamps consent, and emits offered', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.createSyndication.mockResolvedValue(makeSyndication());

      const result = await service.createSyndication(FROM, dto as never);

      expect(repo.createSyndication).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: FROM, fromBusinessId: FROM, toBusinessId: TO, leadId: LEAD }),
      );
      expect((repo.createSyndication.mock.calls[0]![0] as { buyerConsentAt: Date }).buyerConsentAt).toBeInstanceOf(Date);
      expect(result.state).toBe(SyndicationState.OFFERED);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.syndication.offered',
        expect.objectContaining({ type: 'realty.syndication.offered', syndicationId: SYND, fromBusinessId: FROM, toBusinessId: TO }),
      );
    });

    it('refuses to syndicate a lead without buyer share consent', async () => {
      leads.getLead.mockResolvedValue(leadWith({ shareConsent: false }));
      await expect(service.createSyndication(FROM, dto as never)).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.createSyndication).not.toHaveBeenCalled();
    });

    it('rejects a split that does not sum to 100', async () => {
      const bad = { leadId: LEAD, toBusinessId: TO, splitTerms: { originatorPct: 60, counterpartyPct: 30 } };
      await expect(service.createSyndication(FROM, bad as never)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects syndicating to your own business', async () => {
      const self = { leadId: LEAD, toBusinessId: FROM, splitTerms: { originatorPct: 50, counterpartyPct: 50 } };
      await expect(service.createSyndication(FROM, self as never)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a three-way split that sums to 100', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.createSyndication.mockResolvedValue(makeSyndication());
      const threeWay = {
        leadId: LEAD,
        toBusinessId: TO,
        splitTerms: { originatorPct: 40, counterpartyPct: 40, developerPct: 20 },
      };
      await expect(service.createSyndication(FROM, threeWay as never)).resolves.toBeDefined();
    });
  });

  // ── State machine ──

  describe('state transitions', () => {
    it('accepts an OFFERED syndication and emits accepted', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication({ state: SyndicationState.OFFERED }));
      const res = await service.acceptSyndication(TO, SYND);
      expect(res.state).toBe(SyndicationState.ACCEPTED);
      expect(emitter.emit).toHaveBeenCalledWith('realty.syndication.accepted', expect.objectContaining({ syndicationId: SYND }));
    });

    it('refuses to accept a non-OFFERED syndication', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication({ state: SyndicationState.CLOSED }));
      await expect(service.acceptSyndication(TO, SYND)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('records a visit only from ACCEPTED', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication({ state: SyndicationState.ACCEPTED }));
      const res = await service.recordVisit(TO, SYND);
      expect(res.state).toBe(SyndicationState.VISIT);
    });

    it('throws NotFound when the syndication is not visible to the tenant', async () => {
      repo.findSyndicationById.mockResolvedValue(null);
      await expect(service.acceptSyndication(OTHER, SYND)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('expires an offered syndication', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication({ state: SyndicationState.OFFERED }));
      const res = await service.expireSyndication(FROM, SYND);
      expect(res.state).toBe(SyndicationState.EXPIRED);
    });
  });

  // ── closeSyndication ──

  describe('closeSyndication', () => {
    it('books the pool, takes the default 6% fee, and moves settlement to PENDING', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication({ state: SyndicationState.VISIT }));
      // ₹5,00,000 pool = 50_000_000 paise → 6% fee = 3_000_000 paise
      const res = await service.closeSyndication(FROM, SYND, { commissionPoolPaise: 50_000_000 });

      const patch = repo.updateSyndication.mock.calls[0]![2] as {
        state: string;
        commission_pool: Prisma.Decimal;
        platform_fee: Prisma.Decimal;
        settlement_state: string;
      };
      expect(patch.state).toBe(SyndicationState.CLOSED);
      expect(patch.settlement_state).toBe(SettlementState.PENDING);
      expect(patch.platform_fee.toNumber()).toBeCloseTo(30_000, 5); // ₹30,000
      expect(res.platformFeePaise).toBe(3_000_000);
      expect(emitter.emit).toHaveBeenCalledWith(
        'realty.syndication.closed',
        expect.objectContaining({ commissionPoolPaise: 50_000_000, platformFeePaise: 3_000_000 }),
      );
    });

    it('clamps an out-of-band fee rate into the 5–8% window', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication({ state: SyndicationState.ACCEPTED }));
      const res = await service.closeSyndication(FROM, SYND, { commissionPoolPaise: 100_000_000, platformFeeRate: 0.2 });
      // clamps to 0.08 → 8_000_000 paise
      expect(res.platformFeePaise).toBe(8_000_000);
    });

    it('refuses to close from OFFERED', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication({ state: SyndicationState.OFFERED }));
      await expect(service.closeSyndication(FROM, SYND, { commissionPoolPaise: 1 })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── disputeSyndication ──

  it('disputes a syndication, reverses settlement, and emits disputed', async () => {
    repo.findSyndicationById.mockResolvedValue(makeSyndication({ state: SyndicationState.CLOSED }));
    const res = await service.disputeSyndication(TO, SYND, 'partner withheld my half');
    const patch = repo.updateSyndication.mock.calls[0]![2] as { state: string; settlement_state: string; metadata: { disputeReason: string } };
    expect(patch.state).toBe(SyndicationState.DISPUTED);
    expect(patch.settlement_state).toBe(SettlementState.REVERSED);
    expect(patch.metadata.disputeReason).toBe('partner withheld my half');
    expect(res.state).toBe(SyndicationState.DISPUTED);
    expect(emitter.emit).toHaveBeenCalledWith('realty.syndication.disputed', expect.objectContaining({ reason: 'partner withheld my half' }));
  });

  // ── rateSyndication → reliability ──

  describe('rateSyndication', () => {
    it('stores the rating keyed by the rated (other) party and recomputes their score', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication({ state: SyndicationState.CLOSED }));
      // findSyndicationsInvolving drives the recompute for the rated party (TO).
      repo.findSyndicationsInvolving.mockResolvedValue([
        makeSyndication({ state: SyndicationState.CLOSED, metadata: { ratings: { [TO]: { showedUp: true, splitHonored: true, documented: true, responseMinutes: 4 } } } }),
      ]);
      repo.upsertReliabilityScore.mockImplementation(async (d) => ({
        id: 'score-1',
        business_id: d.businessId,
        target_business_id: d.targetBusinessId,
        response_speed_score: new Prisma.Decimal(d.responseSpeedScore),
        showup_integrity_score: new Prisma.Decimal(d.showupIntegrityScore),
        split_honoring_score: new Prisma.Decimal(d.splitHonoringScore),
        documentation_hygiene_score: new Prisma.Decimal(d.documentationHygieneScore),
        composite_score: new Prisma.Decimal(d.compositeScore),
        period_start: d.periodStart,
        period_end: d.periodEnd,
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      }));

      // FROM rates the deal → the rated party is TO.
      const res = await service.rateSyndication(SYND, FROM, { showedUp: true, splitHonored: true });

      const metaPatch = repo.updateSyndication.mock.calls[0]![2] as { metadata: { ratings: Record<string, unknown> } };
      expect(metaPatch.metadata.ratings).toHaveProperty(TO);
      expect(res.targetBusinessId).toBe(TO);
      expect(repo.upsertReliabilityScore).toHaveBeenCalledWith(expect.objectContaining({ businessId: TO, targetBusinessId: TO }));
    });

    it('rejects a rating from a non-party', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication());
      // A non-party can still resolve the row via the visibility check in a real DB,
      // but the party check inside rateSyndication rejects them.
      await expect(service.rateSyndication(SYND, OTHER, { showedUp: true })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ── calculateReliabilityScore ──

  it('builds neutral signals for a member with no ledger history', async () => {
    repo.findSyndicationsInvolving.mockResolvedValue([]);
    repo.upsertReliabilityScore.mockImplementation(async (d) => ({
      id: 's', business_id: d.businessId, target_business_id: d.targetBusinessId,
      response_speed_score: new Prisma.Decimal(d.responseSpeedScore),
      showup_integrity_score: new Prisma.Decimal(d.showupIntegrityScore),
      split_honoring_score: new Prisma.Decimal(d.splitHonoringScore),
      documentation_hygiene_score: new Prisma.Decimal(d.documentationHygieneScore),
      composite_score: new Prisma.Decimal(d.compositeScore),
      period_start: d.periodStart, period_end: d.periodEnd, metadata: {},
      created_at: new Date(), updated_at: new Date(),
    }));

    const res = await service.calculateReliabilityScore(TO, TO);
    expect(res.compositeScore).toBe(50);
    expect(repo.findSyndicationsInvolving).toHaveBeenCalledWith(TO);
  });

  describe('calculateReliabilityScore authorization', () => {
    beforeEach(() => {
      repo.upsertReliabilityScore.mockImplementation(async (d) => ({
        id: 's', business_id: d.businessId, target_business_id: d.targetBusinessId,
        response_speed_score: new Prisma.Decimal(d.responseSpeedScore),
        showup_integrity_score: new Prisma.Decimal(d.showupIntegrityScore),
        split_honoring_score: new Prisma.Decimal(d.splitHonoringScore),
        documentation_hygiene_score: new Prisma.Decimal(d.documentationHygieneScore),
        composite_score: new Prisma.Decimal(d.compositeScore),
        period_start: d.periodStart, period_end: d.periodEnd, metadata: {},
        created_at: new Date(), updated_at: new Date(),
      }));
    });

    /**
     * The recompute reads every syndication the target was party to and writes
     * the target's own canonical row. Without a caller check, any member could
     * recompute — and read back — an arbitrary business's deal record.
     */
    it('refuses a caller that has never transacted with the target', async () => {
      const STRANGER = '00000000-0000-4000-a000-0000000000ff';
      repo.findSyndicationsInvolving.mockResolvedValue([]);

      await expect(
        service.calculateReliabilityScore(TO, STRANGER),
      ).rejects.toThrow(ForbiddenException);
      expect(repo.upsertReliabilityScore).not.toHaveBeenCalled();
    });

    it('refuses a caller absent from the target ledger even when deals exist', async () => {
      const STRANGER = '00000000-0000-4000-a000-0000000000ff';
      repo.findSyndicationsInvolving.mockResolvedValue([
        makeSyndication({ business_id: FROM, to_business_id: TO }),
      ]);

      await expect(
        service.calculateReliabilityScore(TO, STRANGER),
      ).rejects.toThrow(/only recompute reliability for yourself/);
      expect(repo.upsertReliabilityScore).not.toHaveBeenCalled();
    });

    it('allows a counterparty on the originating side of a deal', async () => {
      repo.findSyndicationsInvolving.mockResolvedValue([
        makeSyndication({ business_id: FROM, to_business_id: TO }),
      ]);

      await expect(
        service.calculateReliabilityScore(TO, FROM),
      ).resolves.toBeDefined();
      expect(repo.upsertReliabilityScore).toHaveBeenCalled();
    });

    it('allows a counterparty on the receiving side of a deal', async () => {
      repo.findSyndicationsInvolving.mockResolvedValue([
        makeSyndication({ business_id: TO, to_business_id: FROM }),
      ]);

      await expect(
        service.calculateReliabilityScore(TO, FROM),
      ).resolves.toBeDefined();
    });

    it('always allows a member to recompute its own score', async () => {
      repo.findSyndicationsInvolving.mockResolvedValue([]);

      await expect(service.calculateReliabilityScore(TO, TO)).resolves.toBeDefined();
    });
  });

  // ── matchLeadToExchange ──

  describe('matchLeadToExchange', () => {
    it('ranks network supply by fit × reliability and skips AI by default', async () => {
      leads.getLead.mockResolvedValue(
        leadWith({ bltc: { budgetMinPaise: null, budgetMaxPaise: 1_500_000_000, localities: ['Baner'], timelineMonths: 6, config: '2BHK', purpose: null, financing: null } }),
      );
      repo.findExchangeResaleSupply.mockResolvedValue([makeResale({ id: 'r1', business_id: OTHER })]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);
      // OTHER has a strong reliability self-row.
      repo.findLatestReliabilityScore.mockResolvedValue({
        id: 'sc', business_id: OTHER, target_business_id: OTHER,
        response_speed_score: new Prisma.Decimal(90), showup_integrity_score: new Prisma.Decimal(90),
        split_honoring_score: new Prisma.Decimal(90), documentation_hygiene_score: new Prisma.Decimal(90),
        composite_score: new Prisma.Decimal(90), period_start: new Date(), period_end: new Date(),
        metadata: {}, created_at: new Date(), updated_at: new Date(),
      } as never);

      const res = await service.matchLeadToExchange(FROM, LEAD, {});

      expect(res.leadId).toBe(LEAD);
      expect(res.matches).toHaveLength(1);
      expect(res.matches[0]!.ownerBusinessId).toBe(OTHER);
      expect(res.matches[0]!.reliabilityScore).toBe(90);
      expect(res.aiRationale).toBeNull();
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('uses a neutral reliability of 50 for an unscored counterparty', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([makeResale({ id: 'r1', business_id: OTHER, asking_price: new Prisma.Decimal(10_000_000) })]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);
      repo.findLatestReliabilityScore.mockResolvedValue(null);

      const res = await service.matchLeadToExchange(FROM, LEAD, {});
      expect(res.matches[0]!.reliabilityScore).toBe(50);
    });

    it('attaches an AI rationale when requested and degrades to null on failure', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([makeResale({ id: 'r1', business_id: OTHER })]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);
      repo.findLatestReliabilityScore.mockResolvedValue(null);
      llm.complete.mockRejectedValue(new Error('OpenRouter down'));

      const res = await service.matchLeadToExchange(FROM, LEAD, { aiRationale: true });
      expect(llm.complete).toHaveBeenCalled();
      expect(res.aiRationale).toBeNull();
    });
  });

  // ── Resale CRUD ──

  describe('resale listings', () => {
    it('creates a resale listing verified now', async () => {
      repo.createResaleListing.mockResolvedValue(makeResale());
      const res = await service.createResaleListing(FROM, {
        locality: 'Baner', config: '2BHK', askingPricePaise: 1_000_000_000, sellerPhone: '+919999999999',
      } as never);
      expect(res.status).toBe(ResaleListingStatus.ACTIVE);
      expect((repo.createResaleListing.mock.calls[0]![0] as { verifiedAt: Date }).verifiedAt).toBeInstanceOf(Date);
    });

    it('re-stamps verified_at when a listing is set back to ACTIVE', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale({ status: ResaleListingStatus.UNDER_OFFER }));
      repo.updateResaleListing.mockResolvedValue(makeResale());
      await service.updateResaleListing(FROM, LISTING, { status: ResaleListingStatus.ACTIVE } as never);
      const patch = repo.updateResaleListing.mock.calls[0]![2] as { verified_at?: Date };
      expect(patch.verified_at).toBeInstanceOf(Date);
    });

    it('throws NotFound updating a listing the tenant does not own', async () => {
      repo.findResaleListingById.mockResolvedValue(null);
      await expect(service.updateResaleListing(FROM, LISTING, {} as never)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('soft-deletes a resale listing', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale());
      repo.softDeleteResaleListing.mockResolvedValue(makeResale({ deleted_at: new Date() }));
      await service.deleteResaleListing(FROM, LISTING);
      expect(repo.softDeleteResaleListing).toHaveBeenCalledWith(FROM, LISTING);
    });
  });
});
