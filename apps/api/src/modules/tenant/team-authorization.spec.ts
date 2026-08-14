/**
 * Authorization contract for team management.
 *
 * `RolesGuard` and `@Roles()` both existed and both worked in isolation, but
 * the guard was registered nowhere and the decorator appeared on no
 * controller, so every team endpoint was open to any authenticated member —
 * a VIEWER could invite an OWNER, and any member could remove one.
 *
 * Unit tests on the guard cannot catch that: the guard passes its own tests
 * while being wired into nothing. These tests assert the *wiring* — that the
 * guard is global, that the decorators are on the handlers, and that running
 * the real guard against the real metadata rejects the roles it should.
 */
import { Reflector, APP_GUARD } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { TeamController } from './team.controller';
import { TenantController } from './tenant.controller';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

type Provider = { provide?: unknown; useClass?: NewableFunction } | NewableFunction;

/** Global guards, in the order Nest will run them. */
function appGuards(moduleClass: NewableFunction): string[] {
  const providers = (Reflect.getMetadata('providers', moduleClass) ?? []) as Provider[];
  return providers
    .filter(
      (p): p is { provide: unknown; useClass: NewableFunction } =>
        typeof p === 'object' && p !== null && 'provide' in p && p.provide === APP_GUARD,
    )
    .map((p) => p.useClass.name);
}

/** A context whose handler is the real controller method, decorators and all. */
function contextFor(
  controller: NewableFunction,
  method: string,
  user: Partial<AuthenticatedUser> | undefined,
): ExecutionContext {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('team management authorization', () => {
  describe('RolesGuard global registration', () => {
    it('is registered as an APP_GUARD', async () => {
      const { AuthModule } = await import('../auth/auth.module');
      expect(appGuards(AuthModule)).toContain('RolesGuard');
    });

    it('runs after JwtAuthGuard, which is what populates request.user', async () => {
      // Global guards execute in declaration order. Registered first,
      // RolesGuard would see no user on every request and reject every
      // @Roles() route outright.
      const { AuthModule } = await import('../auth/auth.module');
      const guards = appGuards(AuthModule);

      expect(guards.indexOf('JwtAuthGuard')).toBeGreaterThanOrEqual(0);
      expect(guards.indexOf('RolesGuard')).toBeGreaterThan(guards.indexOf('JwtAuthGuard'));
    });
  });

  describe('@Roles() coverage of the mutating endpoints', () => {
    // Reading the team is not restricted — any member may see who they work
    // with. Changing it is.
    const guarded: Array<[string, NewableFunction, string, string]> = [
      ['POST /auth/team/invite', TeamController, 'inviteMember', 'MANAGER'],
      ['PATCH /auth/team/:id/role', TeamController, 'updateRole', 'OWNER'],
      ['DELETE /auth/team/:id', TeamController, 'removeMember', 'MANAGER'],
      ['POST /tenant/members/invite', TenantController, 'inviteMember', 'MANAGER'],
      ['DELETE /tenant/members/:userId', TenantController, 'removeMember', 'MANAGER'],
    ];

    it.each(guarded)('%s requires %s', (_route, controller, method, expected) => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        (controller.prototype as Record<string, unknown>)[method] as object,
      ) as string[] | undefined;

      expect(roles).toEqual([expected]);
    });

    it('leaves the read-only team listing open to any member', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, TeamController.prototype.listTeam);
      expect(roles).toBeUndefined();
    });
  });

  describe('RolesGuard against the real handler metadata', () => {
    let guard: RolesGuard;

    beforeEach(() => {
      guard = new RolesGuard(new Reflector());
    });

    // The reported escalation: a VIEWER posting {role: 'OWNER'} to the invite
    // endpoint and being handed a fresh owner account.
    it('rejects a VIEWER inviting a team member', () => {
      const ctx = contextFor(TeamController, 'inviteMember', { role: 'VIEWER' });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('rejects a STAFF member inviting a team member', () => {
      const ctx = contextFor(TeamController, 'inviteMember', { role: 'STAFF' });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it.each(['MANAGER', 'OWNER'])('admits %s to the invite endpoint', (role) => {
      expect(guard.canActivate(contextFor(TeamController, 'inviteMember', { role }))).toBe(true);
    });

    // The reported deletion hole: any member removing the sole OWNER.
    it.each(['VIEWER', 'STAFF'])('rejects %s removing a team member', (role) => {
      const ctx = contextFor(TeamController, 'removeMember', { role });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it.each(['MANAGER', 'OWNER'])('admits %s to the remove endpoint', (role) => {
      expect(guard.canActivate(contextFor(TeamController, 'removeMember', { role }))).toBe(true);
    });

    it('rejects a MANAGER changing roles — that endpoint is owner-only', () => {
      const ctx = contextFor(TeamController, 'updateRole', { role: 'MANAGER' });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('admits an OWNER to the role-change endpoint', () => {
      expect(guard.canActivate(contextFor(TeamController, 'updateRole', { role: 'OWNER' }))).toBe(
        true,
      );
    });

    it('leaves the unguarded listing endpoint alone', () => {
      expect(guard.canActivate(contextFor(TeamController, 'listTeam', { role: 'VIEWER' }))).toBe(
        true,
      );
    });

    it('rejects a request with no authenticated user', () => {
      const ctx = contextFor(TeamController, 'inviteMember', undefined);
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('rejects a token carrying a role this build does not know', () => {
      // A forged or stale token claiming e.g. 'ADMIN' — a role GoSumo has
      // never had — must not slip past by ranking as "unknown vs unknown".
      const ctx = contextFor(TeamController, 'inviteMember', { role: 'ADMIN' });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
  });
});
