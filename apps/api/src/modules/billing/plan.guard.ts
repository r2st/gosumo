import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { BillingService } from './billing.service';
import { PLAN_LIMIT_RESOURCE } from './plan.decorator';
import { PLAN_DEFINITIONS, PlanResource } from './billing.constants';

interface TenantRequest extends Request {
  tenantId?: string;
  user?: { businessId?: string };
}

/**
 * PlanGuard — enforces subscription-tier limits on routes decorated with
 * `@PlanLimit()` (business plan §9). Registered globally; routes without the
 * decorator pass through untouched.
 *
 *  - `leads`    → HTTP 429 + upgrade prompt when the monthly allotment is spent
 *                 (unless the plan auto-bills overage, in which case it passes).
 *  - `seats`    → HTTP 403 when the seat limit is reached.
 *  - `exchange` → HTTP 403 when the tier excludes the exchange (SOLO).
 *
 * Guards run before the tenant interceptor, so the business id is read from the
 * JWT (`req.user.businessId`), falling back to `req.tenantId` when already set.
 */
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly billing: BillingService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const resource = this.reflector.getAllAndOverride<PlanResource | undefined>(
      PLAN_LIMIT_RESOURCE,
      [context.getHandler(), context.getClass()],
    );
    if (!resource) return true;

    const req = context.switchToHttp().getRequest<TenantRequest>();
    const businessId = req.tenantId ?? req.user?.businessId;
    // No tenant context yet — let the auth layer reject it (401), not us.
    if (!businessId) return true;

    const check = await this.billing.checkPlanLimits(businessId, resource);
    if (check.allowed) return true;

    if (resource === 'leads') {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          code: 'PLAN_LEAD_LIMIT_REACHED',
          message: `You've used all ${check.limit} leads on the ${planLabel(check.plan)} plan this cycle. Upgrade your plan to capture more leads.`,
          plan: check.plan,
          limit: check.limit,
          used: check.used,
          upgrade: true,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (resource === 'seats') {
      throw new ForbiddenException({
        code: 'PLAN_SEAT_LIMIT_REACHED',
        message: `The ${planLabel(check.plan)} plan includes ${check.limit} seat(s). Upgrade your plan to add more team members.`,
        plan: check.plan,
        limit: check.limit,
        used: check.used,
        upgrade: true,
      });
    }

    if (resource === 'crm_sync') {
      throw new ForbiddenException({
        code: 'PLAN_CRM_SYNC_LOCKED',
        message: `CRM sync is not available on the ${planLabel(check.plan)} plan. Upgrade to Developer to push leads to Sell.Do, LeadSquared, or Privyr.`,
        plan: check.plan,
        upgrade: true,
      });
    }

    // exchange
    throw new ForbiddenException({
      code: 'PLAN_EXCHANGE_LOCKED',
      message: `The co-broking exchange is not available on the ${planLabel(check.plan)} plan. Upgrade to Team or Developer to unlock it.`,
      plan: check.plan,
      upgrade: true,
    });
  }
}

function planLabel(plan: PlanGuardPlan): string {
  return PLAN_DEFINITIONS[plan]?.label ?? plan;
}

type PlanGuardPlan = keyof typeof PLAN_DEFINITIONS;
