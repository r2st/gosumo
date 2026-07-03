/**
 * PlanGuard unit tests (GoSumo Realty tier enforcement, plan §9).
 *
 * Coverage:
 *  1. Pass-through — non-http context, undecorated route, no tenant context
 *  2. Tenant resolution — reads businessId from req.tenantId, falls back to req.user.businessId
 *  3. leads    → HTTP 429 (PLAN_LEAD_LIMIT_REACHED, upgrade prompt) when the allotment is spent
 *  4. seats    → HTTP 403 (PLAN_SEAT_LIMIT_REACHED) when the seat limit is reached
 *  5. exchange → HTTP 403 (PLAN_EXCHANGE_LOCKED) when the tier excludes the exchange (SOLO)
 *  6. allowed  → passes through when the limit check is satisfied
 *
 * BillingService and Reflector are mocked; the guard is exercised directly.
 */

import { ExecutionContext, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RealtyPlan } from '@prisma/client';

import { PlanGuard } from './plan.guard';
import { BillingService, LimitCheck } from './billing.service';
import { PLAN_LIMIT_RESOURCE } from './plan.decorator';
import { PlanResource } from './billing.constants';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';

/** Build a mock ExecutionContext of the given type carrying an optional request. */
function makeContext(
  type: 'http' | 'ws',
  request: Record<string, unknown> = {},
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeCheck(overrides: Partial<LimitCheck> = {}): LimitCheck {
  return {
    resource: 'leads',
    allowed: true,
    limit: 300,
    used: 300,
    remaining: 0,
    overLimit: true,
    autoBillOverage: false,
    plan: RealtyPlan.SOLO,
    ...overrides,
  };
}

describe('PlanGuard', () => {
  let guard: PlanGuard;
  let billing: jest.Mocked<Pick<BillingService, 'checkPlanLimits'>>;
  let reflector: jest.Mocked<Pick<Reflector, 'getAllAndOverride'>>;

  beforeEach(() => {
    billing = { checkPlanLimits: jest.fn() };
    reflector = { getAllAndOverride: jest.fn() };
    guard = new PlanGuard(billing as unknown as BillingService, reflector as unknown as Reflector);
  });

  // ── Pass-through ──
  it('passes through a non-http (e.g. websocket) context', async () => {
    const ctx = makeContext('ws');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(billing.checkPlanLimits).not.toHaveBeenCalled();
  });

  it('passes through a route without the @PlanLimit decorator', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = makeContext('http', { tenantId: BUSINESS_ID });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(billing.checkPlanLimits).not.toHaveBeenCalled();
  });

  it('passes through (defers to auth) when there is no tenant context yet', async () => {
    reflector.getAllAndOverride.mockReturnValue('leads' as PlanResource);
    const ctx = makeContext('http', {});

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(billing.checkPlanLimits).not.toHaveBeenCalled();
  });

  it('reads the decorator metadata from handler + class', async () => {
    reflector.getAllAndOverride.mockReturnValue('leads' as PlanResource);
    billing.checkPlanLimits.mockResolvedValue(makeCheck({ allowed: true }));

    await guard.canActivate(makeContext('http', { tenantId: BUSINESS_ID }));

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      PLAN_LIMIT_RESOURCE,
      expect.any(Array),
    );
  });

  // ── Tenant resolution ──
  it('resolves the businessId from req.tenantId', async () => {
    reflector.getAllAndOverride.mockReturnValue('leads' as PlanResource);
    billing.checkPlanLimits.mockResolvedValue(makeCheck({ allowed: true }));

    await guard.canActivate(makeContext('http', { tenantId: BUSINESS_ID }));

    expect(billing.checkPlanLimits).toHaveBeenCalledWith(BUSINESS_ID, 'leads');
  });

  it('falls back to req.user.businessId when tenantId is unset', async () => {
    reflector.getAllAndOverride.mockReturnValue('leads' as PlanResource);
    billing.checkPlanLimits.mockResolvedValue(makeCheck({ allowed: true }));

    await guard.canActivate(makeContext('http', { user: { businessId: BUSINESS_ID } }));

    expect(billing.checkPlanLimits).toHaveBeenCalledWith(BUSINESS_ID, 'leads');
  });

  // ── Allowed ──
  it('allows the request when the limit check passes', async () => {
    reflector.getAllAndOverride.mockReturnValue('leads' as PlanResource);
    billing.checkPlanLimits.mockResolvedValue(makeCheck({ allowed: true }));

    await expect(
      guard.canActivate(makeContext('http', { tenantId: BUSINESS_ID })),
    ).resolves.toBe(true);
  });

  // ── leads → 429 ──
  describe('leads limit', () => {
    it('throws 429 with an upgrade prompt when the lead allotment is spent', async () => {
      reflector.getAllAndOverride.mockReturnValue('leads' as PlanResource);
      billing.checkPlanLimits.mockResolvedValue(
        makeCheck({ resource: 'leads', allowed: false, limit: 300, used: 300, plan: RealtyPlan.SOLO }),
      );

      const ctx = makeContext('http', { tenantId: BUSINESS_ID });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(HttpException);

      try {
        await guard.canActivate(ctx);
      } catch (err) {
        const e = err as HttpException;
        expect(e.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        const body = e.getResponse() as Record<string, unknown>;
        expect(body).toMatchObject({
          code: 'PLAN_LEAD_LIMIT_REACHED',
          plan: RealtyPlan.SOLO,
          limit: 300,
          used: 300,
          upgrade: true,
        });
        expect(String(body['message'])).toContain('Solo');
      }
    });
  });

  // ── seats → 403 ──
  describe('seat limit', () => {
    it('throws 403 when the seat limit is reached', async () => {
      reflector.getAllAndOverride.mockReturnValue('seats' as PlanResource);
      billing.checkPlanLimits.mockResolvedValue(
        makeCheck({ resource: 'seats', allowed: false, limit: 1, used: 1, plan: RealtyPlan.SOLO }),
      );

      const ctx = makeContext('http', { tenantId: BUSINESS_ID });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);

      try {
        await guard.canActivate(ctx);
      } catch (err) {
        const body = (err as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(body).toMatchObject({
          code: 'PLAN_SEAT_LIMIT_REACHED',
          plan: RealtyPlan.SOLO,
          limit: 1,
          used: 1,
          upgrade: true,
        });
      }
    });
  });

  // ── exchange → 403 ──
  describe('exchange gating', () => {
    it('throws 403 (PLAN_EXCHANGE_LOCKED) when the tier excludes the exchange (SOLO)', async () => {
      reflector.getAllAndOverride.mockReturnValue('exchange' as PlanResource);
      billing.checkPlanLimits.mockResolvedValue(
        makeCheck({
          resource: 'exchange',
          allowed: false,
          limit: null,
          remaining: null,
          overLimit: false,
          plan: RealtyPlan.SOLO,
        }),
      );

      const ctx = makeContext('http', { tenantId: BUSINESS_ID });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);

      try {
        await guard.canActivate(ctx);
      } catch (err) {
        const body = (err as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(body).toMatchObject({
          code: 'PLAN_EXCHANGE_LOCKED',
          plan: RealtyPlan.SOLO,
          upgrade: true,
        });
        expect(String(body['message'])).toContain('Team or Developer');
      }
    });

    it('allows the exchange when the tier includes it (TEAM)', async () => {
      reflector.getAllAndOverride.mockReturnValue('exchange' as PlanResource);
      billing.checkPlanLimits.mockResolvedValue(
        makeCheck({ resource: 'exchange', allowed: true, plan: RealtyPlan.TEAM }),
      );

      await expect(
        guard.canActivate(makeContext('http', { tenantId: BUSINESS_ID })),
      ).resolves.toBe(true);
    });
  });
});
