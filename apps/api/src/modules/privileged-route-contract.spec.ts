/**
 * Role contract for the privilege-sensitive routes.
 *
 * `RolesGuard` is global, so a route is protected exactly when it carries a
 * `@Roles()` decorator. A missing decorator is silent — the route keeps
 * working, for everyone, which is how the team-management escalation went
 * unnoticed. This file pins down which routes are gated and at what level, so
 * dropping one is a test failure rather than an open endpoint.
 *
 * A route belongs here when calling it can escalate privilege, move money, or
 * destroy data irreversibly. Read-only routes deliberately stay open: the
 * settings pages have to render for whoever opens them.
 */
import { Reflector, APP_GUARD } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RolesGuard } from './auth/guards/roles.guard';
import { ROLES_KEY } from './auth/decorators/roles.decorator';
import { TeamController } from './tenant/team.controller';
import { TenantController } from './tenant/tenant.controller';
import { BillingController } from './billing/billing.controller';
import { ApiKeysController } from './integrations/api-keys.controller';
import { ComplianceController } from './compliance/compliance.controller';

/** [description, controller, handler name, required role] */
const GATED: Array<[string, NewableFunction, string, string]> = [
  // Team management — the reported escalation.
  ['POST /auth/team/invite', TeamController, 'inviteMember', 'MANAGER'],
  ['PATCH /auth/team/:id/role', TeamController, 'updateRole', 'OWNER'],
  ['DELETE /auth/team/:id', TeamController, 'removeMember', 'MANAGER'],
  ['POST /tenant/members/invite', TenantController, 'inviteMember', 'MANAGER'],
  ['DELETE /tenant/members/:userId', TenantController, 'removeMember', 'MANAGER'],
  // Credential issuance — same class of escalation as inviting a member.
  ['POST /api-keys', ApiKeysController, 'create', 'MANAGER'],
  ['DELETE /api-keys/:id', ApiKeysController, 'revoke', 'MANAGER'],
  // Spends money.
  ['POST /billing/upgrade', BillingController, 'upgrade', 'OWNER'],
  // Irreversible destruction of customer data.
  ['POST /compliance/erasure', ComplianceController, 'erasure', 'MANAGER'],
  ['PUT /compliance/settings', ComplianceController, 'updateSettings', 'OWNER'],
  ['POST /compliance/retention/run', ComplianceController, 'runRetention', 'OWNER'],
];

/** Routes that must stay reachable by every authenticated member. */
const OPEN: Array<[string, NewableFunction, string]> = [
  ['GET /auth/team', TeamController, 'listTeam'],
  ['GET /api-keys', ApiKeysController, 'list'],
  ['GET /billing/subscription', BillingController, 'subscription'],
  ['GET /compliance/data-request/:phone', ComplianceController, 'dataRequest'],
  ['POST /compliance/correction', ComplianceController, 'correction'],
];

function handler(controller: NewableFunction, method: string): object {
  return (controller.prototype as Record<string, unknown>)[method] as object;
}

function rolesOn(controller: NewableFunction, method: string): string[] | undefined {
  return Reflect.getMetadata(ROLES_KEY, handler(controller, method)) as string[] | undefined;
}

function contextFor(
  controller: NewableFunction,
  method: string,
  role: string,
): ExecutionContext {
  return {
    getHandler: () => handler(controller, method),
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
}

describe('privileged route contract', () => {
  const guard = new RolesGuard(new Reflector());

  it('has RolesGuard registered globally, or none of the below is enforced', async () => {
    const { AuthModule } = await import('./auth/auth.module');
    const providers = (Reflect.getMetadata('providers', AuthModule) ?? []) as Array<
      { provide?: unknown; useClass?: NewableFunction } | NewableFunction
    >;
    const globals = providers
      .filter(
        (p): p is { provide: unknown; useClass: NewableFunction } =>
          typeof p === 'object' && p !== null && 'provide' in p && p.provide === APP_GUARD,
      )
      .map((p) => p.useClass.name);

    expect(globals).toContain('RolesGuard');
  });

  describe.each(GATED)('%s', (_route, controller, method, required) => {
    it(`declares @Roles(${required})`, () => {
      expect(rolesOn(controller, method)).toEqual([required]);
    });

    it('rejects VIEWER and STAFF', () => {
      expect(() => guard.canActivate(contextFor(controller, method, 'VIEWER'))).toThrow(
        ForbiddenException,
      );
      expect(() => guard.canActivate(contextFor(controller, method, 'STAFF'))).toThrow(
        ForbiddenException,
      );
    });

    it('admits OWNER', () => {
      expect(guard.canActivate(contextFor(controller, method, 'OWNER'))).toBe(true);
    });

    it(`${required === 'OWNER' ? 'rejects' : 'admits'} MANAGER`, () => {
      const ctx = contextFor(controller, method, 'MANAGER');
      if (required === 'OWNER') {
        expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      } else {
        expect(guard.canActivate(ctx)).toBe(true);
      }
    });
  });

  describe.each(OPEN)('%s stays open', (_route, controller, method) => {
    it('carries no @Roles() decorator', () => {
      expect(rolesOn(controller, method)).toBeUndefined();
    });

    it('admits a VIEWER', () => {
      expect(guard.canActivate(contextFor(controller, method, 'VIEWER'))).toBe(true);
    });
  });
});
