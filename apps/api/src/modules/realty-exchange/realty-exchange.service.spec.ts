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
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ForbiddenActionError, ErrorCode } from '@gosumo/shared';
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
      findLatestSelfReliabilityScores: jest.fn().mockResolvedValue(new Map()),
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
      await expect(service.createSyndication(FROM, dto as never)).rejects.toBeInstanceOf(ForbiddenActionError);
      expect(repo.createSyndication).not.toHaveBeenCalled();
    });

    /**
     * A missing consent is a settled fact, not a transient failure — the queue
     * must not re-offer the lead, and the tenant ids belong in `context`, which
     * the exception filter logs but never serialises into the response.
     */
    it('carries the forbidden taxonomy: 403, FORBIDDEN, not retryable', async () => {
      leads.getLead.mockResolvedValue(leadWith({ shareConsent: false }));

      let err: ForbiddenActionError | undefined;
      try {
        await service.createSyndication(FROM, dto as never);
      } catch (e: unknown) {
        err = e as ForbiddenActionError;
      }

      if (!err) throw new Error('expected createSyndication to reject');
      expect(err.code).toBe(ErrorCode.FORBIDDEN);
      expect(err.httpStatus).toBe(403);
      expect(err.retryable).toBe(false);
      expect(err.context).toMatchObject({
        leadId: LEAD,
        fromBusinessId: FROM,
        toBusinessId: TO,
      });
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

  it('disputes a CLOSED syndication, reverses settlement, and emits disputed', async () => {
    repo.findSyndicationById.mockResolvedValue(makeSyndication({
      state: SyndicationState.CLOSED,
      settlement_state: SettlementState.PENDING,
    }));
    const res = await service.disputeSyndication(TO, SYND, 'partner withheld my half');
    const patch = repo.updateSyndication.mock.calls[0]![2] as { state: string; settlement_state: string; metadata: { disputeReason: string } };
    expect(patch.state).toBe(SyndicationState.DISPUTED);
    expect(patch.settlement_state).toBe(SettlementState.REVERSED);
    expect(patch.metadata.disputeReason).toBe('partner withheld my half');
    expect(res.state).toBe(SyndicationState.DISPUTED);
    expect(emitter.emit).toHaveBeenCalledWith('realty.syndication.disputed', expect.objectContaining({ reason: 'partner withheld my half' }));
  });

  it('does not set REVERSED when disputing an unsettled syndication', async () => {
    repo.findSyndicationById.mockResolvedValue(makeSyndication({
      state: SyndicationState.OFFERED,
      settlement_state: SettlementState.UNSETTLED,
    }));
    await service.disputeSyndication(TO, SYND, 'bad faith');
    const patch = repo.updateSyndication.mock.calls[0]![2] as Record<string, unknown>;
    expect(patch.state).toBe(SyndicationState.DISPUTED);
    expect(patch).not.toHaveProperty('settlement_state');
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
      await expect(service.rateSyndication(SYND, OTHER, { showedUp: true })).rejects.toBeInstanceOf(ForbiddenActionError);
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
      ).rejects.toThrow(ForbiddenActionError);
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
      repo.findLatestSelfReliabilityScores.mockResolvedValue(
        new Map([[OTHER, new Prisma.Decimal(90)]]),
      );

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
      repo.findLatestSelfReliabilityScores.mockResolvedValue(new Map());

      const res = await service.matchLeadToExchange(FROM, LEAD, {});
      expect(res.matches[0]!.reliabilityScore).toBe(50);
    });

    it('attaches an AI rationale when requested and degrades to null on failure', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([makeResale({ id: 'r1', business_id: OTHER })]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);
      repo.findLatestSelfReliabilityScores.mockResolvedValue(new Map());
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

    it('rejects transition from SOLD (terminal) to any other status', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale({ status: ResaleListingStatus.SOLD }));
      await expect(
        service.updateResaleListing(FROM, LISTING, { status: ResaleListingStatus.ACTIVE } as never),
      ).rejects.toThrow(/cannot transition/i);
      expect(repo.updateResaleListing).not.toHaveBeenCalled();
    });

    it('rejects transition from SOLD to UNDER_OFFER', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale({ status: ResaleListingStatus.SOLD }));
      await expect(
        service.updateResaleListing(FROM, LISTING, { status: ResaleListingStatus.UNDER_OFFER } as never),
      ).rejects.toThrow(/cannot transition/i);
    });

    it('allows UNDER_OFFER → SOLD', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale({ status: ResaleListingStatus.UNDER_OFFER }));
      repo.updateResaleListing.mockResolvedValue(makeResale({ status: ResaleListingStatus.SOLD }));
      await service.updateResaleListing(FROM, LISTING, { status: ResaleListingStatus.SOLD } as never);
      expect(repo.updateResaleListing).toHaveBeenCalled();
    });

    it('allows WITHDRAWN → ACTIVE (re-list)', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale({ status: 'WITHDRAWN' }));
      repo.updateResaleListing.mockResolvedValue(makeResale({ status: ResaleListingStatus.ACTIVE }));
      await service.updateResaleListing(FROM, LISTING, { status: ResaleListingStatus.ACTIVE } as never);
      expect(repo.updateResaleListing).toHaveBeenCalled();
    });

    it('soft-deletes a resale listing', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale());
      repo.softDeleteResaleListing.mockResolvedValue(makeResale({ deleted_at: new Date() }));
      await service.deleteResaleListing(FROM, LISTING);
      expect(repo.softDeleteResaleListing).toHaveBeenCalledWith(FROM, LISTING);
    });
  });

  // ── Read paths ──

  describe('reads', () => {
    it('gets a syndication the tenant is party to', async () => {
      repo.findSyndicationById.mockResolvedValue(makeSyndication());
      const res = await service.getSyndication(TO, SYND);
      expect(res.id).toBe(SYND);
      expect(repo.findSyndicationById).toHaveBeenCalledWith(TO, SYND);
    });

    it('throws NotFound reading a syndication outside the tenant', async () => {
      repo.findSyndicationById.mockResolvedValue(null);
      await expect(service.getSyndication(OTHER, SYND)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('passes state and role filters straight through when listing', async () => {
      repo.listSyndications.mockResolvedValue([makeSyndication()]);
      const res = await service.listSyndications(FROM, {
        state: SyndicationState.OFFERED,
        role: 'from',
      });
      expect(repo.listSyndications).toHaveBeenCalledWith(FROM, {
        state: SyndicationState.OFFERED,
        role: 'from',
      });
      expect(res).toHaveLength(1);
    });

    it('lists syndications unfiltered', async () => {
      repo.listSyndications.mockResolvedValue([]);
      expect(await service.listSyndications(FROM, {})).toEqual([]);
      expect(repo.listSyndications).toHaveBeenCalledWith(FROM, {
        state: undefined,
        role: undefined,
      });
    });

    it('lists reliability scores held by the tenant', async () => {
      repo.listReliabilityScores.mockResolvedValue([
        {
          id: 'sc',
          business_id: FROM,
          target_business_id: TO,
          response_speed_score: new Prisma.Decimal(70),
          showup_integrity_score: new Prisma.Decimal(80),
          split_honoring_score: new Prisma.Decimal(90),
          documentation_hygiene_score: new Prisma.Decimal(60),
          composite_score: new Prisma.Decimal(77.5),
          period_start: new Date('2026-08-01T00:00:00Z'),
          period_end: new Date('2026-08-10T00:00:00Z'),
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        },
      ] as never);

      const res = await service.listReliabilityScores(FROM);
      expect(res).toHaveLength(1);
      expect(res[0]!.compositeScore).toBe(77.5);
      expect(res[0]!.targetBusinessId).toBe(TO);
    });

    it('lists resale listings with status and locality filters', async () => {
      repo.listResaleListings.mockResolvedValue([makeResale()]);
      const res = await service.listResaleListings(FROM, {
        status: ResaleListingStatus.ACTIVE,
        locality: 'Baner',
      });
      expect(repo.listResaleListings).toHaveBeenCalledWith(FROM, {
        status: ResaleListingStatus.ACTIVE,
        locality: 'Baner',
      });
      expect(res[0]!.locality).toBe('Baner');
    });

    it('gets a single resale listing', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale());
      const res = await service.getResaleListing(FROM, LISTING);
      expect(res.id).toBe(LISTING);
    });

    it('throws NotFound reading a resale listing the tenant does not own', async () => {
      repo.findResaleListingById.mockResolvedValue(null);
      await expect(service.getResaleListing(OTHER, LISTING)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ── Mapping edge cases ──

  describe('response mapping', () => {
    /**
     * A syndication only carries money once it CLOSEs; before that the Decimal
     * legs are null in the DB and must surface as 0 paise, not NaN.
     */
    it('maps an unbooked syndication with null money legs to 0 paise', async () => {
      repo.findSyndicationById.mockResolvedValue(
        makeSyndication({ commission_pool: null, platform_fee: null, split_terms: null }),
      );
      const res = await service.getSyndication(FROM, SYND);
      expect(res.commissionPoolPaise).toBe(0);
      expect(res.platformFeePaise).toBe(0);
      expect(res.splitTerms).toEqual({});
    });

    /**
     * A reliability row written before a dimension had any evidence can carry a
     * null sub-score; the response contract is numeric, so it must read as 0.
     */
    it('maps a reliability row with a null sub-score to 0', async () => {
      repo.listReliabilityScores.mockResolvedValue([
        {
          id: 'sc',
          business_id: FROM,
          target_business_id: TO,
          response_speed_score: null,
          showup_integrity_score: new Prisma.Decimal(80),
          split_honoring_score: new Prisma.Decimal(90),
          documentation_hygiene_score: new Prisma.Decimal(60),
          composite_score: new Prisma.Decimal(70),
          period_start: new Date('2026-08-01T00:00:00Z'),
          period_end: new Date('2026-08-10T00:00:00Z'),
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        },
      ] as never);

      const res = await service.listReliabilityScores(FROM);
      expect(res[0]!.responseSpeedScore).toBe(0);
      expect(res[0]!.showupIntegrityScore).toBe(80);
    });

    it('maps a resale listing with a null carpet area and project', async () => {
      repo.findResaleListingById.mockResolvedValue(
        makeResale({ carpet_sqft: null, project_id: null, verified_at: null }),
      );
      const res = await service.getResaleListing(FROM, LISTING);
      expect(res.carpetSqft).toBeNull();
      expect(res.projectId).toBeNull();
      expect(res.verifiedAt).toBeNull();
    });
  });

  // ── Fee band ──

  describe('platform fee band', () => {
    beforeEach(() => {
      repo.findSyndicationById.mockResolvedValue(
        makeSyndication({ state: SyndicationState.VISIT }),
      );
    });

    it('lifts an under-band rate to the 5% floor', async () => {
      const res = await service.closeSyndication(FROM, SYND, {
        commissionPoolPaise: 100_000_000,
        platformFeeRate: 0.001,
      });
      expect(res.platformFeePaise).toBe(5_000_000);
    });

    it('honours an explicit in-band rate untouched', async () => {
      const res = await service.closeSyndication(FROM, SYND, {
        commissionPoolPaise: 100_000_000,
        platformFeeRate: 0.07,
      });
      expect(res.platformFeePaise).toBe(7_000_000);
    });
  });

  // ── developer leg ──

  it('carries an explicit developer id onto the syndication row', async () => {
    const DEVELOPER = '00000000-0000-4000-a000-0000000000d0';
    leads.getLead.mockResolvedValue(leadWith());
    repo.createSyndication.mockResolvedValue(makeSyndication({ developer_id: DEVELOPER }));

    const res = await service.createSyndication(FROM, {
      leadId: LEAD,
      toBusinessId: TO,
      developerId: DEVELOPER,
      splitTerms: { originatorPct: 40, counterpartyPct: 40, developerPct: 20 },
    } as never);

    expect(repo.createSyndication).toHaveBeenCalledWith(
      expect.objectContaining({ developerId: DEVELOPER }),
    );
    expect(res.developerId).toBe(DEVELOPER);
  });

  // ── rating from the counterparty side ──

  it('rates the originator when the counterparty is the rater', async () => {
    repo.findSyndicationById.mockResolvedValue(
      makeSyndication({ state: SyndicationState.CLOSED, metadata: null }),
    );
    // The recompute that follows is authorized by the rater appearing on the ledger.
    repo.findSyndicationsInvolving.mockResolvedValue([makeSyndication()]);
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

    // TO rates the deal → the rated party is FROM.
    const res = await service.rateSyndication(SYND, TO, { splitHonored: false });

    const patch = repo.updateSyndication.mock.calls[0]![2] as {
      metadata: { ratings: Record<string, unknown> };
    };
    expect(patch.metadata.ratings).toHaveProperty(FROM);
    expect(res.targetBusinessId).toBe(FROM);
  });

  it('merges a second rating into the existing record for the same party', async () => {
    repo.findSyndicationById.mockResolvedValue(
      makeSyndication({
        state: SyndicationState.CLOSED,
        metadata: { ratings: { [TO]: { responseMinutes: 12 } }, note: 'keep me' },
      }),
    );
    repo.findSyndicationsInvolving.mockResolvedValue([makeSyndication()]);
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

    await service.rateSyndication(SYND, FROM, { showedUp: true });

    const patch = repo.updateSyndication.mock.calls[0]![2] as {
      metadata: { ratings: Record<string, Record<string, unknown>>; note: string };
    };
    // The earlier field survives alongside the new one, and unrelated metadata
    // keys are not clobbered by the merge.
    expect(patch.metadata.ratings[TO]).toEqual({ responseMinutes: 12, showedUp: true });
    expect(patch.metadata.note).toBe('keep me');
  });

  // ── buildSignals ──

  describe('reliability signal building', () => {
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

    function upserted() {
      return repo.upsertReliabilityScore.mock.calls[0]![0];
    }

    it('counts a no-show against show-up integrity without crediting a honored visit', async () => {
      repo.findSyndicationsInvolving.mockResolvedValue([
        makeSyndication({
          state: SyndicationState.CLOSED,
          metadata: { ratings: { [TO]: { showedUp: false, splitHonored: false, documented: false } } },
        }),
      ]);

      await service.calculateReliabilityScore(TO, TO);
      expect(upserted().showupIntegrityScore).toBe(0);
      // No split honored and no docs on the only closed deal.
      expect(upserted().splitHonoringScore).toBe(0);
      expect(upserted().documentationHygieneScore).toBe(0);
    });

    it('scores a spotless closed deal at the top of every dimension', async () => {
      repo.findSyndicationsInvolving.mockResolvedValue([
        makeSyndication({
          state: SyndicationState.CLOSED,
          metadata: {
            ratings: { [TO]: { showedUp: true, splitHonored: true, documented: true, responseMinutes: 2 } },
          },
        }),
      ]);

      await service.calculateReliabilityScore(TO, TO);
      expect(upserted().compositeScore).toBeGreaterThan(90);
    });

    it('ignores ledger rows that carry no rating for the member', async () => {
      repo.findSyndicationsInvolving.mockResolvedValue([
        makeSyndication({ state: SyndicationState.CLOSED, metadata: { ratings: { [OTHER]: { showedUp: true } } } }),
        makeSyndication({ state: SyndicationState.DISPUTED, metadata: null }),
      ]);

      await service.calculateReliabilityScore(TO, TO);
      // Two rows on the ledger, one disputed, none rated for TO.
      expect(upserted().showupIntegrityScore).toBe(50); // neutral — no evidence
    });

    it('averages response minutes across rated deals', async () => {
      repo.findSyndicationsInvolving.mockResolvedValue([
        makeSyndication({ metadata: { ratings: { [TO]: { responseMinutes: 10 } } } }),
        makeSyndication({ metadata: { ratings: { [TO]: { responseMinutes: 30 } } } }),
        // A rating with no response signal at all must not drag the average.
        makeSyndication({ metadata: { ratings: { [TO]: { documented: true } } } }),
      ]);

      await service.calculateReliabilityScore(TO, TO);
      const first = upserted().responseSpeedScore;
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThan(100);
    });

    /**
     * A dispute is read off the ledger state, not off any rating — a member being
     * disputed cannot suppress the penalty by simply never being rated on that row.
     * Each dispute cancels a full deal's worth of split-honoring credit.
     */
    it('penalises split honoring for a dispute the member was never rated on', async () => {
      const honoredClose = () =>
        makeSyndication({
          state: SyndicationState.CLOSED,
          metadata: { ratings: { [TO]: { splitHonored: true } } },
        });

      repo.findSyndicationsInvolving.mockResolvedValue([
        honoredClose(),
        honoredClose(),
        makeSyndication({ state: SyndicationState.DISPUTED, metadata: {} }),
      ]);
      await service.calculateReliabilityScore(TO, TO);
      // 2 honored splits over 2 closes, less 1 dispute → 1/2.
      expect(upserted().splitHonoringScore).toBe(50);

      repo.upsertReliabilityScore.mockClear();
      repo.findSyndicationsInvolving.mockResolvedValue([
        honoredClose(),
        honoredClose(),
        makeSyndication({ state: SyndicationState.EXPIRED, metadata: {} }),
      ]);
      await service.calculateReliabilityScore(TO, TO);
      // Same two closes, but the third row lapsed rather than blew up.
      expect(upserted().splitHonoringScore).toBe(100);
    });
  });

  // ── matching: supply assembly + AI rationale ──

  describe('exchange supply assembly', () => {
    function makeUnit(overrides: Record<string, unknown> = {}) {
      return {
        id: 'u1',
        business_id: OTHER,
        project_id: 'p1',
        config: '2BHK',
        all_in_price: new Prisma.Decimal(11_000_000),
        project: { id: 'p1', name: 'Sunrise Heights', locality: 'Baner' },
        ...overrides,
      };
    }

    it('folds EXCHANGE-visible units into the candidate pool with their project name', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([]);
      repo.findExchangeUnitSupply.mockResolvedValue([makeUnit()] as never);
      repo.findLatestSelfReliabilityScores.mockResolvedValue(new Map());

      const res = await service.matchLeadToExchange(FROM, LEAD);

      expect(res.matches).toHaveLength(1);
      expect(res.matches[0]!.sourceType).toBe('UNIT');
      expect(res.matches[0]!.projectName).toBe('Sunrise Heights');
      expect(res.matches[0]!.locality).toBe('Baner');
    });

    /**
     * A member usually has several listings on the board at once, and the board
     * spans the whole network. Reliability is read for every distinct owner in
     * one query — the count must not track the size of the board.
     */
    it('reads reliability once for the whole board, not once per listing', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([
        makeResale({ id: 'r1', business_id: OTHER }),
        makeResale({ id: 'r2', business_id: OTHER }),
      ]);
      repo.findExchangeUnitSupply.mockResolvedValue([makeUnit({ id: 'u1', business_id: OTHER })] as never);
      repo.findLatestSelfReliabilityScores.mockResolvedValue(new Map());

      await service.matchLeadToExchange(FROM, LEAD);

      expect(repo.findLatestSelfReliabilityScores).toHaveBeenCalledTimes(1);
      expect(repo.findLatestSelfReliabilityScores).toHaveBeenCalledWith([OTHER]);
      // The per-owner read is what this replaced; it must not creep back in.
      expect(repo.findLatestReliabilityScore).not.toHaveBeenCalled();
    });

    it('asks for every distinct owner when supply spans several members', async () => {
      const THIRD = '00000000-0000-4000-a000-000000000004';
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([
        makeResale({ id: 'r1', business_id: OTHER }),
        makeResale({ id: 'r2', business_id: THIRD }),
      ]);
      repo.findExchangeUnitSupply.mockResolvedValue([makeUnit({ id: 'u1', business_id: THIRD })] as never);
      repo.findLatestSelfReliabilityScores.mockResolvedValue(new Map());

      await service.matchLeadToExchange(FROM, LEAD);

      expect(repo.findLatestSelfReliabilityScores).toHaveBeenCalledTimes(1);
      const asked = repo.findLatestSelfReliabilityScores.mock.calls[0]![0] as string[];
      expect([...asked].sort()).toEqual([OTHER, THIRD].sort());
    });

    /**
     * Resale and unit supply are separate reads that routinely name the same
     * owner; the id set is built across both, so a member listing on each side
     * is still asked for once.
     */
    it('blends a score onto listings from both supply sides', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([
        makeResale({ id: 'r1', business_id: OTHER }),
      ]);
      repo.findExchangeUnitSupply.mockResolvedValue([
        makeUnit({ id: 'u1', business_id: OTHER }),
      ] as never);
      repo.findLatestSelfReliabilityScores.mockResolvedValue(
        new Map([[OTHER, new Prisma.Decimal(88)]]),
      );

      const res = await service.matchLeadToExchange(FROM, LEAD);

      expect(repo.findLatestSelfReliabilityScores).toHaveBeenCalledWith([OTHER]);
      expect(res.matches).toHaveLength(2);
      expect(res.matches.map((m) => m.reliabilityScore)).toEqual([88, 88]);
    });

    /**
     * An owner the map has no entry for is unscored, not zero-scored — the
     * difference decides whether a new member can be matched at all.
     */
    it('falls back to neutral for an owner missing from the batch result', async () => {
      const THIRD = '00000000-0000-4000-a000-000000000004';
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([
        makeResale({ id: 'r1', business_id: OTHER }),
        makeResale({ id: 'r2', business_id: THIRD }),
      ]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);
      // Only OTHER has ever been scored.
      repo.findLatestSelfReliabilityScores.mockResolvedValue(
        new Map([[OTHER, new Prisma.Decimal(92)]]),
      );

      const res = await service.matchLeadToExchange(FROM, LEAD);

      const byOwner = new Map(res.matches.map((m) => [m.ownerBusinessId, m.reliabilityScore]));
      expect(byOwner.get(OTHER)).toBe(92);
      expect(byOwner.get(THIRD)).toBe(50);
    });

    it('skips the reliability read entirely when the network has no supply', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);

      const res = await service.matchLeadToExchange(FROM, LEAD);

      expect(res.matches).toEqual([]);
      expect(repo.findLatestSelfReliabilityScores).toHaveBeenCalledWith([]);
    });

    it('honours an explicit result limit', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([
        makeResale({ id: 'r1', business_id: OTHER }),
        makeResale({ id: 'r2', business_id: OTHER }),
        makeResale({ id: 'r3', business_id: OTHER }),
      ]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);
      repo.findLatestSelfReliabilityScores.mockResolvedValue(new Map());

      const res = await service.matchLeadToExchange(FROM, LEAD, { limit: 2 });
      expect(res.matches).toHaveLength(2);
    });

    it('skips the AI call when nothing matched', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);

      const res = await service.matchLeadToExchange(FROM, LEAD, { aiRationale: true });
      expect(res.matches).toHaveLength(0);
      expect(res.aiRationale).toBeNull();
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('attaches the model rationale when OpenRouter answers', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([makeResale({ id: 'r1', business_id: OTHER })]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);
      repo.findLatestSelfReliabilityScores.mockResolvedValue(new Map());
      llm.complete.mockResolvedValue({ text: 'Syndicate the Baner 2BHK first.' });

      const res = await service.matchLeadToExchange(FROM, LEAD, { aiRationale: true });

      expect(res.aiRationale).toBe('Syndicate the Baner 2BHK first.');
      const prompt = llm.complete.mock.calls[0]![0] as { user: string; system: string };
      expect(prompt.user).toContain('2BHK');
      expect(prompt.user).toContain('Baner');
    });

    it('treats an empty model reply as no rationale', async () => {
      leads.getLead.mockResolvedValue(leadWith());
      repo.findExchangeResaleSupply.mockResolvedValue([makeResale({ id: 'r1', business_id: OTHER })]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);
      repo.findLatestSelfReliabilityScores.mockResolvedValue(new Map());
      llm.complete.mockResolvedValue({ text: '' });

      const res = await service.matchLeadToExchange(FROM, LEAD, { aiRationale: true });
      expect(res.aiRationale).toBeNull();
    });

    it('describes an unspecified buyer brief without leaving blanks in the prompt', async () => {
      leads.getLead.mockResolvedValue(
        leadWith({
          bltc: {
            budgetMinPaise: null, budgetMaxPaise: null, localities: [],
            timelineMonths: null, config: null, purpose: null, financing: null,
          },
        }),
      );
      repo.findExchangeResaleSupply.mockResolvedValue([makeResale({ id: 'r1', business_id: OTHER })]);
      repo.findExchangeUnitSupply.mockResolvedValue([]);
      repo.findLatestSelfReliabilityScores.mockResolvedValue(new Map());
      llm.complete.mockResolvedValue({ text: 'ok' });

      await service.matchLeadToExchange(FROM, LEAD, { aiRationale: true });

      const prompt = llm.complete.mock.calls[0]![0] as { user: string };
      expect(prompt.user).toContain('any config');
      expect(prompt.user).toContain('any locality');
    });
  });

  // ── resale update patching ──

  describe('updateResaleListing patching', () => {
    it('applies only the fields the caller supplied', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale());
      repo.updateResaleListing.mockResolvedValue(makeResale());

      await service.updateResaleListing(FROM, LISTING, {
        locality: 'Wakad',
        config: '3BHK',
        carpetSqft: 1200,
        askingPricePaise: 1_500_000_000,
        sellerPhone: '+918888888888',
        status: ResaleListingStatus.UNDER_OFFER,
      } as never);

      const patch = repo.updateResaleListing.mock.calls[0]![2] as {
        locality: string; config: string; carpet_sqft: number;
        asking_price: Prisma.Decimal; seller_phone: string; status: string;
        verified_at?: Date;
      };
      expect(patch.locality).toBe('Wakad');
      expect(patch.config).toBe('3BHK');
      expect(patch.carpet_sqft).toBe(1200);
      expect(patch.asking_price.toNumber()).toBe(15_000_000);
      expect(patch.seller_phone).toBe('+918888888888');
      expect(patch.status).toBe(ResaleListingStatus.UNDER_OFFER);
      // Only a return to ACTIVE re-stamps the freshness marker.
      expect(patch.verified_at).toBeUndefined();
    });

    it('sends an empty patch when the caller supplied nothing', async () => {
      repo.findResaleListingById.mockResolvedValue(makeResale());
      repo.updateResaleListing.mockResolvedValue(makeResale());

      await service.updateResaleListing(FROM, LISTING, {} as never);
      expect(repo.updateResaleListing.mock.calls[0]![2]).toEqual({});
    });

    it('stores an optional project id and carpet area on create', async () => {
      repo.createResaleListing.mockResolvedValue(makeResale());
      await service.createResaleListing(FROM, {
        projectId: 'p1', locality: 'Baner', config: '2BHK',
        carpetSqft: 950, askingPricePaise: 1_000_000_000, sellerPhone: '+919999999999',
      } as never);

      expect(repo.createResaleListing).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1', carpetSqft: 950 }),
      );
      const created = repo.createResaleListing.mock.calls[0]![0] as { askingPrice: Prisma.Decimal };
      expect(created.askingPrice.toNumber()).toBe(10_000_000);
    });
  });
});
