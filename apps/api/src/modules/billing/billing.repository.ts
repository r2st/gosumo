import { Injectable } from '@nestjs/common';
import { Prisma, RealtyPlan } from '@prisma/client';
import type { business_subscriptions } from '@prisma/client';
import { PrismaService } from '../../common/services/prisma.service';

/** Fields settable when creating a subscription row. */
export interface CreateSubscriptionData {
  businessId: string;
  plan: RealtyPlan;
  monthlyLeadLimit: number | null;
  seatLimit: number | null;
  planPricePaise: number;
  overageRatePaise: number;
  billingCycleStart: Date;
}

/** Partial subscription update — only provided fields are written. */
export interface UpdateSubscriptionData {
  plan?: RealtyPlan;
  monthlyLeadLimit?: number | null;
  seatLimit?: number | null;
  planPricePaise?: number;
  overageRatePaise?: number;
  billingCycleStart?: Date;
  leadsUsedThisCycle?: number;
  overageLeadsThisCycle?: number;
  metadata?: Prisma.InputJsonValue;
}

/**
 * BillingRepository — all Prisma access for the `business_subscriptions` table.
 * Every query is scoped by business_id (one subscription row per business).
 */
@Injectable()
export class BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByBusiness(businessId: string): Promise<business_subscriptions | null> {
    return this.prisma.business_subscriptions.findUnique({
      where: { business_id: businessId },
    });
  }

  async create(data: CreateSubscriptionData): Promise<business_subscriptions> {
    return this.prisma.business_subscriptions.create({
      data: {
        business_id: data.businessId,
        plan: data.plan,
        monthly_lead_limit: data.monthlyLeadLimit,
        seat_limit: data.seatLimit,
        plan_price_paise: data.planPricePaise,
        overage_rate_paise: data.overageRatePaise,
        billing_cycle_start: data.billingCycleStart,
      },
    });
  }

  async update(
    businessId: string,
    data: UpdateSubscriptionData,
  ): Promise<business_subscriptions> {
    const d: Prisma.business_subscriptionsUpdateInput = {};
    if (data.plan !== undefined) d.plan = data.plan;
    if (data.monthlyLeadLimit !== undefined) d.monthly_lead_limit = data.monthlyLeadLimit;
    if (data.seatLimit !== undefined) d.seat_limit = data.seatLimit;
    if (data.planPricePaise !== undefined) d.plan_price_paise = data.planPricePaise;
    if (data.overageRatePaise !== undefined) d.overage_rate_paise = data.overageRatePaise;
    if (data.billingCycleStart !== undefined) d.billing_cycle_start = data.billingCycleStart;
    if (data.leadsUsedThisCycle !== undefined) d.leads_used_this_cycle = data.leadsUsedThisCycle;
    if (data.overageLeadsThisCycle !== undefined) {
      d.overage_leads_this_cycle = data.overageLeadsThisCycle;
    }
    if (data.metadata !== undefined) d.metadata = data.metadata;

    return this.prisma.business_subscriptions.update({
      where: { business_id: businessId },
      data: d,
    });
  }

  /**
   * Claim the rollover of one billing cycle, and report whether *this* call is
   * the one that made it.
   *
   * `billing_cycle_start` is both the predicate and the thing being written, so
   * the row can only be rolled forward from the exact cycle the caller read.
   * Every billing read rolls the cycle over if it has elapsed — the lead-usage
   * path included, and that one runs once per captured lead from an event
   * handler — so at the moment a cycle ends, every concurrent caller sees it
   * elapsed and, deciding from the row it read, every one of them rolls it.
   *
   * Each of those writes also appends a closing snapshot built from the counters
   * *it* read, which are the pre-reset ones for all of them. The result is the
   * same cycle recorded as owed two or three times over, in the one record that
   * survives the counters being zeroed.
   *
   * Under READ COMMITTED the losers block on the row lock, re-evaluate against
   * the winner's `billing_cycle_start`, and match nothing.
   */
  async claimCycleRollover(
    businessId: string,
    fromCycleStart: Date,
    data: UpdateSubscriptionData,
  ): Promise<{ subscription: business_subscriptions | null; claimed: boolean }> {
    const d: Prisma.business_subscriptionsUpdateManyMutationInput = {};
    if (data.billingCycleStart !== undefined) d.billing_cycle_start = data.billingCycleStart;
    if (data.leadsUsedThisCycle !== undefined) d.leads_used_this_cycle = data.leadsUsedThisCycle;
    if (data.overageLeadsThisCycle !== undefined) {
      d.overage_leads_this_cycle = data.overageLeadsThisCycle;
    }
    if (data.metadata !== undefined) d.metadata = data.metadata;

    const result = await this.prisma.business_subscriptions.updateMany({
      where: { business_id: businessId, billing_cycle_start: fromCycleStart },
      data: d,
    });

    const subscription = await this.findByBusiness(businessId);
    return { subscription, claimed: result.count > 0 };
  }

  /**
   * Atomically increment the cycle lead counters. Returns the updated row so the
   * caller can read the post-increment usage without a race.
   */
  async incrementUsage(
    businessId: string,
    leadDelta: number,
    overageDelta: number,
  ): Promise<business_subscriptions> {
    return this.prisma.business_subscriptions.update({
      where: { business_id: businessId },
      data: {
        leads_used_this_cycle: { increment: leadDelta },
        overage_leads_this_cycle: { increment: overageDelta },
      },
    });
  }

  /** Count active (non-deleted) team members — the live seat count for a business. */
  async countSeats(businessId: string): Promise<number> {
    return this.prisma.team_members.count({
      where: { business_id: businessId, deleted_at: null },
    });
  }
}
