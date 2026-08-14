/**
 * The single source of truth for GoSumo's role ordering.
 *
 * Both the RolesGuard (which gates a request on the JWT's role) and the team
 * management handlers (which stop a caller granting a role above their own)
 * rank roles. Keeping one table means an added role cannot be understood by
 * one of them and ignored by the other.
 *
 * Higher number = more authority. A role implicitly holds every authority
 * below it: OWNER > MANAGER > STAFF > VIEWER.
 */
export const ROLE_HIERARCHY: Record<string, number> = {
  VIEWER: 0,
  STAFF: 1,
  MANAGER: 2,
  OWNER: 3,
};

/**
 * Rank of `role`, or `-1` for anything not in the hierarchy.
 *
 * The unknown case deliberately ranks *below* VIEWER rather than throwing: a
 * token carrying a role this build has never heard of should fail every
 * comparison, not crash the request or — worse — pass one.
 */
export function roleRank(role: string | null | undefined): number {
  if (!role) return -1;
  return ROLE_HIERARCHY[role] ?? -1;
}
