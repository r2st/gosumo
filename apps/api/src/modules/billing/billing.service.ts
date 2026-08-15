import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma, RealtyPlan } from '@prisma/client';
import type { business_subscriptions } from '@prisma/client';
import {
  generateId,
  generateCorrelationId,
} from '@gosumo/shared';
import type {
  RealtyPlanChangedEvent,
  RealtyLeadUsageRecordedEvent,
  RealtyLeadLimitReachedEvent,
  RealtyLeadCreatedEvent,
} from '@gosumo/shared';
import { BillingRepository } from './billing.repository';
import {
  DEFAULT_PLAN,
  OVERAGE_RATE_PAISE,
  PLAN_DEFINITIONS,
  PlanResource,
  planDefinition,
} from './billing.constants';
import { RealtyOperationsAuditService } from '../realty-hardening/realty-operations-audit.service';

// ─────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────

/** The verdict of a single plan-limit check (used by the guard + controllers). */
export interface LimitCheck {
  resource: PlanResource;
  allowed: boolean;
  /** null = unlimited. */
  limit: number | null;
  used: number;
  /** null = unlimited. */
  remaining: number | null;
  /** True when `used` is at/over `limit` (only meaningful for metered resources). */
  overLimit: boolean;
  /** When over the limit, whether the extra unit is auto-billed as overage. */
  autoBillOverage: boolean;
  plan: RealtyPlan;
}

export interface UsageMeter {
  key: PlanResource;
  label: string;
  used: number;
  limit: number | null;
  unit: string;
}

/**
 * A billing cycle that has closed, snapshotted at rollover. The live counters
 * reset to zero, so this is the only surviving record of what the cycle owed.
 */
export interface ClosedCycle {
  cycleStart: string;
  cycleEnd: string;
  plan: RealtyPlan;
  planPricePaise: number;
  leadsUsed: number;
  overageLeads: number;
  overageRatePaise: number;
  overageChargePaise: number;
}

export interface UsageSummary {
  plan: RealtyPlan;
  planLabel: string;
  planPricePaise: number;
  overageRatePaise: number;
  monthlyLeadLimit: number | null;
  seatLimit: number | null;
  exchangeEnabled: boolean;
  billingCycleStart: Date;
  billingCycleEnd: Date;
  leadsUsedThisCycle: number;
  overageLeadsThisCycle: number;
  overageChargePaise: number;
  seatsUsed: number;
  meters: UsageMeter[];
  /** Closed cycles, oldest first — what each one owed after its counters reset. */
  billingHistory: ClosedCycle[];
}

/**
 * How many closed cycles to keep on the subscription's metadata. A year of
 * history covers any realistic reconciliation window and keeps the JSONB column
 * from growing without bound over the life of the tenant.
 */
export const BILLING_HISTORY_LIMIT = 12;

/**
 * Metadata key holding the day of the month the billing cycle is anchored to.
 *
 * The anchor cannot live in `billing_cycle_start` alone, because that column
 * holds the *current* cycle's start and short months rewrite it. A tenant who
 * signed up on the 31st has a February cycle that necessarily starts on the
 * 28th, and rolling forward from that clamped date is what made the anchor
 * drift: March started on the 28th too, and every month after it, so the
 * boundary walked three days earlier and stayed there. Recording the day the
 * tenant actually signed up keeps March 31 reachable from February 28.
 */
export const BILLING_ANCHOR_DAY_KEY = 'billingAnchorDay';

/**
 * The day of the month this subscription's cycles are anchored to.
 *
 * Falls back to the current cycle's own day for rows written before the anchor
 * was recorded. That fallback preserves whatever day those rows are on now
 * rather than inventing an original — a subscription that has already drifted
 * cannot be un-drifted from the data that remains, and guessing would move a
 * live tenant's billing boundary.
 */
export function readAnchorDay(sub: business_subscriptions): number {
  const meta = (sub.metadata ?? {}) as Record<string, unknown>;
  const stored = meta[BILLING_ANCHOR_DAY_KEY];
  if (typeof stored === 'number' && Number.isInteger(stored) && stored >= 1 && stored <= 31) {
    return stored;
  }
  return sub.billing_cycle_start.getUTCDate();
}

/**
 * The start of the cycle following the one that began at `cycleStart`, landing
 * on `anchorDay` and clamping to the month's length where it has to.
 *
 * Time of day is carried over unchanged. India runs no DST and the column is
 * `timestamptz`, so adding a calendar month in UTC keeps the same wall-clock
 * time in IST — the boundary a tenant sees does not wander across the day.
 */
export function cycleBoundaryAfter(cycleStart: Date, anchorDay: number): Date {
  const year = cycleStart.getUTCFullYear();
  const nextMonth = cycleStart.getUTCMonth() + 1;
  // Day 0 of the month after the target is the target's last day.
  const daysInNextMonth = new Date(Date.UTC(year, nextMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      nextMonth,
      Math.min(anchorDay, daysInNextMonth),
      cycleStart.getUTCHours(),
      cycleStart.getUTCMinutes(),
      cycleStart.getUTCSeconds(),
      cycleStart.getUTCMilliseconds(),
    ),
  );
}

/** Add `n` whole months to a date (UTC-safe, clamps day overflow to month end). */
export function addMonths(date: Date, n: number): Date {
  const d = new Date(date.getTime());
  const targetMonth = d.getUTCMonth() + n;
  const result = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      targetMonth,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  // Clamp when the target month is shorter (e.g. Jan 31 + 1mo → Feb 28/29).
  if (result.getUTCDate() < d.getUTCDate()) {
    result.setUTCDate(0);
  }
  return result;
}

/**
 * BillingService — pricing-tier enforcement for GoSumo Realty (business plan §9).
 *
 * Owns each business's subscription row, rolls the billing cycle over monthly,
 * enforces lead/seat limits, records lead usage (auto-billing overage on metered
 * plans), and handles upgrades. Exchange access is gated by tier (SOLO is blocked).
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly repository: BillingRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: RealtyOperationsAuditService,
  ) {}

  // ─────────────────────────────────────────────
  // Subscription lifecycle
  // ─────────────────────────────────────────────

  /**
   * Get the business's subscription, creating a default (SOLO) row on first
   * access, and rolling the billing cycle forward if it has elapsed.
   */
  async getSubscription(
    businessId: string,
    now: Date = new Date(),
  ): Promise<business_subscriptions> {
    let sub = await this.repository.findByBusiness(businessId);
    if (!sub) {
      const def = planDefinition(DEFAULT_PLAN);
      sub = await this.repository.create({
        businessId,
        plan: DEFAULT_PLAN,
        monthlyLeadLimit: def.monthlyLeadLimit,
        seatLimit: def.seatLimit,
        planPricePaise: def.pricePaise,
        overageRatePaise: OVERAGE_RATE_PAISE,
        billingCycleStart: now,
        // Stamped at creation, when the signup day is still known. Every later
        // read of it goes through `readAnchorDay`.
        metadata: { [BILLING_ANCHOR_DAY_KEY]: now.getUTCDate() },
      });
    }
    return this.rolloverIfElapsed(sub, now);
  }

  /**
   * Advance the billing cycle by whole months when the current cycle has ended,
   * resetting the usage counters. Idempotent when the cycle is still current.
   */
  private async rolloverIfElapsed(
    sub: business_subscriptions,
    now: Date,
  ): Promise<business_subscriptions> {
    // Walked from the *anchor* day, not from each clamped result. Stepping
    // `addMonths` off its own output loses the anchor the first time it passes
    // a short month: Jan 31 → Feb 28 → Mar 28 → Apr 28, and the tenant's
    // boundary has permanently moved three days earlier than the day they
    // signed up on. `cycleBoundaryAfter` re-derives the day each time, so the
    // same walk gives Jan 31 → Feb 28 → Mar 31 → Apr 30.
    const anchorDay = readAnchorDay(sub);
    let cycleStart = sub.billing_cycle_start;
    let advanced = false;
    let next = cycleBoundaryAfter(cycleStart, anchorDay);
    while (next.getTime() <= now.getTime()) {
      cycleStart = next;
      advanced = true;
      next = cycleBoundaryAfter(cycleStart, anchorDay);
    }
    if (!advanced) return sub;

    // The counters are about to be zeroed. Overage accrued in the cycle being
    // closed is real money owed, and nothing else in the system records it — so
    // without a snapshot here the charge simply disappears the first time
    // anything reads the subscription after the cycle ends, leaving nothing to
    // invoice or reconcile against.
    const metadata = this.rolloverMetadata(sub, anchorDay);

    // Claim the rollover rather than just performing it. Every billing read
    // lands here, including the per-lead usage path, so when a cycle ends the
    // concurrent callers all see it elapsed and all roll it — each appending a
    // closing snapshot built from the counters it read, which are the pre-reset
    // ones for every one of them. That records the same cycle as owed several
    // times in the only place the charge survives the counters being zeroed.
    const { subscription, claimed } = await this.repository.claimCycleRollover(
      sub.business_id,
      sub.billing_cycle_start,
      {
        billingCycleStart: cycleStart,
        leadsUsedThisCycle: 0,
        overageLeadsThisCycle: 0,
        ...(metadata !== undefined ? { metadata } : {}),
      },
    );

    if (!claimed) {
      this.logger.debug(
        `Billing cycle for business ${sub.business_id} was already rolled over by a concurrent caller`,
      );
      // The winner's row is the truth; returning the stale one would report
      // counters that have since been zeroed.
      return subscription ?? sub;
    }

    this.logger.log(
      `Billing cycle rolled over for business ${sub.business_id} → ${cycleStart.toISOString()}`,
    );
    return subscription ?? sub;
  }

  /**
   * The metadata to write alongside a rollover: the closing cycle's snapshot,
   * plus the anchor day for subscriptions predating it.
   *
   * Returns `undefined` when there is nothing to write at all — a dormant
   * tenant whose anchor is already recorded would otherwise accumulate an
   * identical write every month.
   *
   * Backfilling the anchor here is what makes the drift fix stick for existing
   * rows. Without it `readAnchorDay` falls back to the current cycle start
   * every time, and the cycle start is exactly the value a short month has
   * already moved — so the anchor would be re-derived from the drifted date and
   * the drift would resume on the next rollover.
   */
  private rolloverMetadata(
    sub: business_subscriptions,
    anchorDay: number,
  ): Prisma.InputJsonValue | undefined {
    const meta = (sub.metadata ?? {}) as Record<string, unknown>;
    const anchorMissing = meta[BILLING_ANCHOR_DAY_KEY] !== anchorDay;
    const hadUsage = sub.leads_used_this_cycle > 0 || sub.overage_leads_this_cycle > 0;

    if (!hadUsage) {
      return anchorMissing
        ? ({ ...meta, [BILLING_ANCHOR_DAY_KEY]: anchorDay } as Prisma.InputJsonValue)
        : undefined;
    }

    const prior = Array.isArray(meta['billingHistory'])
      ? (meta['billingHistory'] as ClosedCycle[])
      : [];

    const closed: ClosedCycle = {
      cycleStart: sub.billing_cycle_start.toISOString(),
      // The same boundary the rollover walked to, so the invoice line and the
      // new cycle's start agree on where one ended and the next began.
      cycleEnd: cycleBoundaryAfter(sub.billing_cycle_start, anchorDay).toISOString(),
      plan: sub.plan,
      planPricePaise: sub.plan_price_paise,
      leadsUsed: sub.leads_used_this_cycle,
      overageLeads: sub.overage_leads_this_cycle,
      overageRatePaise: sub.overage_rate_paise,
      overageChargePaise: sub.overage_leads_this_cycle * sub.overage_rate_paise,
    };

    const next: Record<string, unknown> = {
      ...meta,
      [BILLING_ANCHOR_DAY_KEY]: anchorDay,
      billingHistory: [...prior, closed].slice(-BILLING_HISTORY_LIMIT),
    };
    return next as Prisma.InputJsonValue;
  }

  /** Closed-cycle history held on the subscription's metadata (oldest first). */
  private readBillingHistory(sub: business_subscriptions): ClosedCycle[] {
    const meta = (sub.metadata ?? {}) as Record<string, unknown>;
    return Array.isArray(meta['billingHistory'])
      ? (meta['billingHistory'] as ClosedCycle[])
      : [];
  }

  // ─────────────────────────────────────────────
  // Limit checks (consumed by PlanGuard + controllers)
  // ─────────────────────────────────────────────

  /**
   * Evaluate whether `resource` is within the plan's limits for a business.
   * Never mutates. `leads`/`seats` are metered; `exchange` is a feature flag.
   */
  async checkPlanLimits(
    businessId: string,
    resource: PlanResource,
    now: Date = new Date(),
  ): Promise<LimitCheck> {
    const sub = await this.getSubscription(businessId, now);
    const plan = sub.plan;

    if (resource === 'exchange' || resource === 'crm_sync') {
      const enabled =
        resource === 'exchange'
          ? PLAN_DEFINITIONS[plan].exchangeEnabled
          : PLAN_DEFINITIONS[plan].crmSyncEnabled;
      return {
        resource,
        allowed: enabled,
        limit: null,
        used: 0,
        remaining: null,
        overLimit: false,
        autoBillOverage: false,
        plan,
      };
    }

    if (resource === 'seats') {
      const limit = sub.seat_limit;
      const used = await this.repository.countSeats(businessId);
      const overLimit = limit != null && used >= limit;
      return {
        resource,
        allowed: !overLimit,
        limit,
        used,
        remaining: limit == null ? null : Math.max(0, limit - used),
        overLimit,
        autoBillOverage: false,
        plan,
      };
    }

    // leads
    const limit = sub.monthly_lead_limit;
    const used = sub.leads_used_this_cycle;
    const overLimit = limit != null && used >= limit;
    const autoBillOverage = this.autoBillEnabled(sub);
    return {
      resource,
      allowed: !overLimit || autoBillOverage,
      limit,
      used,
      remaining: limit == null ? null : Math.max(0, limit - used),
      overLimit,
      autoBillOverage,
      plan,
    };
  }

  /** Convenience: whether the plan unlocks the co-broking exchange. */
  async canUseExchange(businessId: string): Promise<boolean> {
    const check = await this.checkPlanLimits(businessId, 'exchange');
    return check.allowed;
  }

  /**
   * Convenience: whether the plan unlocks CRM sync (Developer only). The
   * event-driven CRM push path is gated on this — advertised on the Developer
   * tier as "CRM sync", enforced here.
   */
  async canUseCrmSync(businessId: string): Promise<boolean> {
    const check = await this.checkPlanLimits(businessId, 'crm_sync');
    return check.allowed;
  }

  // ─────────────────────────────────────────────
  // Usage recording
  // ─────────────────────────────────────────────

  /**
   * Count one captured lead against the plan's monthly allotment. On a metered
   * plan, a lead beyond the included limit is billed as overage (₹8/lead) and
   * emits `realty.lead_limit.reached`. Unlimited plans just track the count.
   * Idempotent counters are DB-atomic (increment), so concurrent captures are safe.
   */
  async recordLeadUsage(
    businessId: string,
    now: Date = new Date(),
  ): Promise<business_subscriptions> {
    const sub = await this.getSubscription(businessId, now);
    const limit = sub.monthly_lead_limit;
    const priorUsed = sub.leads_used_this_cycle;
    const isOverage = limit != null && priorUsed >= limit;

    const updated = await this.repository.incrementUsage(businessId, 1, isOverage ? 1 : 0);

    this.emit<RealtyLeadUsageRecordedEvent>('realty.lead_usage.recorded', {
      ...this.baseEvent(businessId),
      type: 'realty.lead_usage.recorded',
      leadsUsed: updated.leads_used_this_cycle,
      monthlyLeadLimit: limit,
      overage: isOverage,
    });

    // Fire the "limit reached" alert exactly once, on the lead that hits the cap.
    if (limit != null && priorUsed < limit && updated.leads_used_this_cycle >= limit) {
      this.emit<RealtyLeadLimitReachedEvent>('realty.lead_limit.reached', {
        ...this.baseEvent(businessId),
        type: 'realty.lead_limit.reached',
        plan: sub.plan,
        monthlyLeadLimit: limit,
        leadsUsed: updated.leads_used_this_cycle,
      });
      this.logger.warn(
        `Business ${businessId} reached its ${sub.plan} lead limit (${limit}/cycle)`,
      );
    }
    return updated;
  }

  /**
   * Count every captured lead against the plan — the single source of truth for
   * usage. Fires for HTTP captures, external ingestion, and inbound auto-capture
   * alike (the `@PlanLimit` guard only pre-checks the explicit HTTP POST; this
   * listener does the accounting for all paths). Best-effort — a billing error
   * must never abort lead capture.
   */
  @OnEvent('realty.lead.created')
  async onLeadCreated(event: RealtyLeadCreatedEvent): Promise<void> {
    try {
      await this.recordLeadUsage(event.businessId);
    } catch (err) {
      this.logger.error(
        `Failed to record lead usage for business ${event.businessId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // ─────────────────────────────────────────────
  // Usage summary + upgrades
  // ─────────────────────────────────────────────

  async getUsageSummary(
    businessId: string,
    now: Date = new Date(),
  ): Promise<UsageSummary> {
    const sub = await this.getSubscription(businessId, now);
    const def = PLAN_DEFINITIONS[sub.plan];
    const seatsUsed = await this.repository.countSeats(businessId);

    return {
      plan: sub.plan,
      planLabel: def.label,
      planPricePaise: sub.plan_price_paise,
      overageRatePaise: sub.overage_rate_paise,
      monthlyLeadLimit: sub.monthly_lead_limit,
      seatLimit: sub.seat_limit,
      exchangeEnabled: def.exchangeEnabled,
      billingCycleStart: sub.billing_cycle_start,
      // The date the rollover will actually use, not a month naively added.
      // `addMonths` here would tell a tenant on a clamped February cycle that
      // it ends on 28 March while the rollover ends it on the 31st — the
      // billing page and the meter reset disagreeing by three days.
      billingCycleEnd: cycleBoundaryAfter(sub.billing_cycle_start, readAnchorDay(sub)),
      leadsUsedThisCycle: sub.leads_used_this_cycle,
      overageLeadsThisCycle: sub.overage_leads_this_cycle,
      overageChargePaise: sub.overage_leads_this_cycle * sub.overage_rate_paise,
      seatsUsed,
      meters: [
        {
          key: 'leads',
          label: 'Leads this cycle',
          used: sub.leads_used_this_cycle,
          limit: sub.monthly_lead_limit,
          unit: 'leads',
        },
        {
          key: 'seats',
          label: 'Team seats',
          used: seatsUsed,
          limit: sub.seat_limit,
          unit: 'seats',
        },
      ],
      billingHistory: this.readBillingHistory(sub),
    };
  }

  /**
   * Switch a business to `newPlan`, applying the tier's limits/price. Preserves
   * the current cycle usage (upgrading mid-cycle keeps the counter; the higher
   * limit takes effect immediately). Emits `realty.plan.changed` + writes audit.
   */
  async upgradePlan(
    businessId: string,
    newPlan: RealtyPlan,
    now: Date = new Date(),
  ): Promise<UsageSummary> {
    const sub = await this.getSubscription(businessId, now);
    const def = planDefinition(newPlan);

    if (sub.plan !== newPlan) {
      await this.repository.update(businessId, {
        plan: newPlan,
        monthlyLeadLimit: def.monthlyLeadLimit,
        seatLimit: def.seatLimit,
        planPricePaise: def.pricePaise,
      });

      this.emit<RealtyPlanChangedEvent>('realty.plan.changed', {
        ...this.baseEvent(businessId),
        type: 'realty.plan.changed',
        fromPlan: sub.plan,
        toPlan: newPlan,
      });

      await this.audit.record({
        businessId,
        actorType: 'TEAM_MEMBER',
        action: 'UPDATE',
        resourceType: 'business_subscription',
        resourceId: sub.id,
        before: { plan: sub.plan },
        after: { plan: newPlan, pricePaise: def.pricePaise },
        description: `Subscription changed ${sub.plan} → ${newPlan}`,
      });
      this.logger.log(`Business ${businessId} plan changed ${sub.plan} → ${newPlan}`);
    }

    return this.getUsageSummary(businessId, now);
  }

  // ─────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────

  /**
   * Whether a metered plan auto-bills leads beyond its limit (default) instead of
   * hard-blocking. A business can force a hard cap with `metadata.hardCap = true`.
   */
  private autoBillEnabled(sub: business_subscriptions): boolean {
    const meta = (sub.metadata ?? {}) as Record<string, unknown>;
    return meta['hardCap'] !== true;
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
}
