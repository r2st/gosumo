import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantRateLimitGuard } from './tenant-rate-limit.guard';
import { TenantRateLimiter } from './tenant-rate-limiter.service';
import { TENANT_RATE_LIMIT_BUCKETS } from './tenant-rate-limit.constants';

const BUCKET = 'export';
const RULE = TENANT_RATE_LIMIT_BUCKETS[BUCKET]!;

interface Harness {
  guard: TenantRateLimitGuard;
  limiter: TenantRateLimiter;
  headers: Record<string, unknown>;
  context: (overrides?: {
    bucket?: string | undefined;
    tenantId?: string;
    userBusinessId?: string;
    type?: string;
  }) => ExecutionContext;
}

function makeHarness(): Harness {
  const limiter = new TenantRateLimiter();
  const headers: Record<string, unknown> = {};
  const reflector = {
    getAllAndOverride: jest.fn(),
  } as unknown as Reflector;
  const guard = new TenantRateLimitGuard(limiter, reflector);

  // `undefined` is a meaningful value for two of these ("no bucket on the
  // route", "no tenant on the request"), so absence is tested with `in` rather
  // than a destructuring default — a default would silently replace the very
  // thing those cases are about.
  const context = (overrides: {
    bucket?: string | undefined;
    tenantId?: string;
    userBusinessId?: string | undefined;
    type?: string;
  } = {}) => {
    const bucket = 'bucket' in overrides ? overrides.bucket : BUCKET;
    const userBusinessId = 'userBusinessId' in overrides ? overrides.userBusinessId : 'b1';
    const { tenantId, type = 'http' } = overrides;
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(bucket);
    return {
      getType: () => type,
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ tenantId, user: { businessId: userBusinessId } }),
        getResponse: () => ({
          setHeader: (name: string, value: unknown) => {
            headers[name] = value;
          },
        }),
      }),
    } as unknown as ExecutionContext;
  };

  return { guard, limiter, headers, context };
}

describe('TenantRateLimitGuard', () => {
  it('admits a request under the ceiling', () => {
    const h = makeHarness();

    expect(h.guard.canActivate(h.context())).toBe(true);
  });

  it('publishes the quota on every admitted request', () => {
    const h = makeHarness();

    h.guard.canActivate(h.context());

    expect(h.headers['X-RateLimit-Limit']).toBe(RULE.limit);
    expect(h.headers['X-RateLimit-Remaining']).toBe(RULE.limit - 1);
    // Seconds, matching Retry-After's unit — a client should not have to
    // handle two time bases in one response.
    expect(h.headers['X-RateLimit-Reset']).toBeGreaterThan(Date.now() / 1000);
  });

  it('throws 429 with Retry-After once the ceiling is reached', () => {
    const h = makeHarness();
    for (let i = 0; i < RULE.limit; i++) h.guard.canActivate(h.context());

    let thrown: HttpException | undefined;
    try {
      h.guard.canActivate(h.context());
    } catch (err) {
      thrown = err as HttpException;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(h.headers['Retry-After']).toBeGreaterThan(0);
  });

  it('names the resource, never the tenant or the bucket key', () => {
    // The caller needs to know which of their own behaviours to slow down.
    // That is the entire disclosure budget: no tenant id, no internal bucket
    // name, and nothing about anybody else's usage.
    // A bucket whose key is not a substring of its own description, so the
    // leak assertion below means something.
    const bucket = 'knowledge-ingest';
    const rule = TENANT_RATE_LIMIT_BUCKETS[bucket]!;
    const h = makeHarness();
    for (let i = 0; i < rule.limit; i++) h.guard.canActivate(h.context({ bucket }));

    let body = '';
    try {
      h.guard.canActivate(h.context({ bucket }));
    } catch (err) {
      body = JSON.stringify((err as HttpException).getResponse());
    }

    expect(body).toContain(rule.description);
    expect(body).not.toContain('b1');
    expect(body).not.toContain(bucket);
  });

  it('never reports Retry-After: 0, which clients read as "immediately"', () => {
    const h = makeHarness();
    for (let i = 0; i < RULE.limit; i++) h.guard.canActivate(h.context());
    // A breach arriving in the window's final milliseconds rounds to zero
    // seconds, and a client that retries at once is refused again.
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(h.limiter.peek('b1', BUCKET).resetAt - 1);

    try {
      h.guard.canActivate(h.context());
    } catch {
      /* expected */
    }

    expect(h.headers['Retry-After']).toBeGreaterThanOrEqual(1);
    jest.restoreAllMocks();
  });

  describe('routes it must not touch', () => {
    it('passes through a route with no bucket, without consuming quota', () => {
      // Global but opt-in: adding this guard to the chain cannot change the
      // outcome of a route that has not asked for a ceiling.
      const h = makeHarness();

      expect(h.guard.canActivate(h.context({ bucket: undefined }))).toBe(true);
      expect(h.limiter.trackedWindows()).toBe(0);
      expect(h.headers['X-RateLimit-Limit']).toBeUndefined();
    });

    it('passes through a non-HTTP context', () => {
      const h = makeHarness();

      expect(h.guard.canActivate(h.context({ type: 'ws' }))).toBe(true);
    });

    it('passes through when there is no tenant to charge', () => {
      // Either the route is @Public() — the auth throttle's job, not ours — or
      // authentication is about to reject it. Charging anyway would put every
      // unauthenticated request in one window, which is a lockout an anonymous
      // caller could inflict on a real tenant.
      const h = makeHarness();

      expect(h.guard.canActivate(h.context({ userBusinessId: undefined }))).toBe(true);
      expect(h.limiter.trackedWindows()).toBe(0);
    });
  });

  describe('an unknown bucket', () => {
    it('admits the request', () => {
      const h = makeHarness();

      expect(h.guard.canActivate(h.context({ bucket: 'typo' }))).toBe(true);
    });

    it('sets no quota headers, rather than advertising a limit of zero', () => {
      // `X-RateLimit-Limit: 0` would have well-behaved clients back off
      // against a quota nobody is enforcing.
      const h = makeHarness();

      h.guard.canActivate(h.context({ bucket: 'typo' }));

      expect(h.headers['X-RateLimit-Limit']).toBeUndefined();
      expect(h.headers['X-RateLimit-Remaining']).toBeUndefined();
    });
  });

  it('prefers an explicit tenantId over the token claim', () => {
    const h = makeHarness();

    for (let i = 0; i < RULE.limit; i++) {
      h.guard.canActivate(h.context({ tenantId: 'explicit', userBusinessId: 'b1' }));
    }

    // The window was charged to `explicit`, not `b1`.
    expect(h.limiter.peek('explicit', BUCKET).remaining).toBe(0);
    expect(h.limiter.peek('b1', BUCKET).remaining).toBe(RULE.limit);
  });
});
