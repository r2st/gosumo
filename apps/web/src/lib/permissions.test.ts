/**
 * The capability tiers must agree with the API's RolesGuard.
 *
 * These are the rules the dashboard uses to decide whether to render a write
 * control. They are not a security boundary — the server refuses the call
 * regardless — but when they drift, a VIEWER is shown buttons that always 403,
 * or an OWNER loses controls they are entitled to. Both are silent until
 * someone reports them, so they are pinned here.
 *
 * The mirrored source is apps/api/src/modules/auth/guards/roles.guard.ts and
 * apps/api/src/modules/auth/role-hierarchy.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  ROLE_HIERARCHY,
  atLeast,
  canManage,
  canOwn,
  canWrite,
  isReadOnly,
  roleRank,
} from './permissions';
import type { Role } from './feature-types';

const ALL_ROLES: Role[] = ['OWNER', 'MANAGER', 'STAFF', 'VIEWER'];

describe('roleRank', () => {
  it('orders the roles the way the API does', () => {
    // Same table as ROLE_HIERARCHY in the API's role-hierarchy.ts.
    expect(ROLE_HIERARCHY).toEqual({ VIEWER: 0, STAFF: 1, MANAGER: 2, OWNER: 3 });
  });

  it.each(ALL_ROLES)('ranks %s at or above zero', (role) => {
    expect(roleRank(role)).toBeGreaterThanOrEqual(0);
  });

  it.each([
    ['an unknown role', 'SUPERUSER'],
    ['the empty string', ''],
    ['a lowercased role', 'owner'],
  ])('ranks %s below VIEWER', (_label, role) => {
    // Below VIEWER, not equal to it: an unrecognised role must fail every
    // comparison rather than inherit read-only's privileges by accident.
    expect(roleRank(role)).toBe(-1);
  });

  it('ranks null and undefined below VIEWER', () => {
    expect(roleRank(null)).toBe(-1);
    expect(roleRank(undefined)).toBe(-1);
  });
});

describe('atLeast', () => {
  it('admits a role above the minimum', () => {
    expect(atLeast('OWNER', 'MANAGER')).toBe(true);
  });

  it('admits a role equal to the minimum', () => {
    expect(atLeast('MANAGER', 'MANAGER')).toBe(true);
  });

  it('refuses a role below the minimum', () => {
    expect(atLeast('STAFF', 'MANAGER')).toBe(false);
  });

  it('refuses an unrecognised role even against the lowest tier', () => {
    // roleRank returns -1, which would compare >= VIEWER's 0 as false — but
    // only because atLeast rejects negative ranks outright. Guard that.
    expect(atLeast('SUPERUSER', 'VIEWER')).toBe(false);
    expect(atLeast(null, 'VIEWER')).toBe(false);
  });
});

describe('canWrite — the guard default for an undecorated write', () => {
  it.each(['OWNER', 'MANAGER', 'STAFF'] as Role[])('admits %s', (role) => {
    expect(canWrite(role)).toBe(true);
  });

  it('refuses VIEWER', () => {
    // This is the whole point: VIEWER is read-only across the API.
    expect(canWrite('VIEWER')).toBe(false);
  });

  it('refuses an unknown role and a missing session', () => {
    expect(canWrite('SUPERUSER')).toBe(false);
    expect(canWrite(null)).toBe(false);
    expect(canWrite(undefined)).toBe(false);
  });
});

describe('canManage — the configuration tier', () => {
  it.each(['OWNER', 'MANAGER'] as Role[])('admits %s', (role) => {
    expect(canManage(role)).toBe(true);
  });

  it.each(['STAFF', 'VIEWER'] as Role[])('refuses %s', (role) => {
    expect(canManage(role)).toBe(false);
  });
});

describe('canOwn — the ownership tier', () => {
  it('admits only OWNER', () => {
    expect(canOwn('OWNER')).toBe(true);
    expect(canOwn('MANAGER')).toBe(false);
    expect(canOwn('STAFF')).toBe(false);
    expect(canOwn('VIEWER')).toBe(false);
  });
});

describe('tier nesting', () => {
  it.each(ALL_ROLES)('never grants %s a higher tier than a lower one', (role) => {
    // A role that can manage must also be able to write; one that can own must
    // also be able to manage. Any inversion means the tiers were edited apart.
    if (canOwn(role)) expect(canManage(role)).toBe(true);
    if (canManage(role)) expect(canWrite(role)).toBe(true);
  });

  it('treats isReadOnly as the exact complement of canWrite', () => {
    for (const role of [...ALL_ROLES, 'SUPERUSER', null, undefined]) {
      expect(isReadOnly(role)).toBe(!canWrite(role));
    }
  });
});
