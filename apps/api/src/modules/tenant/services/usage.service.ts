import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantRepository } from '../tenant.repository';
import {
  UsageMetric,
  RESOURCE_METRICS,
  MONTHLY_METRICS,
  resolvePlan,
  limitForMetric,
  isUnlimited,
  usagePeriodKey,
  PlanDefinition,
} from '../tenant.constants';
import {
  UsageMetricStatus,
  UsageSnapshotResponse,
} from '../dto/usage.dto';

/**
 * Thrown when an action would exceed a plan quota. Maps to HTTP 402
 * (Payment Required) — the tenant must upgrade to proceed.
 */
export class QuotaExceededException extends HttpException {
  constructor(metric: UsageMetric, limit: number) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'PLAN_LIMIT_EXCEEDED',
        message: `Quota exceeded for "${metric}". Plan limit is ${limit}. Upgrade your plan to continue.`,
        metric,
        limit,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * UsageService — usage tracking and quota enforcement.
 *
 * Two kinds of quota are enforced:
 *  - **Resource** quotas (channels, team members) — measured from live row
 *    counts in the database.
 *  - **Monthly** quotas (conversations, campaigns, AI responses) — measured
 *    from rolling per-month counters stored in `businesses.profile.usage`,
 *    bucketed by `YYYY-MM` period key.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(private readonly repository: TenantRepository) {}

  // ─────────────────────────────────────────────
  // Snapshot
  // ─────────────────────────────────────────────

  /**
   * Return a full usage snapshot for a business: every metric with its current
   * usage, plan limit, remaining headroom, and percentage used.
   */
  async getUsage(businessId: string, now: Date = new Date()): Promise<UsageSnapshotResponse> {
    const business = await this.getBusinessOrThrow(businessId);
    const plan = resolvePlan(business.plan);
    const period = usagePeriodKey(now);

    const resourceCounts = await this.loadResourceCounts(businessId);
    const monthlyCounts = this.readMonthlyCounters(business.profile, period);

    const metrics: UsageMetricStatus[] = [];
    for (const metric of [...RESOURCE_METRICS, ...MONTHLY_METRICS]) {
      const used = RESOURCE_METRICS.includes(metric)
        ? resourceCounts[metric] ?? 0
        : monthlyCounts[metric] ?? 0;
      metrics.push(this.buildMetricStatus(plan, metric, used));
    }

    return { plan: business.plan, period, metrics };
  }

  // ─────────────────────────────────────────────
  // Quota enforcement
  // ─────────────────────────────────────────────

  /**
   * Assert that `requested` additional units of `metric` fit within the plan
   * quota. Throws {@link QuotaExceededException} (HTTP 402) otherwise.
   */
  async assertWithinQuota(
    businessId: string,
    metric: UsageMetric,
    requested = 1,
    now: Date = new Date(),
  ): Promise<void> {
    const business = await this.getBusinessOrThrow(businessId);
    const plan = resolvePlan(business.plan);
    const limit = limitForMetric(plan, metric);

    if (isUnlimited(limit)) {
      return;
    }

    const used = await this.currentUsage(businessId, business.profile, metric, now);
    if (used + requested > limit) {
      throw new QuotaExceededException(metric, limit);
    }
  }

  /**
   * Convenience boolean check — true when the action fits within quota.
   */
  async hasQuota(
    businessId: string,
    metric: UsageMetric,
    requested = 1,
    now: Date = new Date(),
  ): Promise<boolean> {
    try {
      await this.assertWithinQuota(businessId, metric, requested, now);
      return true;
    } catch (err) {
      if (err instanceof QuotaExceededException) {
        return false;
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // Recording (monthly metrics only)
  // ─────────────────────────────────────────────

  /**
   * Increment a monthly usage counter for the current period.
   * Resource metrics (channels, team members) are derived from row counts and
   * cannot be recorded directly — passing one throws BadRequestException.
   *
   * @returns the new counter value for the metric this period.
   */
  async incrementUsage(
    businessId: string,
    metric: UsageMetric,
    amount = 1,
    now: Date = new Date(),
  ): Promise<number> {
    if (!MONTHLY_METRICS.includes(metric)) {
      throw new BadRequestException(
        `Metric "${metric}" is a resource quota derived from row counts and cannot be recorded directly`,
      );
    }
    if (amount <= 0) {
      throw new BadRequestException('Usage increment amount must be positive');
    }

    const business = await this.getBusinessOrThrow(businessId);
    const period = usagePeriodKey(now);
    const profile = this.toRecord(business.profile);
    const usage = this.toRecord(profile['usage']);
    const bucket = this.toRecord(usage[period]);

    const current = typeof bucket[metric] === 'number' ? (bucket[metric] as number) : 0;
    const next = current + amount;
    bucket[metric] = next;
    usage[period] = bucket;
    profile['usage'] = usage;

    await this.repository.updateBusiness(businessId, {
      profile: profile as Prisma.InputJsonValue,
    });

    this.logger.debug(
      `Usage recorded for ${businessId}: ${metric} +${amount} → ${next} (${period})`,
    );

    return next;
  }

  /**
   * Reset all monthly counters for a business's current period (e.g. on plan
   * change or for testing). Resource counts are unaffected.
   */
  async resetMonthlyUsage(businessId: string, now: Date = new Date()): Promise<void> {
    const business = await this.getBusinessOrThrow(businessId);
    const period = usagePeriodKey(now);
    const profile = this.toRecord(business.profile);
    const usage = this.toRecord(profile['usage']);

    delete usage[period];
    profile['usage'] = usage;

    await this.repository.updateBusiness(businessId, {
      profile: profile as Prisma.InputJsonValue,
    });

    this.logger.log(`Monthly usage reset for ${businessId} (${period})`);
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  private async getBusinessOrThrow(businessId: string) {
    const business = await this.repository.findBusinessById(businessId);
    if (!business) {
      throw new NotFoundException(`Business not found: ${businessId}`);
    }
    return business;
  }

  private async currentUsage(
    businessId: string,
    profile: unknown,
    metric: UsageMetric,
    now: Date,
  ): Promise<number> {
    if (RESOURCE_METRICS.includes(metric)) {
      const counts = await this.loadResourceCounts(businessId);
      return counts[metric] ?? 0;
    }
    const counters = this.readMonthlyCounters(profile, usagePeriodKey(now));
    return counters[metric] ?? 0;
  }

  private async loadResourceCounts(
    businessId: string,
  ): Promise<Partial<Record<UsageMetric, number>>> {
    const [channels, members] = await Promise.all([
      this.repository.countChannelAccounts(businessId),
      this.repository.countTeamMembers(businessId),
    ]);
    return {
      [UsageMetric.CHANNELS]: channels,
      [UsageMetric.TEAM_MEMBERS]: members,
    };
  }

  private readMonthlyCounters(
    profile: unknown,
    period: string,
  ): Partial<Record<UsageMetric, number>> {
    const usage = this.toRecord(this.toRecord(profile)['usage']);
    const bucket = this.toRecord(usage[period]);
    const result: Partial<Record<UsageMetric, number>> = {};
    for (const metric of MONTHLY_METRICS) {
      if (typeof bucket[metric] === 'number') {
        result[metric] = bucket[metric] as number;
      }
    }
    return result;
  }

  private buildMetricStatus(
    plan: PlanDefinition,
    metric: UsageMetric,
    used: number,
  ): UsageMetricStatus {
    const limit = limitForMetric(plan, metric);
    if (isUnlimited(limit)) {
      return { metric, used, limit, remaining: null, percentUsed: 0, overLimit: false };
    }
    const remaining = Math.max(0, limit - used);
    const percentUsed = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
    return { metric, used, limit, remaining, percentUsed, overLimit: used >= limit };
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  }
}
