/**
 * JwtAuthGuard unit tests.
 *
 * This guard is registered as `APP_GUARD`, so it is the single thing standing
 * between the internet and every non-`@Public()` route in the API. Two of its
 * behaviours are load-bearing and neither is obvious from the code:
 *
 *  1. `canActivate` short-circuits to `true` for public routes *without*
 *     calling Passport. `public-route-contract.spec.ts` polices which routes
 *     may carry `@Public()`; this file proves the decorator actually does what
 *     that allowlist assumes it does — and, more importantly, that the absence
 *     of the decorator falls through to real verification.
 *
 *  2. `handleRequest` is Passport's error hook. It is the only place where a
 *     failed verification becomes a 401. The `err ?? !user` condition is
 *     subtle: `??` (not `||`) means a *non-null* err short-circuits, but a
 *     `null` err falls through to the `!user` check. Passport calls this hook
 *     with `(null, false, info)` on an expired or malformed token — the single
 *     most common failure in production — so the `!user` arm is not an edge
 *     case, it is the main path.
 */

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { JwtAuthGuard } from './auth.guard';
import { IS_PUBLIC_KEY } from '../interceptors/tenant.interceptor';

function makeContext(): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => ({ headers: {} }),
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

/**
 * A Reflector that answers `IS_PUBLIC_KEY` with a fixed value.
 *
 * Using the real class (rather than a bare object) keeps the guard's
 * `getAllAndOverride` call honest — a signature change breaks compilation here
 * instead of silently passing.
 */
function makeReflector(isPublic: boolean | undefined): Reflector {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key: unknown) => (key === IS_PUBLIC_KEY ? isPublic : undefined) as never);
  return reflector;
}

describe('JwtAuthGuard.canActivate', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lets a @Public() route through without invoking Passport', () => {
    const guard = new JwtAuthGuard(makeReflector(true));

    // If this ever started delegating, every webhook would begin 401-ing —
    // providers do not send bearer tokens.
    const passport = jest
      .spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(guard)) as { canActivate: () => boolean },
        'canActivate',
      )
      .mockReturnValue(false);

    expect(guard.canActivate(makeContext())).toBe(true);
    expect(passport).not.toHaveBeenCalled();
  });

  it('delegates to Passport when the route is not public', () => {
    const guard = new JwtAuthGuard(makeReflector(undefined));

    const passport = jest
      .spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(guard)) as { canActivate: () => boolean },
        'canActivate',
      )
      .mockReturnValue(true);

    expect(guard.canActivate(makeContext())).toBe(true);
    expect(passport).toHaveBeenCalledTimes(1);
  });

  it('treats an explicit false the same as an absent decorator', () => {
    // `getAllAndOverride` returns whatever the metadata holds. A route that set
    // the key to `false` must still be authenticated — only a truthy value is
    // an opt-out.
    const guard = new JwtAuthGuard(makeReflector(false));

    const passport = jest
      .spyOn(
        Object.getPrototypeOf(Object.getPrototypeOf(guard)) as { canActivate: () => boolean },
        'canActivate',
      )
      .mockReturnValue(true);

    guard.canActivate(makeContext());
    expect(passport).toHaveBeenCalledTimes(1);
  });
});

describe('JwtAuthGuard.handleRequest', () => {
  const guard = () => new JwtAuthGuard(makeReflector(undefined));

  it('returns the user when verification succeeded', () => {
    const user = { sub: 'user-1', businessId: 'biz-1' };
    expect(guard().handleRequest(null, user, undefined)).toBe(user);
  });

  it('rejects when Passport reports no user, even with no error', () => {
    // The common case: expired signature, malformed header, wrong audience.
    // Passport passes `(null, false, { message })`.
    expect(() => guard().handleRequest(null, false, { message: 'jwt expired' })).toThrow(
      UnauthorizedException,
    );
  });

  it('surfaces the strategy message so the client can tell expiry from absence', () => {
    try {
      guard().handleRequest(null, false, { message: 'jwt expired' });
      throw new Error('expected handleRequest to throw');
    } catch (error) {
      expect((error as UnauthorizedException).message).toBe('jwt expired');
    }
  });

  it('prefers the error message over the info message', () => {
    try {
      guard().handleRequest(new Error('session revoked'), false, { message: 'jwt expired' });
      throw new Error('expected handleRequest to throw');
    } catch (error) {
      expect((error as UnauthorizedException).message).toBe('session revoked');
    }
  });

  it('rejects when an error arrives alongside a user', () => {
    // `err ?? !user` short-circuits on a non-null error. A strategy that
    // resolved a user *and* raised — e.g. a revoked session checked after
    // lookup — must not be let through on the strength of the user object.
    expect(() =>
      guard().handleRequest(new Error('session revoked'), { sub: 'user-1' }, undefined),
    ).toThrow(UnauthorizedException);
  });

  it('falls back to a generic message when nothing explains the failure', () => {
    try {
      guard().handleRequest(null, false, undefined);
      throw new Error('expected handleRequest to throw');
    } catch (error) {
      expect((error as UnauthorizedException).message).toBe(
        'Invalid or missing authentication token',
      );
    }
  });

  it('rejects a null user', () => {
    expect(() => guard().handleRequest(null, null as unknown as false, undefined)).toThrow(
      UnauthorizedException,
    );
  });
});
