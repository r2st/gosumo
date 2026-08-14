'use client';

import { useMemo } from 'react';
import { useOptionalAuth } from '@/providers/auth-provider';
import { canManage, canOwn, canWrite, isReadOnly } from '@/lib/permissions';
import type { Role } from '@/lib/feature-types';

export interface Permissions {
  /** The signed-in operator's role, or null while the session is loading. */
  role: Role | null;
  /** May mutate business data — everyone except VIEWER. */
  canWrite: boolean;
  /** May change configuration — MANAGER and OWNER. */
  canManage: boolean;
  /** May change plan, billing, compliance and member roles — OWNER only. */
  canOwn: boolean;
  /** True for VIEWER (and unrecognised roles). Drives the read-only banner. */
  isReadOnly: boolean;
}

/**
 * The current operator's capabilities, mirroring the API's `RolesGuard`.
 *
 * Prefer this over comparing `user.role` inline: the tiers live in one place
 * (`@/lib/permissions`) so a change to the guard is a change to one file here
 * rather than a hunt through every page that happens to render a button.
 *
 * While the session is still loading `role` is null, which ranks below VIEWER
 * and yields no capabilities. Controls stay hidden for the moment before the
 * role is known rather than flashing in and disappearing — and the same holds
 * with no AuthProvider above at all, so a component that only hides a button
 * by role stays renderable on its own.
 */
export function usePermissions(): Permissions {
  const auth = useOptionalAuth();
  const role = auth?.user?.role ?? null;

  return useMemo(
    () => ({
      role,
      canWrite: canWrite(role),
      canManage: canManage(role),
      canOwn: canOwn(role),
      isReadOnly: isReadOnly(role),
    }),
    [role],
  );
}
