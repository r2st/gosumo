/**
 * BillingService — where one cycle ends and the next begins.
 *
 * The bug this pins is a slow one. `rolloverIfElapsed` walked forward by
 * calling `addMonths(cycleStart, 1)` on its own previous output, and
 * `addMonths` clamps a day that the target month does not have. So a tenant who
 * signed up on 31 January got a February cycle starting the 28th — correct, and
 * unavoidable — and then a *March* cycle starting the 28th, and an April cycle
 * starting the 28th, forever. Three days of every subsequent month moved to the
 * wrong side of the boundary, and the counters they reset are what the tenant
 * is invoiced on.
 *
 * Nothing about it looks wrong from inside a single rollover, which is why it
 * needs a test that runs several.
 *
 * The other half is IST. `billing_cycle_start` is `timestamptz` and the
 * arithmetic is UTC, so a cycle that starts at midnight in Mumbai is stored at
 * 18:30 the previous day. India runs no DST, so carrying the time of day
 * through unchanged keeps every boundary on the same wall-clock instant — but
 * only if the arithmetic never rebuilds the date from local parts.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RealtyPlan } from '@prisma/client';
import type { business_subscriptions } from '@prisma/client';

import {
  BillingService,
  cycleBoundaryAfter,
  readAnchorDay,
  BILLING_ANCHOR_DAY_KEY,
} from './billing.service';
import { BillingRepository } from './billing.repository';
import { RealtyOperationsAuditService } from '../realty-hardening/realty-operations-audit.service';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

function subscription(over: Partial<business_subscriptions> = {}): business_subscriptions {
  return {
    id: 'sub_1',
    business_id: BUSINESS_ID,
    plan: RealtyPlan.SOLO,
    monthly_lead_limit: 300,
    seat_limit: 1,
    plan_price_paise: 399900,
    overage_rate_paise: 800,
    billing_cycle_start: new Date('2026-01-31T00:00:00.000Z'),
    leads_used_this_cycle: 0,
    overage_leads_this_cycle: 0,
    metadata: {},
    created_at: new Date('2026-01-31T00:00:00.000Z'),
    updated_at: new Date('2026-01-31T00:00:00.000Z'),
    ...over,
  } as unknown as business_subscriptions;
}

describe('cycleBoundaryAfter', () => {
  it('lands on the anchor day in a month that has it', () => {
    const next = cycleBoundaryAfter(new Date('2026-03-31T00:00:00Z'), 31);
    expect(next.toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });

  it('clamps to the last day of a month that is too short', () => {
    const next = cycleBoundaryAfter(new Date('2026-01-31T00:00:00Z'), 31);
    expect(next.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('recovers the anchor from a month that clamped it', () => {
    // This one line is the whole fix: February's 28th must still lead to
    // March's 31st, not to another 28th.
    const next = cycleBoundaryAfter(new Date('2026-02-28T00:00:00Z'), 31);
    expect(next.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('handles a leap February', () => {
    const next = cycleBoundaryAfter(new Date('2028-01-30T00:00:00Z'), 30);
    expect(next.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('rolls the year over in December', () => {
    const next = cycleBoundaryAfter(new Date('2026-12-15T00:00:00Z'), 15);
    expect(next.toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });

  it('carries the time of day through, so an IST midnight stays an IST midnight', () => {
    // 2026-08-31T18:30Z is 1 September 00:00 in Mumbai.
    const next = cycleBoundaryAfter(new Date('2026-07-31T18:30:00.000Z'), 31);
    expect(next.toISOString()).toBe('2026-08-31T18:30:00.000Z');
  });
});

describe('readAnchorDay', () => {
  it('prefers the recorded anchor', () => {
    const sub = subscription({
      billing_cycle_start: new Date('2026-02-28T00:00:00Z'),
      metadata: { [BILLING_ANCHOR_DAY_KEY]: 31 },
    });
    expect(readAnchorDay(sub)).toBe(31);
  });

  it('falls back to the current cycle day for a row written before anchors existed', () => {
    const sub = subscription({
      billing_cycle_start: new Date('2026-06-15T00:00:00Z'),
      metadata: {},
    });
    expect(readAnchorDay(sub)).toBe(15);
  });

  it('ignores a stored value that is not a real day of the month', () => {
    for (const junk of [0, 32, -1, 'the 5th', null, 15.5]) {
      const sub = subscription({
        billing_cycle_start: new Date('2026-06-15T00:00:00Z'),
        metadata: { [BILLING_ANCHOR_DAY_KEY]: junk } as never,
      });
      expect(readAnchorDay(sub)).toBe(15);
    }
  });
});

describe('BillingService — cycle rollover', () => {
  let service: BillingService;
  let repo: {
    findByBusiness: jest.Mock;
    create: jest.Mock;
    claimCycleRollover: jest.Mock;
    countSeats: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      findByBusiness: jest.fn(),
      create: jest.fn(),
      claimCycleRollover: jest
        .fn()
        .mockImplementation((_b, _from, data) => ({ subscription: null, claimed: true, data })),
      countSeats: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingService,
        { provide: BillingRepository, useValue: repo },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: RealtyOperationsAuditService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get(BillingService);
  });

  /** The `billingCycleStart` the rollover claimed. */
  function claimedStart(): string {
    expect(repo.claimCycleRollover).toHaveBeenCalled();
    const data = repo.claimCycleRollover.mock.calls[0]![2] as { billingCycleStart: Date };
    return data.billingCycleStart.toISOString();
  }

  it('records the signup day as the anchor on first access', async () => {
    repo.findByBusiness.mockResolvedValue(null);
    repo.create.mockImplementation((data) => subscription({ billing_cycle_start: data.billingCycleStart }));

    await service.getSubscription(BUSINESS_ID, new Date('2026-01-31T00:00:00Z'));

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { [BILLING_ANCHOR_DAY_KEY]: 31 } }),
    );
  });

  it('does not roll a cycle that is still current', async () => {
    repo.findByBusiness.mockResolvedValue(
      subscription({ billing_cycle_start: new Date('2026-08-01T00:00:00Z') }),
    );
    await service.getSubscription(BUSINESS_ID, new Date('2026-08-15T00:00:00Z'));
    expect(repo.claimCycleRollover).not.toHaveBeenCalled();
  });

  it('clamps the February boundary for a 31st anchor', async () => {
    repo.findByBusiness.mockResolvedValue(
      subscription({
        billing_cycle_start: new Date('2026-01-31T00:00:00Z'),
        metadata: { [BILLING_ANCHOR_DAY_KEY]: 31 },
      }),
    );
    await service.getSubscription(BUSINESS_ID, new Date('2026-03-01T00:00:00Z'));
    expect(claimedStart()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('returns to the 31st in March instead of staying on the 28th', async () => {
    // The regression itself. Before the fix this claimed 2026-03-28.
    repo.findByBusiness.mockResolvedValue(
      subscription({
        billing_cycle_start: new Date('2026-02-28T00:00:00Z'),
        metadata: { [BILLING_ANCHOR_DAY_KEY]: 31 },
      }),
    );
    await service.getSubscription(BUSINESS_ID, new Date('2026-04-01T00:00:00Z'));
    expect(claimedStart()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('does not drift when a dormant tenant is caught up across many months', async () => {
    // Jan 31 → ... → Aug 31, walked in one call. Stepping off each clamped
    // result instead would land on the 28th and stay there.
    repo.findByBusiness.mockResolvedValue(
      subscription({
        billing_cycle_start: new Date('2026-01-31T00:00:00Z'),
        metadata: { [BILLING_ANCHOR_DAY_KEY]: 31 },
      }),
    );
    await service.getSubscription(BUSINESS_ID, new Date('2026-09-01T00:00:00Z'));
    expect(claimedStart()).toBe('2026-08-31T00:00:00.000Z');
  });

  it('backfills the anchor for a subscription that predates it', async () => {
    // Without this the fallback re-derives the anchor from the drifted cycle
    // start on every rollover, and the drift simply resumes.
    repo.findByBusiness.mockResolvedValue(
      subscription({ billing_cycle_start: new Date('2026-01-15T00:00:00Z'), metadata: {} }),
    );
    await service.getSubscription(BUSINESS_ID, new Date('2026-02-20T00:00:00Z'));

    const data = repo.claimCycleRollover.mock.calls[0]![2] as { metadata?: Record<string, unknown> };
    expect(data.metadata?.[BILLING_ANCHOR_DAY_KEY]).toBe(15);
  });

  it('keeps the anchor alongside the closing cycle snapshot', async () => {
    repo.findByBusiness.mockResolvedValue(
      subscription({
        billing_cycle_start: new Date('2026-01-31T00:00:00Z'),
        metadata: { [BILLING_ANCHOR_DAY_KEY]: 31 },
        leads_used_this_cycle: 310,
        overage_leads_this_cycle: 10,
      }),
    );
    await service.getSubscription(BUSINESS_ID, new Date('2026-03-01T00:00:00Z'));

    const data = repo.claimCycleRollover.mock.calls[0]![2] as {
      metadata?: { billingHistory?: Array<Record<string, unknown>>; [k: string]: unknown };
    };
    expect(data.metadata?.[BILLING_ANCHOR_DAY_KEY]).toBe(31);

    const history = data.metadata?.billingHistory ?? [];
    expect(history).toHaveLength(1);
    // Overage accrued in the closing cycle is real money owed and the counters
    // are about to be zeroed; the snapshot is the only place it survives.
    expect(history[0]).toEqual(
      expect.objectContaining({
        cycleStart: '2026-01-31T00:00:00.000Z',
        cycleEnd: '2026-02-28T00:00:00.000Z',
        leadsUsed: 310,
        overageLeads: 10,
        overageChargePaise: 8000,
      }),
    );
  });

  it('writes nothing extra for a dormant tenant whose anchor is already recorded', async () => {
    repo.findByBusiness.mockResolvedValue(
      subscription({
        billing_cycle_start: new Date('2026-01-15T00:00:00Z'),
        metadata: { [BILLING_ANCHOR_DAY_KEY]: 15 },
      }),
    );
    await service.getSubscription(BUSINESS_ID, new Date('2026-02-20T00:00:00Z'));

    const data = repo.claimCycleRollover.mock.calls[0]![2] as Record<string, unknown>;
    expect(data['metadata']).toBeUndefined();
  });

  it('reports the cycle end the rollover will actually use', async () => {
    // The billing page and the meter reset must name the same date. Adding a
    // month naively to a clamped February start reports 28 March while the
    // rollover ends the cycle on the 31st.
    repo.findByBusiness.mockResolvedValue(
      subscription({
        billing_cycle_start: new Date('2026-02-28T00:00:00Z'),
        metadata: { [BILLING_ANCHOR_DAY_KEY]: 31 },
      }),
    );

    const summary = await service.getUsageSummary(BUSINESS_ID, new Date('2026-03-10T00:00:00Z'));

    expect(summary.billingCycleEnd.toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('holds the boundary at the same IST instant across a short month', async () => {
    // 2025-12-31T18:30Z is 1 January 00:00 in Mumbai. The January and February
    // boundaries must land at 18:30Z too, or the tenant's cycle starts at a
    // different time of day each month.
    repo.findByBusiness.mockResolvedValue(
      subscription({
        billing_cycle_start: new Date('2025-12-31T18:30:00.000Z'),
        metadata: { [BILLING_ANCHOR_DAY_KEY]: 31 },
      }),
    );
    await service.getSubscription(BUSINESS_ID, new Date('2026-03-05T00:00:00Z'));
    expect(claimedStart()).toBe('2026-02-28T18:30:00.000Z');
  });
});
