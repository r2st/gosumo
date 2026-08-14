/**
 * RolesGuard unit tests.
 *
 * The guard is registered as `APP_GUARD` directly after JwtAuthGuard, so it
 * decides authorization for every authenticated route in the API. Three
 * behaviours are load-bearing:
 *
 *  1. **Explicit `@Roles()`** — rank-based, so `@Roles(MANAGER)` admits OWNER
 *     too. An unrecognised role must fail every comparison rather than pass
 *     one (see `roleRank`).
 *
 *  2. **Writes deny VIEWER by default** — an undecorated POST/PUT/PATCH/DELETE
 *     still requires STAFF or above. This is the whole point of the guard-level
 *     default: routes added later are closed before anyone thinks about them.
 *     These tests are the contract that keeps that true.
 *
 *  3. **The two escape hatches** — `@Public()` (webhooks, login) skips the
 *     guard entirely, and `@SelfService()` lets any authenticated role perform
 *     the writes that act on their own account. Without the latter a VIEWER
 *     could sign in but never sign out.
 */

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { SELF_SERVICE_KEY } from '../decorators/self-service.decorator';
import { IS_PUBLIC_KEY } from '../../../common/interceptors/tenant.interceptor';

interface ContextOptions {
  method?: string;
  role?: string | null;
  authenticated?: boolean;
  type?: string;
}

function makeContext({
  method = 'GET',
  role = 'VIEWER',
  authenticated = true,
  type = 'http',
}: ContextOptions = {}): ExecutionContext {
  const request = {
    method,
    user: authenticated ? { sub: 'u1', businessId: 'b1', email: 'a@b.c', role } : undefined,
  };
  return {
    getType: () => type,
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
  } as unknown as ExecutionContext;
}

interface Metadata {
  roles?: string[];
  isPublic?: boolean;
  selfService?: boolean;
}

/**
 * A Reflector answering the three metadata keys the guard reads. Using the real
 * class keeps `getAllAndOverride` honest — a signature change breaks
 * compilation here rather than silently passing.
 */
function makeReflector({ roles, isPublic, selfService }: Metadata = {}): Reflector {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
    if (key === ROLES_KEY) return roles as never;
    if (key === IS_PUBLIC_KEY) return isPublic as never;
    if (key === SELF_SERVICE_KEY) return selfService as never;
    return undefined as never;
  });
  return reflector;
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const ALL_ROLES = ['OWNER', 'MANAGER', 'STAFF', 'VIEWER'];

describe('RolesGuard', () => {
  afterEach(() => jest.restoreAllMocks());

  // ═══════════════════════════════════════════
  // Reads stay open to every authenticated role
  // ═══════════════════════════════════════════

  describe('reads', () => {
    it.each(ALL_ROLES)('lets %s through an undecorated GET', (role) => {
      const guard = new RolesGuard(makeReflector());
      expect(guard.canActivate(makeContext({ method: 'GET', role }))).toBe(true);
    });

    it.each(READ_METHODS)('treats %s as a read', (method) => {
      const guard = new RolesGuard(makeReflector());
      expect(guard.canActivate(makeContext({ method, role: 'VIEWER' }))).toBe(true);
    });

    it('does not even look at the user on an undecorated read', () => {
      const guard = new RolesGuard(makeReflector());
      // No @Roles and not a write — the guard should short-circuit before it
      // reaches request.user, so an unauthenticated context must not throw.
      expect(
        guard.canActivate(makeContext({ method: 'GET', authenticated: false })),
      ).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // The write default — VIEWER is read-only
  // ═══════════════════════════════════════════

  describe('undecorated writes deny VIEWER by default', () => {
    it.each(WRITE_METHODS)('rejects a VIEWER on %s', (method) => {
      const guard = new RolesGuard(makeReflector());
      expect(() => guard.canActivate(makeContext({ method, role: 'VIEWER' }))).toThrow(
        ForbiddenException,
      );
    });

    it.each(WRITE_METHODS)('admits STAFF on %s', (method) => {
      const guard = new RolesGuard(makeReflector());
      expect(guard.canActivate(makeContext({ method, role: 'STAFF' }))).toBe(true);
    });

    it.each(['STAFF', 'MANAGER', 'OWNER'])('admits %s on an undecorated write', (role) => {
      const guard = new RolesGuard(makeReflector());
      expect(guard.canActivate(makeContext({ method: 'POST', role }))).toBe(true);
    });

    it('explains that the role is read-only rather than leaking the route', () => {
      const guard = new RolesGuard(makeReflector());
      expect(() => guard.canActivate(makeContext({ method: 'DELETE', role: 'VIEWER' }))).toThrow(
        /read-only and cannot modify data/,
      );
    });

    it('matches the verb case-insensitively', () => {
      const guard = new RolesGuard(makeReflector());
      expect(() => guard.canActivate(makeContext({ method: 'post', role: 'VIEWER' }))).toThrow(
        ForbiddenException,
      );
    });

    it('rejects an unauthenticated write outright', () => {
      const guard = new RolesGuard(makeReflector());
      expect(() =>
        guard.canActivate(makeContext({ method: 'POST', authenticated: false })),
      ).toThrow('No authenticated user found');
    });

    it.each([['UNKNOWN'], ['viewer'], ['']])(
      'rejects the unrecognised role %p on a write',
      (role) => {
        const guard = new RolesGuard(makeReflector());
        expect(() => guard.canActivate(makeContext({ method: 'POST', role }))).toThrow(
          ForbiddenException,
        );
      },
    );

    it('names STAFF as the requirement when an unranked role hits an undecorated write', () => {
      const guard = new RolesGuard(makeReflector());
      expect(() => guard.canActivate(makeContext({ method: 'POST', role: 'ROBOT' }))).toThrow(
        /not a recognised role\. Required: STAFF/,
      );
    });

    it('rejects a null role on a write', () => {
      const guard = new RolesGuard(makeReflector());
      expect(() => guard.canActivate(makeContext({ method: 'POST', role: null }))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ═══════════════════════════════════════════
  // Explicit @Roles()
  // ═══════════════════════════════════════════

  describe('explicit @Roles()', () => {
    it('admits the exact role', () => {
      const guard = new RolesGuard(makeReflector({ roles: ['MANAGER'] }));
      expect(guard.canActivate(makeContext({ method: 'PATCH', role: 'MANAGER' }))).toBe(true);
    });

    it('admits a role ranked above the requirement', () => {
      const guard = new RolesGuard(makeReflector({ roles: ['MANAGER'] }));
      expect(guard.canActivate(makeContext({ method: 'PATCH', role: 'OWNER' }))).toBe(true);
    });

    it.each(['STAFF', 'VIEWER'])('rejects %s below a MANAGER requirement', (role) => {
      const guard = new RolesGuard(makeReflector({ roles: ['MANAGER'] }));
      expect(() => guard.canActivate(makeContext({ method: 'PATCH', role }))).toThrow(
        /does not have sufficient permissions/,
      );
    });

    it('applies to reads as well as writes', () => {
      const guard = new RolesGuard(makeReflector({ roles: ['OWNER'] }));
      expect(() => guard.canActivate(makeContext({ method: 'GET', role: 'STAFF' }))).toThrow(
        ForbiddenException,
      );
    });

    it('admits when any one of several named roles is satisfied', () => {
      const guard = new RolesGuard(makeReflector({ roles: ['OWNER', 'STAFF'] }));
      expect(guard.canActivate(makeContext({ method: 'POST', role: 'STAFF' }))).toBe(true);
    });

    it('treats an empty @Roles() list as no decorator at all', () => {
      const guard = new RolesGuard(makeReflector({ roles: [] }));
      // Falls through to the write default, which still denies VIEWER.
      expect(() => guard.canActivate(makeContext({ method: 'POST', role: 'VIEWER' }))).toThrow(
        ForbiddenException,
      );
      expect(guard.canActivate(makeContext({ method: 'GET', role: 'VIEWER' }))).toBe(true);
    });

    it('is not a backdoor when the required role is itself unrecognised', () => {
      // Both sides rank -1; the caller must not be admitted on a tie.
      const guard = new RolesGuard(makeReflector({ roles: ['SUPERUSER'] }));
      expect(() => guard.canActivate(makeContext({ method: 'GET', role: 'GHOST' }))).toThrow(
        ForbiddenException,
      );
      expect(() => guard.canActivate(makeContext({ method: 'GET', role: 'OWNER' }))).toThrow(
        /does not have sufficient permissions/,
      );
    });

    it('rejects an unauthenticated caller on a decorated route', () => {
      const guard = new RolesGuard(makeReflector({ roles: ['STAFF'] }));
      expect(() =>
        guard.canActivate(makeContext({ method: 'GET', authenticated: false })),
      ).toThrow('No authenticated user found');
    });

    it('takes precedence over @SelfService()', () => {
      // An explicitly gated route must not be loosened by a stray marker.
      const guard = new RolesGuard(makeReflector({ roles: ['OWNER'], selfService: true }));
      expect(() => guard.canActivate(makeContext({ method: 'POST', role: 'VIEWER' }))).toThrow(
        ForbiddenException,
      );
    });
  });

  // ═══════════════════════════════════════════
  // @Public()
  // ═══════════════════════════════════════════

  describe('@Public()', () => {
    it('skips the guard entirely for an unauthenticated webhook POST', () => {
      const guard = new RolesGuard(makeReflector({ isPublic: true }));
      expect(
        guard.canActivate(makeContext({ method: 'POST', authenticated: false })),
      ).toBe(true);
    });

    it('wins over an explicit @Roles() on the same route', () => {
      const guard = new RolesGuard(makeReflector({ isPublic: true, roles: ['OWNER'] }));
      expect(guard.canActivate(makeContext({ method: 'POST', role: 'VIEWER' }))).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // @SelfService()
  // ═══════════════════════════════════════════

  describe('@SelfService()', () => {
    it.each(ALL_ROLES)('lets %s perform a self-service write', (role) => {
      const guard = new RolesGuard(makeReflector({ selfService: true }));
      expect(guard.canActivate(makeContext({ method: 'POST', role }))).toBe(true);
    });

    it('still rejects an unrecognised role', () => {
      const guard = new RolesGuard(makeReflector({ selfService: true }));
      expect(() => guard.canActivate(makeContext({ method: 'POST', role: 'ROBOT' }))).toThrow(
        ForbiddenException,
      );
    });

    it('still requires an authenticated user', () => {
      const guard = new RolesGuard(makeReflector({ selfService: true }));
      expect(() =>
        guard.canActivate(makeContext({ method: 'POST', authenticated: false })),
      ).toThrow('No authenticated user found');
    });
  });

  // ═══════════════════════════════════════════
  // Non-HTTP contexts
  // ═══════════════════════════════════════════

  describe('non-HTTP execution contexts', () => {
    it('does not apply the write default to a WebSocket handler', () => {
      // request.method does not exist over ws; the default must not fire
      // against an undefined verb.
      const guard = new RolesGuard(makeReflector());
      expect(guard.canActivate(makeContext({ type: 'ws', role: 'VIEWER' }))).toBe(true);
    });

    it('still honours an explicit @Roles() outside HTTP', () => {
      const guard = new RolesGuard(makeReflector({ roles: ['OWNER'] }));
      // No HTTP request object means no user to check — fail closed.
      expect(() => guard.canActivate(makeContext({ type: 'ws', role: 'OWNER' }))).toThrow(
        'No authenticated user found',
      );
    });
  });
});
