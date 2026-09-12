/**
 * Audit-trail contract for the privilege-sensitive routes.
 *
 * `privileged-route-contract.spec.ts` pins *who may call* each route in its
 * GATED list. This file pins *whether calling it leaves a record*. The two
 * questions are separate — a route can be perfectly gated and still, once
 * called, overwrite the only evidence of what it changed. That is exactly the
 * class `AuditLogService` exists for: "privileged operations that are not
 * attributable from the data they change". G002 found API-key issuance and
 * revocation, business suspension, and channel credential changes were gated
 * that way and recorded nothing, and three more wrote a row that named
 * nobody.
 *
 * Every write route in GATED must appear in exactly one of:
 *
 *   AUDITED           — names the method that writes to audit_logs (the
 *                       controller handler or the service method it calls).
 *                       The spec reads that method's source and asserts it
 *                       calls `audit.record(`; and reads the handler and
 *                       asserts it takes `@CurrentUser()`, since an audit row
 *                       without an actor answers "what" but not "who".
 *   NO_STATE_CHANGE   — the route reads or probes; there is nothing to record.
 *   NOT_YET_AUDITED   — known gaps, each with a reason. This is documented
 *                       debt, not a waiver: adding a route here is allowed,
 *                       silently omitting it is not.
 *
 * The GATED list is read from the sibling spec's source so the two files
 * cannot drift apart: a route added to GATED fails here until it is
 * classified.
 */

import * as fs from 'fs';
import * as path from 'path';

const MODULES = __dirname;

/** Where a route's audit row is written. */
interface Writer {
  file: string;
  method: string;
}

interface AuditedRoute {
  /** The controller handler, which must accept `@CurrentUser()`. */
  handler: Writer;
  /** The method that calls `audit.record(` — the handler itself, or a service. */
  writer: Writer;
}

const AUDITED: Record<string, AuditedRoute> = {
  // Team membership.
  'POST /auth/team/invite': {
    handler: { file: 'tenant/team.controller.ts', method: 'inviteMember' },
    writer: { file: 'tenant/tenant.service.ts', method: 'inviteMember' },
  },
  'PATCH /auth/team/:id/role': {
    handler: { file: 'tenant/team.controller.ts', method: 'updateRole' },
    writer: { file: 'tenant/team.controller.ts', method: 'updateRole' },
  },
  'DELETE /auth/team/:id': {
    handler: { file: 'tenant/team.controller.ts', method: 'removeMember' },
    writer: { file: 'tenant/tenant.service.ts', method: 'removeMember' },
  },
  'PATCH /auth/team/:id/skills': {
    handler: { file: 'tenant/team.controller.ts', method: 'setSkills' },
    writer: { file: 'tenant/team.controller.ts', method: 'setSkills' },
  },
  'POST /tenant/members/invite': {
    handler: { file: 'tenant/tenant.controller.ts', method: 'inviteMember' },
    writer: { file: 'tenant/tenant.service.ts', method: 'inviteMember' },
  },
  'DELETE /tenant/members/:userId': {
    handler: { file: 'tenant/tenant.controller.ts', method: 'removeMember' },
    writer: { file: 'tenant/tenant.service.ts', method: 'removeMember' },
  },

  // Credential issuance (G002).
  'POST /api-keys': {
    handler: { file: 'integrations/api-keys.controller.ts', method: 'create' },
    writer: { file: 'integrations/api-keys.controller.ts', method: 'create' },
  },
  'DELETE /api-keys/:id': {
    handler: { file: 'integrations/api-keys.controller.ts', method: 'revoke' },
    writer: { file: 'integrations/api-keys.controller.ts', method: 'revoke' },
  },

  // Money.
  'POST /billing/upgrade': {
    handler: { file: 'billing/billing.controller.ts', method: 'upgrade' },
    writer: { file: 'billing/billing.service.ts', method: 'upgradePlan' },
  },

  // Irreversible destruction of customer data, and its policy.
  'POST /compliance/erasure': {
    handler: { file: 'compliance/compliance.controller.ts', method: 'erasure' },
    writer: { file: 'compliance/compliance.service.ts', method: 'eraseLead' },
  },
  'PUT /compliance/settings': {
    handler: { file: 'compliance/compliance.controller.ts', method: 'updateSettings' },
    writer: { file: 'compliance/compliance.service.ts', method: 'updateSettings' },
  },

  // Business lifecycle (G002).
  'POST /tenant/suspend': {
    handler: { file: 'tenant/tenant.controller.ts', method: 'suspend' },
    writer: { file: 'tenant/tenant.service.ts', method: 'suspendBusiness' },
  },
  'POST /tenant/activate': {
    handler: { file: 'tenant/tenant.controller.ts', method: 'activate' },
    writer: { file: 'tenant/tenant.service.ts', method: 'activateBusiness' },
  },

  // Channel credentials (G002).
  'POST /tenant/channels': {
    handler: { file: 'tenant/tenant.controller.ts', method: 'connectChannel' },
    writer: { file: 'tenant/tenant.service.ts', method: 'connectChannel' },
  },
  'DELETE /tenant/channels/:id': {
    handler: { file: 'tenant/tenant.controller.ts', method: 'disconnectChannel' },
    writer: { file: 'tenant/tenant.service.ts', method: 'disconnectChannel' },
  },
  'POST /channels/:channelType/connect': {
    handler: { file: 'channels/channels.controller.ts', method: 'connectChannel' },
    writer: { file: 'channels/channels.service.ts', method: 'connectChannel' },
  },
  'DELETE /channels/:channelId': {
    handler: { file: 'channels/channels.controller.ts', method: 'disconnectChannel' },
    writer: { file: 'channels/channels.service.ts', method: 'disconnectChannel' },
  },
};

const NO_STATE_CHANGE: Record<string, string> = {
  'POST /channels/:channelId/test':
    'Probes the provider with the stored credential and reports the result; ' +
    'writes nothing.',
  'POST /integrations/credentials/:provider/test':
    'Probes the provider with the stored credential and reports the result; ' +
    'writes nothing.',
  'POST /compliance/retention/run':
    'Triggers the retention sweep, whose erasures are each recorded by ' +
    'ComplianceService.eraseLead as SYSTEM. The trigger itself changes no row.',
};

const NOT_YET_AUDITED: Record<string, string> = {
  'PATCH /tenant/profile': 'Business profile edit; the row keeps only the latest value.',
  'PATCH /tenant/policies': 'Business policy edit; same shape as profile.',
  'PATCH /business/me': 'Business profile edit via the /business alias.',
  'PATCH /business/settings': 'Business settings edit via the /business alias.',
  'PATCH /tenant/ai-config':
    'Moves the AI auto-execute / review thresholds, which decides what the AI ' +
    'may send unreviewed. Worth a before/after row.',
  'PATCH /ai/confidence/thresholds': 'Same thresholds through the /ai route.',
  'POST /ai/knowledge': 'Knowledge ingestion; rows carry created_at but no actor.',
  'DELETE /ai/knowledge/:entryId': 'Knowledge removal.',
  'PATCH /tenant/channels/:id': 'Pause/resume a channel; toggles is_active only.',
  'PUT /integrations/credentials/:provider':
    'Stores a provider credential the same way channel connect does — the ' +
    'row is overwritten in place. Same class as the channel fix; next round.',
  'POST /integrations/google-calendar/connect': 'Stores an OAuth grant.',
  'DELETE /integrations/google-calendar': 'Removes an OAuth grant.',
  'POST /realty/integrations/crm/connect':
    'Stores a CRM credential. RealtyAuditInterceptor may cover this route; ' +
    'confirm before adding an explicit record.',
  'DELETE /realty/integrations/crm/:provider': 'Removes a CRM credential; as above.',
  'DELETE /realty/integrations/sheets': 'Removes a Sheets connection; as above.',
  'POST /tenant/subscription/change':
    'Plan change through SubscriptionService rather than BillingService; ' +
    'the billing route is audited, this alias is not.',
  'POST /sla/policies': 'SLA policy create.',
  'PATCH /sla/policies/:id': 'SLA policy edit.',
  'DELETE /sla/policies/:id': 'SLA policy delete (soft).',
};

// ─────────────────────────────────────────────
// Reading the sibling contract and the source
// ─────────────────────────────────────────────

/** `METHOD /path` for every write route in privileged-route-contract's GATED. */
function gatedWriteRoutes(): string[] {
  const src = fs.readFileSync(path.join(MODULES, 'privileged-route-contract.spec.ts'), 'utf8');
  const start = src.indexOf('const GATED');
  const end = src.indexOf('\n];', start);
  const block = src.slice(start, end).replace(/\s+/g, ' ');

  const routes: string[] = [];
  for (const m of block.matchAll(/\[ ?'((?:POST|PUT|PATCH|DELETE|GET) [^']+)'/g)) {
    const route = m[1] as string;
    if (!route.startsWith('GET ')) routes.push(route);
  }
  return routes;
}

/**
 * Source of one method on a class: from its declaration to the matching
 * closing brace. Decorators on the line(s) above are included so a handler's
 * parameter decorators are visible.
 */
function methodSource(file: string, method: string): string {
  const full = path.join(MODULES, file);
  const src = fs.readFileSync(full, 'utf8');
  const decl = new RegExp(`^ {2}(?:public |private |protected )?(?:async )?${method}\\s*\\(`, 'm');
  const m = decl.exec(src);
  if (!m) throw new Error(`${file} has no method "${method}"`);

  // Walk to the end of the parameter list, then to the end of the body.
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) break;
  }
  const paramsEnd = i;
  const bodyOpen = src.indexOf('{', paramsEnd);
  depth = 0;
  for (i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(m.index, i + 1);
}

function params(source: string): string {
  const open = source.indexOf('(');
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open, i + 1);
  }
  return '';
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('privileged-audit contract', () => {
  const gated = gatedWriteRoutes();

  it('reads the GATED write routes from privileged-route-contract', () => {
    expect(gated.length).toBeGreaterThan(30);
  });

  it('classifies every GATED write route exactly once', () => {
    const classified = new Map<string, string>();
    for (const [list, routes] of [
      ['AUDITED', Object.keys(AUDITED)],
      ['NO_STATE_CHANGE', Object.keys(NO_STATE_CHANGE)],
      ['NOT_YET_AUDITED', Object.keys(NOT_YET_AUDITED)],
    ] as const) {
      for (const r of routes) {
        expect(classified.has(r) ? `${r} is in both ${classified.get(r)} and ${list}` : '').toBe('');
        classified.set(r, list);
      }
    }

    const unclassified = gated.filter((r) => !classified.has(r));
    expect(
      unclassified.length === 0
        ? ''
        : 'GATED routes with no audit classification — add each to AUDITED (and make ' +
            'it record), NO_STATE_CHANGE, or NOT_YET_AUDITED with the reason:\n  ' +
            unclassified.join('\n  '),
    ).toBe('');

    const stale = [...classified.keys()].filter((r) => !gated.includes(r));
    expect(
      stale.length === 0 ? '' : `Classified routes no longer in GATED:\n  ${stale.join('\n  ')}`,
    ).toBe('');
  });

  describe.each(Object.entries(AUDITED))('%s', (_route, { handler, writer }) => {
    it(`${writer.file} ${writer.method}() writes an audit row`, () => {
      const body = methodSource(writer.file, writer.method);
      expect(body).toMatch(/\baudit\.record\(/);
    });

    it(`${handler.file} ${handler.method}() takes the acting user`, () => {
      const signature = params(methodSource(handler.file, handler.method));
      expect(signature).toMatch(/@CurrentUser\(\)/);
    });
  });

  it('states a reason for every known gap', () => {
    const thin = Object.entries(NOT_YET_AUDITED)
      .filter(([, reason]) => reason.length <= 15)
      .map(([route]) => route);
    expect(thin).toEqual([]);
  });
});
