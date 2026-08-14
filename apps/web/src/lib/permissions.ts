/**
 * What the signed-in operator is allowed to change.
 *
 * This mirrors the API's `RolesGuard` (apps/api/src/modules/auth/guards/
 * roles.guard.ts) so the dashboard offers exactly the actions the server will
 * accept. The server is the authority — nothing here is a security control.
 * Hiding a control the API would 403 is a UI concern: a VIEWER who is shown a
 * "Delete" button learns the rule by being refused.
 *
 * The guard's rules, restated:
 *
 *  - **Reads are open** to every authenticated role.
 *  - **Writes require STAFF or above by default.** Any POST/PUT/PATCH/DELETE
 *    with no `@Roles()` is closed to VIEWER. This is the common case and the
 *    reason {@link canWrite} exists.
 *  - **Configuration surfaces are MANAGER+** — business profile and settings,
 *    AI config and thresholds, channel connect/disconnect, the credential-
 *    holding integrations, API keys, SLA policies, team invite/remove.
 *  - **Ownership surfaces are OWNER** — plan changes and billing, suspend and
 *    activate, compliance settings and retention runs, changing a member role.
 *  - **Self-service writes are open to everyone** — logout, password change,
 *    revoking your own session. A VIEWER who could not sign out would be
 *    trapped. These carry `@SelfService()` on the API and are deliberately not
 *    gated here.
 *
 * Keep the tiers below in step with the `@Roles()` decorators; the guard is a
 * rank comparison, so `canManage` admits OWNER and `canWrite` admits everyone
 * except VIEWER.
 */
import type { Role } from './feature-types';

/**
 * Higher number = more authority, matching `ROLE_HIERARCHY` in
 * apps/api/src/modules/auth/role-hierarchy.ts.
 */
export const ROLE_HIERARCHY: Record<Role, number> = {
  VIEWER: 0,
  STAFF: 1,
  MANAGER: 2,
  OWNER: 3,
};

/**
 * Rank of `role`, or `-1` for anything unrecognised.
 *
 * Unknown ranks *below* VIEWER rather than throwing, exactly as the API does.
 * A session carrying a role this build has never heard of — an older bundle
 * against a newer API, say — should fail every comparison and be shown a
 * read-only dashboard, not crash the render or be handed write controls.
 */
export function roleRank(role: string | null | undefined): number {
  if (!role) return -1;
  return ROLE_HIERARCHY[role as Role] ?? -1;
}

/** True when `role` ranks at or above `minimum`. */
export function atLeast(role: string | null | undefined, minimum: Role): boolean {
  const rank = roleRank(role);
  return rank >= 0 && rank >= ROLE_HIERARCHY[minimum];
}

/**
 * May mutate business data — the guard's default tier for an undecorated
 * write. Everyone except VIEWER (and an unknown role).
 */
export function canWrite(role: string | null | undefined): boolean {
  return atLeast(role, 'STAFF');
}

/** May change configuration: channels, AI config, integrations, team, API keys. */
export function canManage(role: string | null | undefined): boolean {
  return atLeast(role, 'MANAGER');
}

/** May change ownership-level settings: plan and billing, compliance, roles. */
export function canOwn(role: string | null | undefined): boolean {
  return atLeast(role, 'OWNER');
}

/**
 * True for a role that may not write anything — VIEWER, or a role this build
 * does not recognise. Use for the read-only banner; use {@link canWrite} to
 * decide whether to render a specific control.
 */
export function isReadOnly(role: string | null | undefined): boolean {
  return !canWrite(role);
}
