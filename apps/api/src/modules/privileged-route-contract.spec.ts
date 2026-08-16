/**
 * Role contract for the privilege-sensitive routes.
 *
 * `RolesGuard` is global and enforces two tiers:
 *
 *  - An explicit `@Roles()` names the minimum rank for that route. This file
 *    pins down which routes carry one and at what level, so dropping a
 *    decorator is a test failure rather than a silently open endpoint — that
 *    is how the team-management escalation went unnoticed.
 *
 *  - Every other write (POST/PUT/PATCH/DELETE) requires STAFF or above by
 *    default, so VIEWER is read-only across the API without needing a
 *    decorator on all ~200 of them.
 *
 * A route belongs in GATED when calling it can escalate privilege, move money,
 * reconfigure the business, or destroy data irreversibly. Read-only routes
 * deliberately stay open: the settings pages have to render for whoever opens
 * them.
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
import { BusinessController } from './tenant/business.controller';
import { AiEngineController } from './ai-engine/ai-engine.controller';
import { ChannelsController } from './channels/channels.controller';
import { IntegrationsController } from './integrations/integrations.controller';
import { SlaController } from './sla/sla.controller';
import { AuditController } from './audit/audit.controller';
import { RealtyCrmController } from './realty-integrations/crm/realty-crm.controller';
import { RealtySheetsController } from './realty-integrations/sheets/realty-sheets.controller';

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
  // Reconfigures how the business runs, or suspends it outright.
  ['PATCH /tenant/profile', TenantController, 'updateProfile', 'MANAGER'],
  ['PATCH /tenant/policies', TenantController, 'updatePolicies', 'MANAGER'],
  ['POST /tenant/suspend', TenantController, 'suspend', 'OWNER'],
  ['POST /tenant/activate', TenantController, 'activate', 'OWNER'],
  ['PATCH /business/me', BusinessController, 'updateMe', 'MANAGER'],
  ['PATCH /business/settings', BusinessController, 'updateSettings', 'MANAGER'],
  // AI behaviour — the confidence thresholds are a safety control, and the
  // knowledge base is what the AI answers customers from.
  ['PATCH /tenant/ai-config', TenantController, 'updateAIConfig', 'MANAGER'],
  ['PATCH /ai/confidence/thresholds', AiEngineController, 'updateThresholds', 'MANAGER'],
  ['POST /ai/knowledge', AiEngineController, 'ingestKnowledge', 'MANAGER'],
  ['DELETE /ai/knowledge/:entryId', AiEngineController, 'deleteKnowledge', 'MANAGER'],
  // Channel and integration wiring — holds third-party credentials.
  ['POST /tenant/channels', TenantController, 'connectChannel', 'MANAGER'],
  ['PATCH /tenant/channels/:id', TenantController, 'updateChannel', 'MANAGER'],
  ['DELETE /tenant/channels/:id', TenantController, 'disconnectChannel', 'MANAGER'],
  ['POST /channels/:channelType/connect', ChannelsController, 'connectChannel', 'MANAGER'],
  ['DELETE /channels/:channelId', ChannelsController, 'disconnectChannel', 'MANAGER'],
  ['POST /channels/:channelId/test', ChannelsController, 'testConnection', 'MANAGER'],
  ['PUT /integrations/credentials/:provider', IntegrationsController, 'saveCredentials', 'MANAGER'],
  [
    'POST /integrations/credentials/:provider/test',
    IntegrationsController,
    'testCredentials',
    'MANAGER',
  ],
  ['POST /integrations/google-calendar/connect', IntegrationsController, 'connectCalendar', 'MANAGER'],
  ['DELETE /integrations/google-calendar', IntegrationsController, 'disconnectCalendar', 'MANAGER'],
  ['POST /realty/integrations/crm/connect', RealtyCrmController, 'connect', 'MANAGER'],
  ['DELETE /realty/integrations/crm/:provider', RealtyCrmController, 'disconnect', 'MANAGER'],
  ['DELETE /realty/integrations/sheets', RealtySheetsController, 'disconnect', 'MANAGER'],
  // Changes the bill.
  ['POST /tenant/subscription/change', TenantController, 'changePlan', 'OWNER'],
  // Response-time commitments the business is measured against.
  ['POST /sla/policies', SlaController, 'createPolicy', 'MANAGER'],
  ['PATCH /sla/policies/:id', SlaController, 'updatePolicy', 'MANAGER'],
  ['DELETE /sla/policies/:id', SlaController, 'deletePolicy', 'MANAGER'],
  // Skills decide which conversations reach whom, so granting one grants access
  // to a queue — the same class of authority change as a role.
  ['PATCH /auth/team/:id/skills', TeamController, 'setSkills', 'MANAGER'],
  // The audit trail is the one *read* that is gated. These rows carry
  // `ip_address` and `user_agent` for every acting member, so a staff-visible
  // endpoint would make the trail a way to watch colleagues rather than a way
  // to answer "who granted that". Reads stay open elsewhere because settings
  // pages must render; here the data *is* the surveillance.
  ['GET /audit-logs', AuditController, 'list', 'MANAGER'],
  ['GET /audit-logs/summary', AuditController, 'summary', 'MANAGER'],
  ['GET /audit-logs/export', AuditController, 'export', 'MANAGER'],
  ['GET /audit-logs/:id', AuditController, 'get', 'MANAGER'],
];

/** Reads that must stay reachable by every authenticated member, VIEWER included. */
const OPEN_READS: Array<[string, NewableFunction, string]> = [
  ['GET /auth/team', TeamController, 'listTeam'],
  ['GET /api-keys', ApiKeysController, 'list'],
  ['GET /billing/subscription', BillingController, 'subscription'],
  ['GET /compliance/data-request/:phone', ComplianceController, 'dataRequest'],
];

/**
 * Writes that carry no `@Roles()` and rely on the guard's STAFF-or-above
 * default. They are open to the operators who run the business day to day, but
 * closed to VIEWER — which is the point of the default.
 */
const DEFAULTED_WRITES: Array<[string, NewableFunction, string]> = [
  ['POST /compliance/correction', ComplianceController, 'correction'],
];

function handler(controller: NewableFunction, method: string): object {
  return (controller.prototype as Record<string, unknown>)[method] as object;
}

function rolesOn(controller: NewableFunction, method: string): string[] | undefined {
  return Reflect.getMetadata(ROLES_KEY, handler(controller, method)) as string[] | undefined;
}

/** The HTTP verb is the first word of the route description. */
function verbOf(route: string): string {
  return route.split(' ')[0] as string;
}

function contextFor(
  controller: NewableFunction,
  method: string,
  role: string,
  verb = 'POST',
): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => handler(controller, method),
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { role }, method: verb }) }),
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

  describe.each(GATED)('%s', (route, controller, method, required) => {
    const verb = verbOf(route);

    it(`declares @Roles(${required})`, () => {
      expect(rolesOn(controller, method)).toEqual([required]);
    });

    it('rejects VIEWER and STAFF', () => {
      expect(() => guard.canActivate(contextFor(controller, method, 'VIEWER', verb))).toThrow(
        ForbiddenException,
      );
      expect(() => guard.canActivate(contextFor(controller, method, 'STAFF', verb))).toThrow(
        ForbiddenException,
      );
    });

    it('admits OWNER', () => {
      expect(guard.canActivate(contextFor(controller, method, 'OWNER', verb))).toBe(true);
    });

    it(`${required === 'OWNER' ? 'rejects' : 'admits'} MANAGER`, () => {
      const ctx = contextFor(controller, method, 'MANAGER', verb);
      if (required === 'OWNER') {
        expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      } else {
        expect(guard.canActivate(ctx)).toBe(true);
      }
    });
  });

  describe.each(OPEN_READS)('%s stays open', (route, controller, method) => {
    const verb = verbOf(route);

    it('carries no @Roles() decorator', () => {
      expect(rolesOn(controller, method)).toBeUndefined();
    });

    it('admits a VIEWER', () => {
      expect(guard.canActivate(contextFor(controller, method, 'VIEWER', verb))).toBe(true);
    });
  });

  describe.each(DEFAULTED_WRITES)(
    '%s falls back to the write default',
    (route, controller, method) => {
      const verb = verbOf(route);

      it('carries no @Roles() decorator', () => {
        expect(rolesOn(controller, method)).toBeUndefined();
      });

      it('rejects a VIEWER anyway — writes are STAFF and above', () => {
        expect(() => guard.canActivate(contextFor(controller, method, 'VIEWER', verb))).toThrow(
          ForbiddenException,
        );
      });

      it.each(['STAFF', 'MANAGER', 'OWNER'])('admits %s', (role) => {
        expect(guard.canActivate(contextFor(controller, method, role, verb))).toBe(true);
      });
    },
  );
});
