/**
 * The team settings page offers only what the API will actually accept.
 *
 * The API used to let any authenticated member invite, promote, and remove
 * teammates, so the page rendered every control for everyone. Now that
 * `@Roles()` is enforced server-side, an ungated page would show a STAFF user
 * an invite button that always comes back 403.
 *
 * This is presentation, not a security control — the server is the authority.
 * These tests check that the two agree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UserRole } from '@/lib/types';

const members = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Priya Sharma',
    email: 'priya@acme.in',
    role: 'OWNER',
    status: 'ACTIVE',
    avatarUrl: null,
    lastActiveAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Rahul Verma',
    email: 'rahul@acme.in',
    role: 'STAFF',
    status: 'ACTIVE',
    avatarUrl: null,
    lastActiveAt: null,
    createdAt: '2026-01-02T00:00:00.000Z',
  },
];

let currentRole: UserRole = 'OWNER';

const authValue = () => ({
  status: 'authenticated' as const,
  user: { id: 'me', email: 'me@acme.in', name: 'Me', role: currentRole, businessId: 'b1' },
  business: null,
});

// The page reads the role through usePermissions, which uses the non-throwing
// accessor so a missing provider means read-only rather than a crash. Both are
// mocked so the test does not depend on which one the page happens to call.
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => authValue(),
  useOptionalAuth: () => authValue(),
}));

vi.mock('@/hooks/use-settings', () => ({
  useTeam: () => ({
    data: {
      data: members,
      pagination: { total: members.length, limit: 100, page: 1, totalPages: 1 },
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useInviteMember: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useRemoveMember: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateMemberRole: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Imported after the mocks so the module picks them up.
const { default: TeamPage } = await import('@/app/(dashboard)/settings/team/page');

function renderAs(role: UserRole) {
  currentRole = role;
  render(<TeamPage />);
}

describe('team settings page — role gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers invite and remove to an owner', () => {
    renderAs('OWNER');
    expect(screen.getByRole('button', { name: /invite member/i })).toBeTruthy();
    expect(screen.getByLabelText('Remove Rahul Verma')).toBeTruthy();
  });

  it('offers invite and remove to a manager', () => {
    // MANAGER is what the API admits for invite and remove.
    renderAs('MANAGER');
    expect(screen.getByRole('button', { name: /invite member/i })).toBeTruthy();
    expect(screen.getByLabelText('Remove Rahul Verma')).toBeTruthy();
  });

  it('offers neither to a staff member', () => {
    renderAs('STAFF');
    expect(screen.queryByRole('button', { name: /invite member/i })).toBeNull();
    expect(screen.queryByLabelText('Remove Rahul Verma')).toBeNull();
  });

  it('lets only an owner change a role', () => {
    // The role dropdown maps to PATCH /auth/team/:id/role, which is owner-only.
    renderAs('OWNER');
    expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
  });

  it('shows a manager the roles as read-only text, not a dropdown', () => {
    renderAs('MANAGER');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Staff')).toBeTruthy();
  });

  it('still lists every member for a staff viewer', () => {
    // Reading the team is deliberately open — only the mutations are gated.
    renderAs('STAFF');
    expect(screen.getByText('Priya Sharma')).toBeTruthy();
    expect(screen.getByText('Rahul Verma')).toBeTruthy();
  });
});
