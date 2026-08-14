/**
 * AuthThrottleGuard unit tests.
 *
 * Covers the self-gating that makes a global guard safe (no bucket → no work),
 * the quota headers, the 429 shape, and the two details that carry security
 * weight: the subject key is read from the body before ValidationPipe runs,
 * and the 429 body must not say which dimension was hit.
 */

import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthThrottleGuard } from './auth-throttle.guard';
import { AuthThrottleLimiter } from './auth-throttle.limiter';
import { AuthThrottle } from './auth-throttle.decorator';
import { AUTH_THROTTLE_BUCKETS } from './auth-throttle.constants';

const IP = '203.0.113.7';

class UndecoratedController {
  handler(): void {}
}

/**
 * Nest resolves the bucket off the handler function and the controller class,
 * so the fake context has to present both — and the metadata has to be set the
 * way the real decorator sets it.
 */
function contextFor(
  bucket: string | undefined,
  req: Record<string, unknown>,
  res: { setHeader: jest.Mock },
) {
  const handler = function decorated(): void {};
  // Apply the real decorator rather than writing metadata by hand, so a change
  // to how `@AuthThrottle` stores its bucket fails here too.
  if (bucket) {
    AuthThrottle(bucket)(UndecoratedController.prototype, 'handler', {
      value: handler,
    } as PropertyDescriptor);
  }

  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => UndecoratedController,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as never;
}

describe('AuthThrottleGuard', () => {
  let limiter: AuthThrottleLimiter;
  let guard: AuthThrottleGuard;
  let res: { setHeader: jest.Mock };

  beforeEach(() => {
    limiter = new AuthThrottleLimiter();
    guard = new AuthThrottleGuard(limiter, new Reflector());
    res = { setHeader: jest.fn() };
  });

  describe('self-gating', () => {
    it('passes a route with no @AuthThrottle through untouched', () => {
      // This is what makes a global guard safe: every authenticated route in
      // the API hits this branch and never reaches the limiter.
      const spy = jest.spyOn(limiter, 'consume');
      const ctx = contextFor(undefined, { headers: {}, ip: IP }, res);

      expect(guard.canActivate(ctx)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
    });

    it('ignores non-HTTP execution contexts', () => {
      const ctx = {
        getType: () => 'ws',
        getHandler: () => undefined,
        getClass: () => undefined,
      } as never;
      expect(guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('allowed requests', () => {
    it('admits the request and publishes the quota headers', () => {
      const ctx = contextFor('register', { headers: {}, ip: IP }, res);

      expect(guard.canActivate(ctx)).toBe(true);
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Limit',
        AUTH_THROTTLE_BUCKETS['register']!.ip.limit,
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Remaining',
        AUTH_THROTTLE_BUCKETS['register']!.ip.limit - 1,
      );
      expect(res.setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
    });

    it('keys on the forwarded client IP, not the proxy', () => {
      // In production every request arrives from Caddy, so keying on req.ip
      // would put the entire internet in one window.
      const limit = AUTH_THROTTLE_BUCKETS['register']!.ip.limit;
      for (let i = 0; i < limit; i += 1) {
        const ctx = contextFor(
          'register',
          { headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' }, ip: '10.0.0.1' },
          res,
        );
        expect(guard.canActivate(ctx)).toBe(true);
      }

      // A different client behind the same proxy is unaffected.
      const other = contextFor(
        'register',
        { headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }, ip: '10.0.0.1' },
        res,
      );
      expect(guard.canActivate(other)).toBe(true);
    });
  });

  describe('breach', () => {
    const limit = AUTH_THROTTLE_BUCKETS['register']!.ip.limit;

    function exhaust(): void {
      for (let i = 0; i < limit; i += 1) {
        guard.canActivate(contextFor('register', { headers: {}, ip: IP }, res));
      }
    }

    it('throws 429 once the bucket is spent', () => {
      exhaust();
      const ctx = contextFor('register', { headers: {}, ip: IP }, res);

      expect(() => guard.canActivate(ctx)).toThrow(HttpException);
      try {
        guard.canActivate(contextFor('register', { headers: {}, ip: IP }, res));
      } catch (err) {
        expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
    });

    it('sets Retry-After in whole seconds', () => {
      exhaust();
      const ctx = contextFor('register', { headers: {}, ip: IP }, res);

      expect(() => guard.canActivate(ctx)).toThrow();
      const retryAfter = res.setHeader.mock.calls.find(([h]) => h === 'Retry-After');
      expect(retryAfter).toBeDefined();
      expect(Number.isInteger(retryAfter![1])).toBe(true);
      expect(retryAfter![1]).toBeGreaterThan(0);
    });

    it('reports zero remaining alongside the refusal', () => {
      exhaust();
      expect(() =>
        guard.canActivate(contextFor('register', { headers: {}, ip: IP }, res)),
      ).toThrow();
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 0);
    });
  });

  describe('subject dimension', () => {
    const rule = AUTH_THROTTLE_BUCKETS['forgot-password']!;

    it('reads the subject from the parsed body', () => {
      // Guards run after Express has parsed the body but before ValidationPipe,
      // so `req.body.email` is readable here — that ordering is the premise the
      // whole second dimension rests on.
      for (let i = 0; i < rule.subject!.limit; i += 1) {
        const ctx = contextFor(
          'forgot-password',
          { headers: { 'x-forwarded-for': `198.51.100.${i}` }, body: { email: 'v@x.com' } },
          res,
        );
        expect(guard.canActivate(ctx)).toBe(true);
      }

      const blocked = contextFor(
        'forgot-password',
        { headers: { 'x-forwarded-for': '198.51.100.99' }, body: { email: 'v@x.com' } },
        res,
      );
      expect(() => guard.canActivate(blocked)).toThrow(HttpException);
    });

    it('never names the dimension that blocked the request', () => {
      // A 429 that said "this email has been asked for too often" would be the
      // account-existence oracle the identical-response design exists to deny.
      for (let i = 0; i < rule.subject!.limit; i += 1) {
        guard.canActivate(
          contextFor(
            'forgot-password',
            { headers: { 'x-forwarded-for': `198.51.100.${i}` }, body: { email: 'v@x.com' } },
            res,
          ),
        );
      }

      try {
        guard.canActivate(
          contextFor(
            'forgot-password',
            { headers: { 'x-forwarded-for': '198.51.100.99' }, body: { email: 'v@x.com' } },
            res,
          ),
        );
        throw new Error('expected a 429');
      } catch (err) {
        const body = (err as HttpException).getResponse() as { message: string };
        expect(body.message).not.toMatch(/v@x\.com|email|subject|address/i);
        expect(body.message).toMatch(/Too many requests/);
      }
    });

    it('tolerates a missing body', () => {
      // A request with no body at all still has to be rationed, not crash.
      const ctx = contextFor('forgot-password', { headers: {}, ip: IP }, res);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('folds the case of the subject so re-casing cannot buy a fresh window', () => {
      // The subject is an email address, and the service treats addresses
      // case-insensitively. Keying the window on the raw spelling gave an
      // attacker one full window per casing against the same victim — enough to
      // mail a reset link at will. Each request also comes from a different IP,
      // so only the subject dimension can be what stops it.
      const spellings = ['v@x.com', 'V@x.com', 'v@X.COM', ' V@X.com '];

      for (let i = 0; i < rule.subject!.limit; i += 1) {
        const ctx = contextFor(
          'forgot-password',
          {
            headers: { 'x-forwarded-for': `198.51.100.${i}` },
            body: { email: spellings[i % spellings.length] },
          },
          res,
        );
        expect(guard.canActivate(ctx)).toBe(true);
      }

      const blocked = contextFor(
        'forgot-password',
        { headers: { 'x-forwarded-for': '198.51.100.99' }, body: { email: 'V@X.COM' } },
        res,
      );
      expect(() => guard.canActivate(blocked)).toThrow(HttpException);
    });

    it('keeps genuinely different addresses in separate windows', () => {
      for (let i = 0; i < rule.subject!.limit; i += 1) {
        guard.canActivate(
          contextFor(
            'forgot-password',
            { headers: { 'x-forwarded-for': `198.51.100.${i}` }, body: { email: 'v@x.com' } },
            res,
          ),
        );
      }

      // A second victim's address must still have its own budget.
      const other = contextFor(
        'forgot-password',
        { headers: { 'x-forwarded-for': '198.51.100.98' }, body: { email: 'w@x.com' } },
        res,
      );
      expect(guard.canActivate(other)).toBe(true);
    });

    it('ignores a non-string subject', () => {
      // `email: {...}` is what an injection attempt looks like before
      // ValidationPipe rejects it; it must not become a Map key.
      const ctx = contextFor(
        'forgot-password',
        { headers: {}, ip: IP, body: { email: { $ne: null } } },
        res,
      );
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('does not read a body field for a bucket with no subject rule', () => {
      const ctx = contextFor('register', { headers: {}, ip: IP, body: { email: 'a@b.com' } }, res);
      expect(guard.canActivate(ctx)).toBe(true);
      // `register` is keyed on IP alone, so two signups for the same email from
      // different hosts are both admitted.
      const other = contextFor(
        'register',
        { headers: { 'x-forwarded-for': '198.51.100.4' }, body: { email: 'a@b.com' } },
        res,
      );
      expect(guard.canActivate(other)).toBe(true);
    });
  });
});
