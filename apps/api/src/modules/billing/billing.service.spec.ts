/**
 * BillingService unit tests (GoSumo Realty pricing-tier enforcement, plan §9).
 *
 * Coverage:
 *  1. addMonths — the UTC-safe month arithmetic (normal, day-clamp, year wrap, n>1)
 *  2. getSubscription — lazy default-SOLO creation on first access, existing passthrough
 *  3. Cycle rollover — no-op when current, single- and multi-month advance + counter reset
 *  4. checkPlanLimits — exchange gating (SOLO blocked), seat cap, lead cap w/ overage vs hard-cap
 *  5. canUseExchange — convenience wrapper
 *  6. recordLeadUsage — increment + event, overage detection, limit-reached fires exactly once
 *  7. onLeadCreated — best-effort listener that swallows billing errors
 *  8. getUsageSummary — meters, overage charge, cycle-end computation
 *  9. upgradePlan — plan switch (event + audit + limit changes) and same-plan no-op
 *
 * The repository, EventEmitter2, and audit service are mocked; no database is touched.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RealtyPlan } from '@prisma/client';
import type { business_subscriptions } from '@prisma/client';
import type { RealtyLeadCreatedEvent } from '@gosumo/shared';

import { BillingService, addMonths, BILLING_HISTORY_LIMIT } from './billing.service';
import { BillingRepository } from './billing.repository';
import { RealtyOperationsAuditService } from '../realty-hardening/realty-operations-audit.service';
import { OVERAGE_RATE_PAISE, PLAN_DEFINITIONS } from './billing.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const SUB_ID = '00000000-0000-4000-a000-0000000000ff';
const CYCLE_START = new Date('2026-07-01T00:00:00Z');

function makeSub(overrides: Partial<business_subscriptions> = {}): business_subscriptions {
  const def = PLAN_DEFINITIONS[RealtyPlan.SOLO];
  return {
    id: SUB_ID,
    business_id: BUSINESS_ID,
    plan: RealtyPlan.SOLO,
    monthly_lead_limit: def.monthlyLeadLimit,
    seat_limit: def.seatLimit,
    plan_price_paise: def.pricePaise,
    overage_rate_paise: OVERAGE_RATE_PAISE,
    billing_cycle_start: CYCLE_START,
    leads_used_this_cycle: 0,
    overage_leads_this_cycle: 0,
    metadata: {},
    created_at: CYCLE_START,
    updated_at: CYCLE_START,
    ...overrides,
  } as business_subscriptions;
}

describe('addMonths', () => {
  it('adds a whole month within a normal window', () => {
    expect(addMonths(new Date('2026-07-01T00:00:00Z'), 1).toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('clamps to month-end when the target month is shorter (Jan 31 → Feb 28)', () => {
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('wraps the year (Dec → Jan)', () => {
    expect(addMonths(new Date('2026-12-15T09:30:00Z'), 1).toISOString()).toBe(
      '2027-01-15T09:30:00.000Z',
    );
  });

  it('adds several months at once and preserves time-of-day', () => {
    expect(addMonths(new Date('2026-07-01T13:45:07Z'), 5).toISOString()).toBe(
      '2026-12-01T13:45:07.000Z',
    );
  });
});

describe('BillingService', () => {
  /**
   * A won rollover claim. `claimCycleRollover` reports whether *this* caller is
   * the one that rolled the cycle — every billing read tries, and only one may
   * append the closing snapshot.
   */
  const rolled = (subscription: ReturnType<typeof makeSub>) => ({
    subscription,
    claimed: true,
  });

  let service: BillingService;
  let repository: jest.Mocked<BillingRepository>;
  let eventEmitter: jest.Mocked<EventEmitter2>;
  let audit: jest.Mocked<RealtyOperationsAuditService>;

  beforeEach(async () => {
    const mockRepository: Partial<Record<keyof BillingRepository, jest.Mock>> = {
      findByBusiness: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      claimCycleRollover: jest.fn(),
      incrementUsage: jest.fn(),
      countSeats: jest.fn(),
    };
    const mockEventEmitter = { emit: jest.fn() };
    const mockAudit = { record: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: BillingRepository, useValue: mockRepository },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: RealtyOperationsAuditService, useValue: mockAudit },
      ],
    }).compile();

    service = module.get(BillingService);
    repository = module.get(BillingRepository) as jest.Mocked<BillingRepository>;
    eventEmitter = module.get(EventEmitter2) as jest.Mocked<EventEmitter2>;
    audit = module.get(RealtyOperationsAuditService) as jest.Mocked<RealtyOperationsAuditService>;
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── Subscription lifecycle ──
  describe('getSubscription', () => {
    it('lazily creates a default SOLO subscription on first access', async () => {
      repository.findByBusiness.mockResolvedValue(null);
      const created = makeSub();
      repository.create.mockResolvedValue(created);

      const result = await service.getSubscription(BUSINESS_ID, CYCLE_START);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          plan: RealtyPlan.SOLO,
          monthlyLeadLimit: 300,
          seatLimit: 1,
          planPricePaise: 399900,
          overageRatePaise: OVERAGE_RATE_PAISE,
          billingCycleStart: CYCLE_START,
        }),
      );
      expect(result.plan).toBe(RealtyPlan.SOLO);
    });

    it('returns the existing subscription without creating a new one', async () => {
      repository.findByBusiness.mockResolvedValue(makeSub({ plan: RealtyPlan.TEAM }));

      const result = await service.getSubscription(BUSINESS_ID, CYCLE_START);

      expect(repository.create).not.toHaveBeenCalled();
      expect(result.plan).toBe(RealtyPlan.TEAM);
    });
  });

  // ── Cycle rollover ──
  describe('billing cycle rollover', () => {
    it('does not roll over while the cycle is still current', async () => {
      repository.findByBusiness.mockResolvedValue(makeSub({ leads_used_this_cycle: 42 }));

      const result = await service.getSubscription(
        BUSINESS_ID,
        new Date('2026-07-20T00:00:00Z'),
      );

      expect(repository.claimCycleRollover).not.toHaveBeenCalled();
      expect(result.leads_used_this_cycle).toBe(42);
    });

    it('rolls the cycle forward and resets usage counters once a month elapses', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ leads_used_this_cycle: 120, overage_leads_this_cycle: 3 }),
      );
      repository.claimCycleRollover.mockResolvedValue(rolled(
        makeSub({
          billing_cycle_start: new Date('2026-08-01T00:00:00Z'),
          leads_used_this_cycle: 0,
          overage_leads_this_cycle: 0,
        }),
      ));

      const result = await service.getSubscription(
        BUSINESS_ID,
        new Date('2026-08-05T00:00:00Z'),
      );

      expect(repository.claimCycleRollover).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.any(Date),
        expect.objectContaining({
          billingCycleStart: new Date('2026-08-01T00:00:00Z'),
          leadsUsedThisCycle: 0,
          overageLeadsThisCycle: 0,
        }),
      );
      expect(result.leads_used_this_cycle).toBe(0);
    });

    it('advances multiple whole months when several cycles were skipped', async () => {
      // Cycle started 2026-05-01; "now" is 2026-07-03 → two months elapsed → 2026-07-01.
      repository.findByBusiness.mockResolvedValue(
        makeSub({ billing_cycle_start: new Date('2026-05-01T00:00:00Z') }),
      );
      repository.claimCycleRollover.mockResolvedValue(rolled(makeSub()));

      await service.getSubscription(BUSINESS_ID, new Date('2026-07-03T00:00:00Z'));

      expect(repository.claimCycleRollover).toHaveBeenCalledWith(
        BUSINESS_ID,
        expect.any(Date),
        expect.objectContaining({
          billingCycleStart: new Date('2026-07-01T00:00:00Z'),
          leadsUsedThisCycle: 0,
          overageLeadsThisCycle: 0,
        }),
      );
    });

    /**
     * The claim is made against the cycle the caller read, not just the business.
     * Without that predicate a second caller arriving after the winner committed
     * would roll the *new* cycle straight back off again.
     */
    it('claims the rollover against the cycle it actually read', async () => {
      const from = new Date('2026-05-01T00:00:00Z');
      repository.findByBusiness.mockResolvedValue(makeSub({ billing_cycle_start: from }));
      repository.claimCycleRollover.mockResolvedValue(rolled(makeSub()));

      await service.getSubscription(BUSINESS_ID, new Date('2026-07-03T00:00:00Z'));

      expect(repository.claimCycleRollover).toHaveBeenCalledWith(
        BUSINESS_ID,
        from,
        expect.anything(),
      );
    });

    /**
     * Every billing read rolls the cycle over if it has elapsed, and the
     * per-lead usage path is one of them — so at the moment a cycle ends, the
     * concurrent callers all see it elapsed. Only the one that wins the claim
     * may treat the rollover as its own; the rest have to take the winner's row,
     * because the counters they are holding have already been zeroed.
     */
    it('returns the winner’s subscription when another caller rolled it first', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ leads_used_this_cycle: 120, overage_leads_this_cycle: 3 }),
      );
      const winner = makeSub({
        billing_cycle_start: new Date('2026-08-01T00:00:00Z'),
        leads_used_this_cycle: 7,
      });
      repository.claimCycleRollover.mockResolvedValue({
        subscription: winner,
        claimed: false,
      });

      const result = await service.getSubscription(
        BUSINESS_ID,
        new Date('2026-08-05T00:00:00Z'),
      );

      // Not the stale 120 this caller read, and not a second reset to 0 —
      // the row as the winner left it.
      expect(result.leads_used_this_cycle).toBe(7);
      expect(result.billing_cycle_start).toEqual(new Date('2026-08-01T00:00:00Z'));
    });

    /**
     * The rollover log is how an operator reconciles a cycle boundary. One
     * rollover that every concurrent caller announces reads as several, which
     * is the same misreading the duplicate history entries used to cause.
     */
    it('announces the rollover only from the caller that made it', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      repository.findByBusiness.mockResolvedValue(makeSub({ leads_used_this_cycle: 120 }));
      repository.claimCycleRollover.mockResolvedValue({
        subscription: makeSub({ billing_cycle_start: new Date('2026-08-01T00:00:00Z') }),
        claimed: false,
      });

      await service.getSubscription(BUSINESS_ID, new Date('2026-08-05T00:00:00Z'));

      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('rolled over'));
      log.mockRestore();
    });

    it('falls back to the row it read when the claim returns nothing', async () => {
      const own = makeSub({ leads_used_this_cycle: 120 });
      repository.findByBusiness.mockResolvedValue(own);
      repository.claimCycleRollover.mockResolvedValue({
        subscription: null,
        claimed: false,
      });

      // A deleted subscription must not crash a billing read.
      const result = await service.getSubscription(
        BUSINESS_ID,
        new Date('2026-08-05T00:00:00Z'),
      );

      expect(result).toBe(own);
    });
  });

  // ── Closed-cycle snapshot ──
  //
  // Rollover zeroes the counters, and nothing else in the system records what
  // the closing cycle owed. Without a snapshot the overage charge is gone the
  // first time anything reads the subscription after the cycle ends.
  describe('billing history on rollover', () => {
    /** The `metadata` written by the single `repository.update` call. */
    function writtenMetadata(): Record<string, unknown> | undefined {
      const [, , patch] = repository.claimCycleRollover.mock.calls[0] as [
        string,
        Date,
        Record<string, unknown>,
      ];
      return patch['metadata'] as Record<string, unknown> | undefined;
    }

    it('snapshots the closing cycle so its overage charge survives the reset', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ leads_used_this_cycle: 312, overage_leads_this_cycle: 12 }),
      );
      repository.claimCycleRollover.mockResolvedValue(rolled(makeSub()));

      await service.getSubscription(BUSINESS_ID, new Date('2026-08-05T00:00:00Z'));

      expect(writtenMetadata()?.['billingHistory']).toEqual([
        {
          cycleStart: '2026-07-01T00:00:00.000Z',
          cycleEnd: '2026-08-01T00:00:00.000Z',
          plan: RealtyPlan.SOLO,
          planPricePaise: 399900,
          leadsUsed: 312,
          overageLeads: 12,
          overageRatePaise: OVERAGE_RATE_PAISE,
          // 12 leads × ₹8 = ₹96. This is the number that used to vanish.
          overageChargePaise: 9600,
        },
      ]);
    });

    it('appends to the history already on the subscription', async () => {
      const earlier = {
        cycleStart: '2026-06-01T00:00:00.000Z',
        cycleEnd: '2026-07-01T00:00:00.000Z',
        plan: RealtyPlan.SOLO,
        planPricePaise: 399900,
        leadsUsed: 300,
        overageLeads: 0,
        overageRatePaise: OVERAGE_RATE_PAISE,
        overageChargePaise: 0,
      };
      repository.findByBusiness.mockResolvedValue(
        makeSub({
          leads_used_this_cycle: 305,
          overage_leads_this_cycle: 5,
          metadata: { hardCap: false, billingHistory: [earlier] } as never,
        }),
      );
      repository.claimCycleRollover.mockResolvedValue(rolled(makeSub()));

      await service.getSubscription(BUSINESS_ID, new Date('2026-08-05T00:00:00Z'));

      const history = writtenMetadata()?.['billingHistory'] as unknown[];
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual(earlier);
      // Unrelated metadata keys are carried through, not clobbered.
      expect(writtenMetadata()?.['hardCap']).toBe(false);
    });

    it('keeps only the most recent cycles so the JSONB column stays bounded', async () => {
      const priorCycles = Array.from({ length: BILLING_HISTORY_LIMIT + 4 }, (_, i) => ({
        cycleStart: `20${10 + i}-01-01T00:00:00.000Z`,
        cycleEnd: `20${10 + i}-02-01T00:00:00.000Z`,
        plan: RealtyPlan.SOLO,
        planPricePaise: 399900,
        leadsUsed: i,
        overageLeads: 0,
        overageRatePaise: OVERAGE_RATE_PAISE,
        overageChargePaise: 0,
      }));
      repository.findByBusiness.mockResolvedValue(
        makeSub({
          leads_used_this_cycle: 7,
          metadata: { billingHistory: priorCycles } as never,
        }),
      );
      repository.claimCycleRollover.mockResolvedValue(rolled(makeSub()));

      await service.getSubscription(BUSINESS_ID, new Date('2026-08-05T00:00:00Z'));

      const history = writtenMetadata()?.['billingHistory'] as Array<{ leadsUsed: number }>;
      expect(history).toHaveLength(BILLING_HISTORY_LIMIT);
      // The oldest entries are the ones dropped; the new cycle is last.
      expect(history.map((c) => c.leadsUsed)).toEqual([
        ...Array.from({ length: BILLING_HISTORY_LIMIT - 1 }, (_, i) => i + 5),
        7,
      ]);
    });

    it('records no history entry for a dormant cycle that saw no usage at all', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ leads_used_this_cycle: 0, overage_leads_this_cycle: 0 }),
      );
      repository.claimCycleRollover.mockResolvedValue(rolled(makeSub()));

      await service.getSubscription(BUSINESS_ID, new Date('2026-08-05T00:00:00Z'));

      // The anchor day is still written — this subscription predates it, and
      // leaving it unrecorded is what lets the cycle boundary drift off a short
      // month (see `billing-cycle-anchor.spec.ts`). What a dormant cycle must
      // not accumulate is an empty *history* entry every month.
      expect(writtenMetadata()?.['billingHistory']).toBeUndefined();
    });

    it('writes nothing at all once the anchor is already on record', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({
          leads_used_this_cycle: 0,
          overage_leads_this_cycle: 0,
          metadata: { billingAnchorDay: 1 },
        }),
      );
      repository.claimCycleRollover.mockResolvedValue(rolled(makeSub()));

      await service.getSubscription(BUSINESS_ID, new Date('2026-08-05T00:00:00Z'));

      expect(writtenMetadata()).toBeUndefined();
    });

    it('surfaces the history on the usage summary', async () => {
      const closed = {
        cycleStart: '2026-06-01T00:00:00.000Z',
        cycleEnd: '2026-07-01T00:00:00.000Z',
        plan: RealtyPlan.SOLO,
        planPricePaise: 399900,
        leadsUsed: 310,
        overageLeads: 10,
        overageRatePaise: OVERAGE_RATE_PAISE,
        overageChargePaise: 8000,
      };
      repository.findByBusiness.mockResolvedValue(
        makeSub({ metadata: { billingHistory: [closed] } as never }),
      );
      repository.countSeats.mockResolvedValue(1);

      const summary = await service.getUsageSummary(BUSINESS_ID, CYCLE_START);

      expect(summary.billingHistory).toEqual([closed]);
    });

    it('reports an empty history when the subscription has never rolled over', async () => {
      repository.findByBusiness.mockResolvedValue(makeSub());
      repository.countSeats.mockResolvedValue(1);

      const summary = await service.getUsageSummary(BUSINESS_ID, CYCLE_START);

      expect(summary.billingHistory).toEqual([]);
    });
  });

  // ── Limit checks ──
  describe('checkPlanLimits — exchange', () => {
    it('blocks the exchange on SOLO', async () => {
      repository.findByBusiness.mockResolvedValue(makeSub({ plan: RealtyPlan.SOLO }));
      const check = await service.checkPlanLimits(BUSINESS_ID, 'exchange', CYCLE_START);
      expect(check.allowed).toBe(false);
    });

    it('allows the exchange on TEAM', async () => {
      repository.findByBusiness.mockResolvedValue(makeSub({ plan: RealtyPlan.TEAM }));
      const check = await service.checkPlanLimits(BUSINESS_ID, 'exchange', CYCLE_START);
      expect(check.allowed).toBe(true);
    });

    it('allows the exchange on DEVELOPER', async () => {
      repository.findByBusiness.mockResolvedValue(makeSub({ plan: RealtyPlan.DEVELOPER }));
      const check = await service.checkPlanLimits(BUSINESS_ID, 'exchange', CYCLE_START);
      expect(check.allowed).toBe(true);
    });
  });

  describe('checkPlanLimits — seats', () => {
    it('allows a new seat below the limit', async () => {
      repository.findByBusiness.mockResolvedValue(makeSub({ seat_limit: 5 }));
      repository.countSeats.mockResolvedValue(2);

      const check = await service.checkPlanLimits(BUSINESS_ID, 'seats', CYCLE_START);

      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(3);
      expect(check.overLimit).toBe(false);
    });

    it('blocks a new seat at the limit', async () => {
      repository.findByBusiness.mockResolvedValue(makeSub({ seat_limit: 1 }));
      repository.countSeats.mockResolvedValue(1);

      const check = await service.checkPlanLimits(BUSINESS_ID, 'seats', CYCLE_START);

      expect(check.allowed).toBe(false);
      expect(check.overLimit).toBe(true);
      expect(check.remaining).toBe(0);
    });

    it('treats a null seat limit as unlimited (DEVELOPER)', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ plan: RealtyPlan.DEVELOPER, seat_limit: null }),
      );
      repository.countSeats.mockResolvedValue(999);

      const check = await service.checkPlanLimits(BUSINESS_ID, 'seats', CYCLE_START);

      expect(check.allowed).toBe(true);
      expect(check.limit).toBeNull();
      expect(check.remaining).toBeNull();
    });
  });

  describe('checkPlanLimits — leads', () => {
    it('allows a lead below the monthly limit', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 100 }),
      );

      const check = await service.checkPlanLimits(BUSINESS_ID, 'leads', CYCLE_START);

      expect(check.allowed).toBe(true);
      expect(check.overLimit).toBe(false);
      expect(check.remaining).toBe(200);
    });

    it('allows an over-limit lead when the plan auto-bills overage (default)', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 300 }),
      );

      const check = await service.checkPlanLimits(BUSINESS_ID, 'leads', CYCLE_START);

      expect(check.overLimit).toBe(true);
      expect(check.autoBillOverage).toBe(true);
      expect(check.allowed).toBe(true);
      expect(check.remaining).toBe(0);
    });

    it('hard-blocks an over-limit lead when metadata.hardCap is set', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({
          monthly_lead_limit: 300,
          leads_used_this_cycle: 300,
          metadata: { hardCap: true },
        }),
      );

      const check = await service.checkPlanLimits(BUSINESS_ID, 'leads', CYCLE_START);

      expect(check.overLimit).toBe(true);
      expect(check.autoBillOverage).toBe(false);
      expect(check.allowed).toBe(false);
    });

    it('treats a null lead limit as unlimited (DEVELOPER)', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ plan: RealtyPlan.DEVELOPER, monthly_lead_limit: null, leads_used_this_cycle: 5000 }),
      );

      const check = await service.checkPlanLimits(BUSINESS_ID, 'leads', CYCLE_START);

      expect(check.allowed).toBe(true);
      expect(check.overLimit).toBe(false);
      expect(check.remaining).toBeNull();
    });
  });

  describe('canUseExchange', () => {
    it('returns false for SOLO and true for TEAM', async () => {
      // canUseExchange has no `now` param, so getSubscription rolls over
      // against the real wall clock — stub the rollover claim so that rollover
      // (which will keep happening as real time moves past CYCLE_START) still
      // resolves to a subscription with the same plan, instead of undefined.
      repository.findByBusiness.mockResolvedValueOnce(makeSub({ plan: RealtyPlan.SOLO }));
      repository.claimCycleRollover.mockResolvedValueOnce(
        rolled(makeSub({ plan: RealtyPlan.SOLO })),
      );
      expect(await service.canUseExchange(BUSINESS_ID)).toBe(false);

      repository.findByBusiness.mockResolvedValueOnce(makeSub({ plan: RealtyPlan.TEAM }));
      repository.claimCycleRollover.mockResolvedValueOnce(
        rolled(makeSub({ plan: RealtyPlan.TEAM })),
      );
      expect(await service.canUseExchange(BUSINESS_ID)).toBe(true);
    });
  });

  // ── Usage recording ──
  describe('recordLeadUsage', () => {
    it('increments usage and emits realty.lead_usage.recorded', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 10 }),
      );
      repository.incrementUsage.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 11 }),
      );

      await service.recordLeadUsage(BUSINESS_ID, CYCLE_START);

      expect(repository.incrementUsage).toHaveBeenCalledWith(BUSINESS_ID, 1, 0);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead_usage.recorded',
        expect.objectContaining({
          type: 'realty.lead_usage.recorded',
          leadsUsed: 11,
          monthlyLeadLimit: 300,
          overage: false,
        }),
      );
    });

    it('bills a lead beyond the included allotment as overage', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 300 }),
      );
      repository.incrementUsage.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 301, overage_leads_this_cycle: 1 }),
      );

      await service.recordLeadUsage(BUSINESS_ID, CYCLE_START);

      // overageDelta of 1 → the lead is billed as overage.
      expect(repository.incrementUsage).toHaveBeenCalledWith(BUSINESS_ID, 1, 1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead_usage.recorded',
        expect.objectContaining({ overage: true }),
      );
    });

    it('fires realty.lead_limit.reached exactly once, on the lead that hits the cap', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 299 }),
      );
      repository.incrementUsage.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 300 }),
      );

      await service.recordLeadUsage(BUSINESS_ID, CYCLE_START);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead_limit.reached',
        expect.objectContaining({
          type: 'realty.lead_limit.reached',
          plan: RealtyPlan.SOLO,
          monthlyLeadLimit: 300,
          leadsUsed: 300,
        }),
      );
    });

    it('does not re-fire the limit alert once already over the cap', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 305 }),
      );
      repository.incrementUsage.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 306, overage_leads_this_cycle: 6 }),
      );

      await service.recordLeadUsage(BUSINESS_ID, CYCLE_START);

      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'realty.lead_limit.reached',
        expect.anything(),
      );
    });

    it('never bills overage or fires the limit alert on an unlimited plan', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({ plan: RealtyPlan.DEVELOPER, monthly_lead_limit: null, leads_used_this_cycle: 9000 }),
      );
      repository.incrementUsage.mockResolvedValue(
        makeSub({ plan: RealtyPlan.DEVELOPER, monthly_lead_limit: null, leads_used_this_cycle: 9001 }),
      );

      await service.recordLeadUsage(BUSINESS_ID, CYCLE_START);

      expect(repository.incrementUsage).toHaveBeenCalledWith(BUSINESS_ID, 1, 0);
      expect(eventEmitter.emit).not.toHaveBeenCalledWith(
        'realty.lead_limit.reached',
        expect.anything(),
      );
    });
  });

  // ── Event listener ──
  describe('onLeadCreated', () => {
    const event = {
      businessId: BUSINESS_ID,
      type: 'realty.lead.created',
    } as RealtyLeadCreatedEvent;

    it('records usage for the created lead', async () => {
      const spy = jest.spyOn(service, 'recordLeadUsage').mockResolvedValue(makeSub());
      await service.onLeadCreated(event);
      expect(spy).toHaveBeenCalledWith(BUSINESS_ID);
    });

    it('swallows a billing error so lead capture is never aborted', async () => {
      jest.spyOn(service, 'recordLeadUsage').mockRejectedValue(new Error('db down'));
      await expect(service.onLeadCreated(event)).resolves.toBeUndefined();
    });

    it('logs a non-Error rejection by stringifying it, rather than logging undefined', async () => {
      // A driver that rejects with a bare string or object has no `.message`;
      // reading it blindly would put "undefined" in the log for every such fault.
      const logged = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      jest.spyOn(service, 'recordLeadUsage').mockRejectedValue('ECONNRESET');

      await expect(service.onLeadCreated(event)).resolves.toBeUndefined();

      expect(logged).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
      logged.mockRestore();
    });
  });

  // ── Usage summary ──
  describe('getUsageSummary', () => {
    it('summarises plan, meters, seats, and the accrued overage charge', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({
          plan: RealtyPlan.TEAM,
          monthly_lead_limit: 1500,
          seat_limit: 5,
          plan_price_paise: 999900,
          leads_used_this_cycle: 1600,
          overage_leads_this_cycle: 100,
          overage_rate_paise: 800,
        }),
      );
      repository.countSeats.mockResolvedValue(3);

      const summary = await service.getUsageSummary(BUSINESS_ID, CYCLE_START);

      expect(summary.plan).toBe(RealtyPlan.TEAM);
      expect(summary.planLabel).toBe('Team');
      expect(summary.exchangeEnabled).toBe(true);
      expect(summary.leadsUsedThisCycle).toBe(1600);
      expect(summary.overageLeadsThisCycle).toBe(100);
      expect(summary.overageChargePaise).toBe(80000); // 100 × 800
      expect(summary.seatsUsed).toBe(3);
      expect(summary.billingCycleEnd).toEqual(new Date('2026-08-01T00:00:00Z'));
      expect(summary.meters).toEqual([
        { key: 'leads', label: 'Leads this cycle', used: 1600, limit: 1500, unit: 'leads' },
        { key: 'seats', label: 'Team seats', used: 3, limit: 5, unit: 'seats' },
      ]);
    });
  });

  // ── Upgrades ──
  describe('upgradePlan', () => {
    it('switches the plan, applies the new limits, and emits + audits the change', async () => {
      const solo = makeSub({ plan: RealtyPlan.SOLO, leads_used_this_cycle: 50 });
      // getSubscription (start) then getUsageSummary (end) both hit findByBusiness.
      repository.findByBusiness
        .mockResolvedValueOnce(solo)
        .mockResolvedValueOnce(makeSub({ plan: RealtyPlan.TEAM, leads_used_this_cycle: 50 }));
      repository.update.mockResolvedValue(makeSub({ plan: RealtyPlan.TEAM }));
      repository.countSeats.mockResolvedValue(1);

      const summary = await service.upgradePlan(BUSINESS_ID, RealtyPlan.TEAM, CYCLE_START);

      expect(repository.update).toHaveBeenCalledWith(BUSINESS_ID, {
        plan: RealtyPlan.TEAM,
        monthlyLeadLimit: 1500,
        seatLimit: 5,
        planPricePaise: 999900,
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.plan.changed',
        expect.objectContaining({
          type: 'realty.plan.changed',
          fromPlan: RealtyPlan.SOLO,
          toPlan: RealtyPlan.TEAM,
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS_ID,
          action: 'UPDATE',
          resourceType: 'business_subscription',
          before: { plan: RealtyPlan.SOLO },
          after: { plan: RealtyPlan.TEAM, pricePaise: 999900 },
        }),
      );
      // Mid-cycle upgrade preserves the running lead counter.
      expect(summary.leadsUsedThisCycle).toBe(50);
    });

    // G002: the row was written as TEAM_MEMBER with no actor_id, so it named
    // nobody. It now carries the actor the controller hands down.
    it('attributes the audit row to the actor when one is given', async () => {
      repository.findByBusiness
        .mockResolvedValueOnce(makeSub({ plan: RealtyPlan.SOLO }))
        .mockResolvedValueOnce(makeSub({ plan: RealtyPlan.TEAM }));
      repository.update.mockResolvedValue(makeSub({ plan: RealtyPlan.TEAM }));
      repository.countSeats.mockResolvedValue(1);

      await service.upgradePlan(BUSINESS_ID, RealtyPlan.TEAM, CYCLE_START, {
        id: '00000000-0000-4000-c000-000000000001',
        email: 'owner@example.com',
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'TEAM_MEMBER',
          actorId: '00000000-0000-4000-c000-000000000001',
          actorEmail: 'owner@example.com',
        }),
      );
    });

    it('attributes the audit row to SYSTEM, not an anonymous member, without an actor', async () => {
      repository.findByBusiness
        .mockResolvedValueOnce(makeSub({ plan: RealtyPlan.SOLO }))
        .mockResolvedValueOnce(makeSub({ plan: RealtyPlan.TEAM }));
      repository.update.mockResolvedValue(makeSub({ plan: RealtyPlan.TEAM }));
      repository.countSeats.mockResolvedValue(1);

      await service.upgradePlan(BUSINESS_ID, RealtyPlan.TEAM, CYCLE_START);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'SYSTEM', actorId: null }),
      );
    });

    it('is a no-op when the target plan matches the current plan', async () => {
      repository.findByBusiness.mockResolvedValue(makeSub({ plan: RealtyPlan.TEAM }));
      repository.countSeats.mockResolvedValue(1);

      await service.upgradePlan(BUSINESS_ID, RealtyPlan.TEAM, CYCLE_START);

      expect(repository.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalledWith('realty.plan.changed', expect.anything());
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // ── CRM sync gating ──
  describe('checkPlanLimits — crm_sync', () => {
    it.each([
      [RealtyPlan.SOLO, PLAN_DEFINITIONS[RealtyPlan.SOLO].crmSyncEnabled],
      [RealtyPlan.TEAM, PLAN_DEFINITIONS[RealtyPlan.TEAM].crmSyncEnabled],
      [RealtyPlan.DEVELOPER, PLAN_DEFINITIONS[RealtyPlan.DEVELOPER].crmSyncEnabled],
    ])('gates CRM sync on %s by the plan definition', async (plan, enabled) => {
      repository.findByBusiness.mockResolvedValue(makeSub({ plan }));

      const check = await service.checkPlanLimits(BUSINESS_ID, 'crm_sync', CYCLE_START);

      expect(check.allowed).toBe(enabled);
      // A feature flag is not metered: no limit, no usage, never "over".
      expect(check).toMatchObject({
        resource: 'crm_sync',
        limit: null,
        used: 0,
        remaining: null,
        overLimit: false,
        autoBillOverage: false,
        plan,
      });
    });

    it('checks CRM sync separately from exchange, not as one "paid feature" flag', async () => {
      // Both are cond-expr arms of the same check; a plan that has one but not
      // the other is what stops them collapsing into a single boolean.
      const differing = Object.values(RealtyPlan).filter(
        (p) => PLAN_DEFINITIONS[p].exchangeEnabled !== PLAN_DEFINITIONS[p].crmSyncEnabled,
      );
      for (const plan of differing) {
        repository.findByBusiness.mockResolvedValue(makeSub({ plan }));
        const exchange = await service.checkPlanLimits(BUSINESS_ID, 'exchange', CYCLE_START);
        const crm = await service.checkPlanLimits(BUSINESS_ID, 'crm_sync', CYCLE_START);
        expect(exchange.allowed).not.toBe(crm.allowed);
      }
    });
  });

  describe('canUseCrmSync', () => {
    it('is a thin wrapper over the crm_sync limit check', async () => {
      // No `now` param, so getSubscription rolls over against the wall clock —
      // start the cycle now so nothing has elapsed and `update` is never needed.
      repository.findByBusiness.mockResolvedValueOnce(
        makeSub({ plan: RealtyPlan.DEVELOPER, billing_cycle_start: new Date() }),
      );
      expect(await service.canUseCrmSync(BUSINESS_ID)).toBe(
        PLAN_DEFINITIONS[RealtyPlan.DEVELOPER].crmSyncEnabled,
      );

      repository.findByBusiness.mockResolvedValueOnce(
        makeSub({ plan: RealtyPlan.SOLO, billing_cycle_start: new Date() }),
      );
      expect(await service.canUseCrmSync(BUSINESS_ID)).toBe(
        PLAN_DEFINITIONS[RealtyPlan.SOLO].crmSyncEnabled,
      );
    });
  });

  // ── Hard-cap metadata ──
  describe('autoBillEnabled', () => {
    it('auto-bills overage when the subscription has no metadata at all', async () => {
      // metadata is nullable in the schema; a row written before the hard-cap
      // flag existed has NULL there and must still auto-bill, not hard-block.
      repository.findByBusiness.mockResolvedValue(
        makeSub({
          monthly_lead_limit: 300,
          leads_used_this_cycle: 300,
          metadata: null as never,
        }),
      );

      const check = await service.checkPlanLimits(BUSINESS_ID, 'leads', CYCLE_START);

      expect(check.overLimit).toBe(true);
      expect(check.autoBillOverage).toBe(true);
      expect(check.allowed).toBe(true);
    });

    it('still hard-caps when metadata carries an unrelated key', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({
          monthly_lead_limit: 300,
          leads_used_this_cycle: 300,
          metadata: { hardCap: 'yes' } as never,
        }),
      );

      // Only the boolean `true` opts into a hard cap — a truthy string does not.
      const check = await service.checkPlanLimits(BUSINESS_ID, 'leads', CYCLE_START);

      expect(check.autoBillOverage).toBe(true);
    });
  });

  // ── Wall-clock defaults ──
  //
  // Every dated method takes `now` so tests can pin it, and production calls
  // them without it. These pin the default arm: a cycle that started "now" has
  // not elapsed, so the result must match the explicit-date behaviour exactly.
  describe('defaults `now` to the wall clock', () => {
    it('getSubscription reads the current cycle without rolling it over', async () => {
      const sub = makeSub({ billing_cycle_start: new Date() });
      repository.findByBusiness.mockResolvedValue(sub);

      expect(await service.getSubscription(BUSINESS_ID)).toBe(sub);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('getSubscription still creates the default SOLO row, stamped with the wall clock', async () => {
      repository.findByBusiness.mockResolvedValue(null);
      repository.create.mockResolvedValue(makeSub({ billing_cycle_start: new Date() }));

      const before = Date.now();
      await service.getSubscription(BUSINESS_ID);

      const arg = repository.create.mock.calls[0]![0] as { billingCycleStart: Date };
      expect(arg.billingCycleStart.getTime()).toBeGreaterThanOrEqual(before);
      expect(arg.billingCycleStart.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('recordLeadUsage meters against the current cycle', async () => {
      repository.findByBusiness.mockResolvedValue(
        makeSub({
          billing_cycle_start: new Date(),
          monthly_lead_limit: 300,
          leads_used_this_cycle: 10,
        }),
      );
      repository.incrementUsage.mockResolvedValue(
        makeSub({ monthly_lead_limit: 300, leads_used_this_cycle: 11 }),
      );

      await service.recordLeadUsage(BUSINESS_ID);

      expect(repository.incrementUsage).toHaveBeenCalledWith(BUSINESS_ID, 1, 0);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.lead_usage.recorded',
        expect.objectContaining({ leadsUsed: 11, overage: false }),
      );
    });

    it('getUsageSummary reports the current cycle window', async () => {
      const cycleStart = new Date();
      repository.findByBusiness.mockResolvedValue(
        makeSub({ billing_cycle_start: cycleStart }),
      );
      repository.countSeats.mockResolvedValue(2);

      const summary = await service.getUsageSummary(BUSINESS_ID);

      expect(summary.billingCycleStart).toEqual(cycleStart);
      expect(summary.billingCycleEnd.getTime()).toBeGreaterThan(cycleStart.getTime());
      expect(summary.seatsUsed).toBe(2);
    });

    it('upgradePlan switches the plan without an explicit date', async () => {
      const cycleStart = new Date();
      repository.findByBusiness
        .mockResolvedValueOnce(makeSub({ plan: RealtyPlan.SOLO, billing_cycle_start: cycleStart }))
        .mockResolvedValueOnce(makeSub({ plan: RealtyPlan.TEAM, billing_cycle_start: cycleStart }));
      repository.update.mockResolvedValue(makeSub({ plan: RealtyPlan.TEAM }));
      repository.countSeats.mockResolvedValue(1);

      const summary = await service.upgradePlan(BUSINESS_ID, RealtyPlan.TEAM);

      expect(summary.plan).toBe(RealtyPlan.TEAM);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'realty.plan.changed',
        expect.objectContaining({ fromPlan: RealtyPlan.SOLO, toPlan: RealtyPlan.TEAM }),
      );
    });
  });
});
