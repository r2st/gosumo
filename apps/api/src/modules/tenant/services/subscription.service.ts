import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { AuditAction } from '@gosumo/database';
import { AuditActor, AuditLogService } from '../../../common/services/audit-log.service';
import { TenantRepository } from '../tenant.repository';
import {
  PLAN_CATALOG,
  SubscriptionTier,
  resolvePlan,
  isUnlimited,
  PlanDefinition,
} from '../tenant.constants';
import {
  ChangePlanDto,
  SubscriptionResponse,
  PlanCatalogEntry,
} from '../dto/change-plan.dto';

/**
 * SubscriptionService — manages a business's subscription tier.
 *
 * Owns the plan catalog, exposes the current subscription, and handles
 * upgrades/downgrades. Downgrades are validated against live resource usage so
 * a business can never drop to a tier it already exceeds.
 */
/** `audit_logs.resource_type` for tier changes on `businesses.plan`. */
export const SUBSCRIPTION_RESOURCE = 'business_subscription';

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly repository: TenantRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * The full plan catalog, for plan-picker UIs.
   */
  getPlanCatalog(): PlanCatalogEntry[] {
    return Object.values(PLAN_CATALOG);
  }

  /**
   * The current subscription for a business.
   */
  async getSubscription(businessId: string): Promise<SubscriptionResponse> {
    const business = await this.getBusinessOrThrow(businessId);
    return this.toResponse(resolvePlan(business.plan), business.is_active);
  }

  /**
   * Change a business's subscription tier.
   *
   * Upgrades apply immediately. Downgrades are rejected if current usage of any
   * resource (channels, team members) exceeds the target plan's limits.
   * Emits `business.plan.changed`.
   */
  async changePlan(
    businessId: string,
    dto: ChangePlanDto,
    actor?: AuditActor,
  ): Promise<SubscriptionResponse> {
    const business = await this.getBusinessOrThrow(businessId);
    const target = PLAN_CATALOG[dto.plan];
    const fromPlan = business.plan;

    if (resolvePlan(fromPlan).id === target.id) {
      // No-op change — return the current subscription unchanged.
      return this.toResponse(target, business.is_active);
    }

    await this.assertDowngradeFits(businessId, target);

    await this.repository.updateBusiness(businessId, {
      plan: target.id,
      plan_limits: target.limits as unknown as Prisma.InputJsonValue,
    });

    this.eventEmitter.emit('business.plan.changed', {
      businessId,
      fromPlan,
      toPlan: target.id,
      reason: dto.reason,
      timestamp: new Date().toISOString(),
    });

    // `businesses.plan` is one mutable column; the billing route that changes
    // the realty subscription is audited and this alias was not.
    await this.audit.record({
      businessId,
      actorType: actor ? 'TEAM_MEMBER' : 'SYSTEM',
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? null,
      action: AuditAction.UPDATE,
      resourceType: SUBSCRIPTION_RESOURCE,
      resourceId: businessId,
      before: { plan: fromPlan },
      after: { plan: target.id, limits: target.limits, reason: dto.reason ?? null },
      description: `Subscription changed ${fromPlan} → ${target.id}`,
    });

    this.logger.log(
      `Business ${businessId} plan changed: ${fromPlan} → ${target.id}`,
    );

    return this.toResponse(target, business.is_active);
  }

  // ─────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────

  /**
   * Reject a downgrade when live resource usage would breach the target plan.
   */
  private async assertDowngradeFits(
    businessId: string,
    target: PlanDefinition,
  ): Promise<void> {
    const [channels, members] = await Promise.all([
      this.repository.countChannelAccounts(businessId),
      this.repository.countTeamMembers(businessId),
    ]);

    const violations: string[] = [];
    if (!isUnlimited(target.limits.maxChannels) && channels > target.limits.maxChannels) {
      violations.push(
        `${channels} channels connected exceeds the ${target.name} limit of ${target.limits.maxChannels}`,
      );
    }
    if (!isUnlimited(target.limits.maxTeamMembers) && members > target.limits.maxTeamMembers) {
      violations.push(
        `${members} team members exceeds the ${target.name} limit of ${target.limits.maxTeamMembers}`,
      );
    }

    if (violations.length > 0) {
      throw new BadRequestException(
        `Cannot switch to ${target.name}: ${violations.join('; ')}. ` +
          `Remove resources before downgrading.`,
      );
    }
  }

  private async getBusinessOrThrow(businessId: string) {
    const business = await this.repository.findBusinessById(businessId);
    if (!business) {
      throw new NotFoundException(`Business not found: ${businessId}`);
    }
    return business;
  }

  private toResponse(plan: PlanDefinition, isActive: boolean): SubscriptionResponse {
    return {
      plan: plan.id as SubscriptionTier,
      name: plan.name,
      pricePaise: plan.pricePaise,
      limits: plan.limits,
      features: [...plan.features],
      isActive,
    };
  }
}
