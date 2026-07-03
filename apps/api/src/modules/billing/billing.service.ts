import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { RealtyPlan } from '@prisma/client';
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
    let cycleStart = sub.billing_cycle_start;
    let advanced = false;
    while (addMonths(cycleStart, 1).getTime() <= now.getTime()) {
      cycleStart = addMonths(cycleStart, 1);
      advanced = true;
    }
    if (!advanced) return sub;

    this.logger.log(
      `Billing cycle rolled over for business ${sub.business_id} → ${cycleStart.toISOString()}`,
    );
    return this.repository.update(sub.business_id, {
      billingCycleStart: cycleStart,
      leadsUsedThisCycle: 0,
      overageLeadsThisCycle: 0,
    });
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

    if (resource === 'exchange') {
      const enabled = PLAN_DEFINITIONS[plan].exchangeEnabled;
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
      billingCycleEnd: addMonths(sub.billing_cycle_start, 1),
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
