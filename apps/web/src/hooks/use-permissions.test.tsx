/**
 * `use-permissions.ts` — the operator's capabilities, mirroring the API's
 * `RolesGuard`.
 *
 * The tier boundaries themselves (which role clears which bar) are covered in
 * `src/lib/permissions.test.ts`. This file is about the three things the *hook*
 * adds on top of those functions, each of which is a way for a correct tier
 * table to still produce a wrong button:
 *
 *  - **The loading window.** `role` is null while the session bootstraps. Every
 *    capability must read false, or write controls flash in and disappear —
 *    and an operator who clicks in that window gets a 403 for an action the UI
 *    just offered them.
 *  - **No provider at all.** `useOptionalAuth` returns null rather than
 *    throwing, so a component that only hides a button by role stays
 *    renderable in isolation. It must degrade to read-only, not to an
 *    exception and not to full access.
 *  - **The memo.** The returned object is consumed in dependency arrays and
 *    passed to memoised children. A fresh object every render would defeat
 *    both.
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@/lib/feature-types';

import { usePermissions } from './use-permissions';

/** What the mocked provider currently reports. `undefined` = no provider. */
let currentRole: Role | null | undefined | string = null;
let hasProvider = true;

vi.mock('@/providers/auth-provider', () => ({
  useOptionalAuth: () =>
    hasProvider
      ? {
          status: 'authenticated' as const,
          user:
            currentRole === null || currentRole === undefined
              ? null
              : { id: 'u1', email: 'me@acme.in', name: 'Me', role: currentRole, businessId: 'b1' },
          business: null,
        }
      : null,
}));

beforeEach(() => {
  currentRole = null;
  hasProvider = true;
});

describe('every role gets exactly the capabilities the guard admits', () => {
  it.each([
    // role      write   manage  own     readOnly
    ['OWNER', true, true, true, false],
    ['MANAGER', true, true, false, false],
    ['STAFF', true, false, false, false],
    ['VIEWER', false, false, false, true],
  ])('%s', (role, canWrite, canManage, canOwn, isReadOnly) => {
    currentRole = role as Role;
    const { result } = renderHook(() => usePermissions());

    expect(result.current).toEqual({ role, canWrite, canManage, canOwn, isReadOnly });
  });
});

describe('an unknown session yields no capabilities', () => {
  it('offers nothing while the session is still loading', () => {
    // The shell renders before `/auth/me` resolves. Granting anything here
    // means a Save button that appears, is clicked, and 403s — or one that
    // flashes in and vanishes as the real role arrives.
    currentRole = null;
    const { result } = renderHook(() => usePermissions());

    expect(result.current).toEqual({
      role: null,
      canWrite: false,
      canManage: false,
      canOwn: false,
      isReadOnly: true,
    });
  });

  it('degrades to read-only with no AuthProvider above it', () => {
    // `useOptionalAuth` returns null rather than throwing so a component that
    // merely hides a button by role can be rendered on its own. Read-only is
    // the safe reading of "no session".
    hasProvider = false;
    const { result } = renderHook(() => usePermissions());

    expect(result.current.role).toBeNull();
    expect(result.current.isReadOnly).toBe(true);
    expect(result.current.canWrite).toBe(false);
  });

  it('treats a role this build has never heard of as read-only', () => {
    // An older bundle against a newer API can receive a role that is not in
    // `ROLE_HIERARCHY`. It ranks below VIEWER rather than throwing, so the
    // operator gets a read-only dashboard instead of a blank page — or, worse,
    // write controls granted by a failed comparison.
    currentRole = 'SUPERADMIN';
    const { result } = renderHook(() => usePermissions());

    expect(result.current).toMatchObject({
      role: 'SUPERADMIN',
      canWrite: false,
      canManage: false,
      canOwn: false,
      isReadOnly: true,
    });
  });

  it('reports a null role when the session has no user', () => {
    currentRole = undefined;
    const { result } = renderHook(() => usePermissions());

    expect(result.current.role).toBeNull();
  });
});

describe('the returned object is stable across renders', () => {
  it('does not allocate a new object when nothing changed', () => {
    // Callers put this in dependency arrays and pass it to memoised children.
    // A fresh object each render would re-run those effects on every keystroke
    // elsewhere in the tree.
    currentRole = 'MANAGER';
    const { result, rerender } = renderHook(() => usePermissions());
    const first = result.current;

    rerender();
    rerender();

    expect(result.current).toBe(first);
  });

  it('recomputes when the operator’s role actually changes', () => {
    // The memo is keyed on `role`, so a role change — a re-login as someone
    // else, or a role edit applied to the current session — must flow through
    // rather than being pinned by the memo.
    currentRole = 'VIEWER';
    const { result, rerender } = renderHook(() => usePermissions());
    expect(result.current.canWrite).toBe(false);

    currentRole = 'STAFF';
    rerender();

    expect(result.current.canWrite).toBe(true);
    expect(result.current.isReadOnly).toBe(false);
  });
});

describe('isReadOnly is the exact complement of canWrite', () => {
  it.each([['OWNER'], ['MANAGER'], ['STAFF'], ['VIEWER'], ['SUPERADMIN']])(
    'holds for %s',
    (role) => {
      // The banner reads from `isReadOnly` and the controls from `canWrite`.
      // If they could ever disagree, an operator would see a read-only banner
      // above buttons that work, or the reverse.
      currentRole = role;
      const { result } = renderHook(() => usePermissions());

      expect(result.current.isReadOnly).toBe(!result.current.canWrite);
    },
  );

  it('holds while the session is loading too', () => {
    currentRole = null;
    const { result } = renderHook(() => usePermissions());

    expect(result.current.isReadOnly).toBe(!result.current.canWrite);
  });
});

describe('the tiers nest, so a higher role never loses a lower one’s rights', () => {
  it.each([
    ['OWNER', 'MANAGER'],
    ['MANAGER', 'STAFF'],
  ])('%s can do everything %s can', (higher, lower) => {
    currentRole = lower as Role;
    const { result: lowerResult, rerender } = renderHook(() => usePermissions());
    const lowerPerms = { ...lowerResult.current };

    currentRole = higher as Role;
    rerender();

    for (const cap of ['canWrite', 'canManage', 'canOwn'] as const) {
      if (lowerPerms[cap]) expect(lowerResult.current[cap]).toBe(true);
    }
  });
});
