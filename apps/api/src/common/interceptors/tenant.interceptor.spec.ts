/**
 * TenantInterceptor unit tests.
 *
 * This interceptor is where the JWT's `businessId` becomes `request.tenantId`,
 * which `@TenantId()` reads and every repository then puts in its WHERE clause.
 * Root rule #1 rests on it, so its three branches all matter:
 *
 *  - **public route** → skip entirely. `public-route-contract.spec.ts` asserts
 *    that no `@Public()` handler takes `@TenantId()`, precisely because this
 *    branch leaves the tenant unset. That test's premise is this branch.
 *  - **no user** → throw. A protected route reaching here without a user means
 *    the interceptor was ordered before the guard; failing loudly is the only
 *    safe answer, because the alternative is an unscoped request.
 *  - **user without businessId** → warn, and *leave `tenantId` unset*. This is
 *    the case worth pinning: the interceptor deliberately does not write
 *    `undefined`, and nothing downstream should be able to mistake a missing
 *    tenant for a present one.
 */

import { CallHandler, ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, lastValueFrom } from 'rxjs';

import { IS_PUBLIC_KEY, TenantInterceptor } from './tenant.interceptor';

type TenantRequest = { user?: Record<string, unknown>; tenantId?: string };

function makeContext(request: TenantRequest): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

function makeInterceptor(isPublic: boolean | undefined): TenantInterceptor {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key: unknown) => (key === IS_PUBLIC_KEY ? isPublic : undefined) as never);
  return new TenantInterceptor(reflector);
}

const NEXT: CallHandler = { handle: () => of('handled') };

afterEach(() => jest.restoreAllMocks());

describe('TenantInterceptor on protected routes', () => {
  it('copies businessId from the JWT payload onto the request', async () => {
    const request: TenantRequest = { user: { sub: 'u-1', businessId: 'biz-1' } };

    await lastValueFrom(makeInterceptor(undefined).intercept(makeContext(request), NEXT));

    expect(request.tenantId).toBe('biz-1');
  });

  it('rejects a request that reached it with no authenticated user', async () => {
    // Only reachable if the interceptor runs before JwtAuthGuard. Continuing
    // would hand the handler an unscoped request.
    expect(() => makeInterceptor(undefined).intercept(makeContext({}), NEXT)).toThrow(
      UnauthorizedException,
    );
  });

  it('leaves tenantId unset when the payload carries no businessId', async () => {
    const request: TenantRequest = { user: { sub: 'u-1' } };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await lastValueFrom(makeInterceptor(undefined).intercept(makeContext(request), NEXT));

    // Explicitly *absent*, not `undefined`-valued: a repository that spreads
    // this into a WHERE clause must not end up with `business_id: undefined`,
    // which Prisma drops from the predicate entirely.
    expect('tenantId' in request).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('does not treat an empty-string businessId as a tenant', async () => {
    const request: TenantRequest = { user: { sub: 'u-1', businessId: '' } };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await lastValueFrom(makeInterceptor(undefined).intercept(makeContext(request), NEXT));

    expect(request.tenantId).toBeUndefined();
  });

  it('passes the handler result through', async () => {
    const request: TenantRequest = { user: { businessId: 'biz-1' } };
    await expect(
      lastValueFrom(makeInterceptor(undefined).intercept(makeContext(request), NEXT)),
    ).resolves.toBe('handled');
  });
});

describe('TenantInterceptor on public routes', () => {
  it('skips tenant extraction entirely', async () => {
    const request: TenantRequest = {};

    // No user, and no throw — this is the branch that lets webhooks work.
    await expect(
      lastValueFrom(makeInterceptor(true).intercept(makeContext(request), NEXT)),
    ).resolves.toBe('handled');
    expect(request.tenantId).toBeUndefined();
  });

  it('does not set a tenant even when a user happens to be present', async () => {
    const request: TenantRequest = { user: { businessId: 'biz-1' } };

    await lastValueFrom(makeInterceptor(true).intercept(makeContext(request), NEXT));

    expect(request.tenantId).toBeUndefined();
  });
});
