/**
 * RealtyRateLimitGuard unit tests — Phase 7.
 *
 * Covers self-gating (reads / non-realty / no-tenant pass through), quota
 * headers on success, and a 429 with Retry-After once the bucket is exhausted.
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RealtyRateLimitGuard } from './realty-rate-limit.guard';
import { RealtyRateLimiter } from './realty-rate-limiter';
import { REALTY_RATE_LIMIT_BUCKETS } from './realty-hardening.constants';

const BIZ = '00000000-0000-4000-a000-000000000001';

// Real Nest always supplies a handler function + controller class as the
// reflector metadata targets — mirror that so Reflector.getAllAndOverride works.
function handlerFn(): void {}
class DummyController {}

function makeContext(req: Record<string, unknown>, res: { setHeader: jest.Mock }) {
  return {
    getType: () => 'http',
    getHandler: () => handlerFn,
    getClass: () => DummyController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
}

describe('RealtyRateLimitGuard', () => {
  let limiter: RealtyRateLimiter;
  let guard: RealtyRateLimitGuard;
  let res: { setHeader: jest.Mock };

  beforeEach(() => {
    limiter = new RealtyRateLimiter();
    guard = new RealtyRateLimitGuard(limiter, new Reflector());
    res = { setHeader: jest.fn() };
  });

  it('passes through read (GET) requests untouched', () => {
    const ctx = makeContext({ method: 'GET', path: '/v1/realty/leads', tenantId: BIZ }, res);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('passes through non-realty routes', () => {
    const ctx = makeContext({ method: 'POST', path: '/v1/catalog/items', tenantId: BIZ }, res);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes through when no tenant context is present', () => {
    const ctx = makeContext({ method: 'POST', path: '/v1/realty/leads' }, res);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows a mutating realty request and sets quota headers', () => {
    const ctx = makeContext({ method: 'POST', path: '/v1/realty/leads', tenantId: BIZ }, res);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number));
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
  });

  it('throws 429 with Retry-After once the default bucket is exhausted', () => {
    const req = { method: 'POST', path: '/v1/realty/leads', tenantId: BIZ };
    // Pre-fill the tenant's default window to the ceiling.
    const { limit } = limiter.ruleFor('default');
    for (let i = 0; i < limit; i += 1) limiter.tryConsume(BIZ, 'default');
    let thrown: unknown;
    try {
      guard.canActivate(makeContext(req, res));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
  });

  it('honours the per-route bucket from @RealtyRateLimit metadata', () => {
    const bucket = 'ai-turn';
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(bucket);
    const g = new RealtyRateLimitGuard(limiter, reflector);
    const req = { method: 'POST', path: '/v1/realty/ai/turn', tenantId: BIZ };
    const { limit } = REALTY_RATE_LIMIT_BUCKETS[bucket]!;
    for (let i = 0; i < limit; i += 1) limiter.tryConsume(BIZ, bucket);
    expect(() => g.canActivate(makeContext(req, res))).toThrow(HttpException);
  });

  it('passes through non-HTTP contexts (WebSocket / queue) without touching the limiter', () => {
    const consume = jest.spyOn(limiter, 'tryConsume');
    const ctx = {
      getType: () => 'ws',
      getHandler: () => handlerFn,
      getClass: () => DummyController,
      switchToHttp: () => {
        throw new Error('switchToHttp must not be reached for a ws context');
      },
    } as never;

    expect(guard.canActivate(ctx)).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it('defaults a method-less request to GET, which is never throttled', () => {
    const ctx = makeContext({ path: '/v1/realty/leads', tenantId: BIZ }, res);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('falls back to req.url when Express has not populated req.path', () => {
    const ctx = makeContext({ method: 'POST', url: '/v1/realty/leads?page=1', tenantId: BIZ }, res);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number));
  });

  it('treats a request with neither path nor url as non-realty and lets it through', () => {
    const ctx = makeContext({ method: 'POST', tenantId: BIZ }, res);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('reads the tenant from the JWT user when the interceptor has not set tenantId', () => {
    const ctx = makeContext(
      { method: 'POST', path: '/v1/realty/leads', user: { businessId: BIZ } },
      res,
    );
    expect(guard.canActivate(ctx)).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number));
  });
});
