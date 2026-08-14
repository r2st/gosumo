/**
 * Settings → Team.
 *
 * This page decides who is allowed to see which control, and getting that
 * wrong is the interesting failure — not a missing label. The API splits the
 * verbs two ways: invite and remove are `@Roles(MANAGER)`, changing a role is
 * `@Roles(OWNER)`. So there are three distinct viewers to check, and a MANAGER
 * (who can remove people but not re-rank them) is the one a naive
 * `canManage`-everywhere implementation would get wrong.
 *
 * The other thing worth pinning is the OWNER row: an owner must never be
 * offered a role dropdown or a remove button, even to another owner, because
 * the server would reject it and the page would be advertising an action that
 * cannot happen. That guard is independent of the viewer's own role, so it is
 * asserted from the OWNER seat where every other control *is* available.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, TeamMember } from '@/lib/feature-types';

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    id: 'member-1',
    email: 'priya@sunrise.in',
    name: 'Priya Nair',
    role: 'STAFF',
    status: 'ACTIVE',
    lastActiveAt: '2026-08-14T06:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const OWNER = makeMember({ id: 'owner-1', name: 'Anita Rao', email: 'anita@sunrise.in', role: 'OWNER' });

const teamQuery = {
  data: undefined as { data: TeamMember[] } | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
};

const invite = { mutate: vi.fn(), isPending: false, isError: false };
const updateRole = { mutate: vi.fn(), isPending: false };
const removeMember = { mutate: vi.fn(), isPending: false };
let role: Role = 'OWNER';

vi.mock('@/hooks/use-settings', () => ({
  useTeam: () => teamQuery,
  useInviteMember: () => invite,
  useUpdateMemberRole: () => updateRole,
  useRemoveMember: () => removeMember,
}));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

import TeamPage from './page';

/** The row for a member, found by the name cell rather than by index. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  teamQuery.data = { data: [OWNER, makeMember()] };
  teamQuery.isLoading = false;
  teamQuery.isError = false;
  invite.isPending = false;
  invite.isError = false;
  updateRole.isPending = false;
  removeMember.isPending = false;
  role = 'OWNER';
});

describe('TeamPage — query states', () => {
  it('shows the spinner while the roster loads', () => {
    teamQuery.isLoading = true;
    teamQuery.data = undefined;

    render(<TeamPage />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('offers a retry when the roster fails to load', () => {
    teamQuery.isError = true;
    teamQuery.data = undefined;

    render(<TeamPage />);
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));

    expect(teamQuery.refetch).toHaveBeenCalled();
  });

  it('treats a successful-but-empty response as an error, not an empty team', () => {
    // A business always has at least its owner. `data` being absent while
    // `isError` is false means the request resolved to nothing usable, and
    // rendering `data.data` would throw.
    teamQuery.data = undefined;

    render(<TeamPage />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows the empty state when the roster comes back with no rows', () => {
    teamQuery.data = { data: [] };

    render(<TeamPage />);

    expect(screen.getByText('No team members yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('TeamPage — the roster', () => {
  it('renders each member with their contact details and last activity', () => {
    render(<TeamPage />);

    const row = rowFor('Priya Nair');
    expect(within(row).getByText('priya@sunrise.in')).toBeInTheDocument();
    expect(within(row).getByText('Active')).toBeInTheDocument();
    // Not the raw ISO string — the roster reads in relative time.
    expect(within(row).queryByText('2026-08-14T06:00:00.000Z')).not.toBeInTheDocument();
  });

  it('dashes out a member who has never signed in', () => {
    teamQuery.data = { data: [makeMember({ lastActiveAt: undefined })] };

    render(<TeamPage />);

    expect(within(rowFor('Priya Nair')).getByText('—')).toBeInTheDocument();
  });

  it.each([
    ['INVITED' as const, 'Invited'],
    ['SUSPENDED' as const, 'Suspended'],
  ])('labels a %s member as "%s"', (status, label) => {
    teamQuery.data = { data: [makeMember({ status })] };

    render(<TeamPage />);

    expect(within(rowFor('Priya Nair')).getByText(label)).toBeInTheDocument();
  });

  it('describes every assignable role, and never offers OWNER as one', () => {
    render(<TeamPage />);

    expect(screen.getByText('Manage conversations, catalog, settings and AI config.')).toBeInTheDocument();
    expect(screen.getByText('Handle conversations and review HITL tasks.')).toBeInTheDocument();
    expect(screen.getByText('Read-only access to dashboards and reports.')).toBeInTheDocument();
    // Ownership transfer is not a role change; it must not appear in the
    // dropdown that maps straight onto PATCH /auth/team/:id/role.
    const select = within(rowFor('Priya Nair')).getByRole('combobox');
    expect(within(select).queryByText('Owner')).not.toBeInTheDocument();
  });
});

describe('TeamPage — the owner row is immutable', () => {
  it('shows the owner a badge instead of a dropdown, even to another owner', () => {
    render(<TeamPage />);

    const row = rowFor('Anita Rao');
    expect(within(row).getByText('Owner')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('never offers to remove the owner', () => {
    render(<TeamPage />);

    expect(screen.queryByLabelText('Remove Anita Rao')).not.toBeInTheDocument();
    // …while a regular member is removable from the same seat, so the absence
    // above is about the owner and not about the viewer.
    expect(screen.getByLabelText('Remove Priya Nair')).toBeInTheDocument();
  });
});

describe('TeamPage — what each seat may do', () => {
  it('lets an OWNER change a role and sends the new one', () => {
    render(<TeamPage />);

    fireEvent.change(within(rowFor('Priya Nair')).getByRole('combobox'), {
      target: { value: 'MANAGER' },
    });

    expect(updateRole.mutate).toHaveBeenCalledWith({ memberId: 'member-1', role: 'MANAGER' });
  });

  it('locks the dropdown while a role change is in flight', () => {
    // Two overlapping PATCHes on the same roster would race, and the loser
    // would silently win the refetch.
    updateRole.isPending = true;

    render(<TeamPage />);

    expect(within(rowFor('Priya Nair')).getByRole('combobox')).toBeDisabled();
  });

  it('gives a MANAGER the invite and remove controls but not the role dropdown', () => {
    role = 'MANAGER';

    render(<TeamPage />);

    expect(screen.getByRole('button', { name: /invite member/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Priya Nair')).toBeInTheDocument();
    // PATCH /role is OWNER-only; a dropdown here would only ever 403.
    expect(within(rowFor('Priya Nair')).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(rowFor('Priya Nair')).getByText('Staff')).toBeInTheDocument();
  });

  it('gives a VIEWER nothing but the roster', () => {
    role = 'VIEWER';

    render(<TeamPage />);

    expect(screen.queryByRole('button', { name: /invite member/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remove Priya Nair')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
  });
});

describe('TeamPage — removing a member', () => {
  it('names the member in the confirmation before anything is sent', () => {
    render(<TeamPage />);
    fireEvent.click(screen.getByLabelText('Remove Priya Nair'));

    expect(screen.getByText('Priya Nair will lose access immediately.')).toBeInTheDocument();
    expect(removeMember.mutate).not.toHaveBeenCalled();
  });

  it('sends the removal and closes the dialog once it lands', () => {
    render(<TeamPage />);
    fireEvent.click(screen.getByLabelText('Remove Priya Nair'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(removeMember.mutate).toHaveBeenCalledWith('member-1', expect.any(Object));

    const [, opts] = removeMember.mutate.mock.calls[0] as [string, { onSuccess: () => void }];
    act(() => opts.onSuccess());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open when the removal fails', () => {
    render(<TeamPage />);
    fireEvent.click(screen.getByLabelText('Remove Priya Nair'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    // `onSuccess` is the only thing that closes it — a rejected mutation
    // leaves the operator looking at the confirmation, which is right.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('backs out without sending anything on cancel', () => {
    render(<TeamPage />);
    fireEvent.click(screen.getByLabelText('Remove Priya Nair'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(removeMember.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('TeamPage — inviting a member', () => {
  function openInvite() {
    render(<TeamPage />);
    fireEvent.click(screen.getByRole('button', { name: /invite member/i }));
  }

  it('defaults a new invite to STAFF rather than the most privileged role', () => {
    openInvite();

    expect(screen.getByRole('combobox', { name: /role/i })).toHaveValue('STAFF');
  });

  it('sends exactly what was typed', () => {
    openInvite();
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Vikram Shah' } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'vikram@sunrise.in' } });
    fireEvent.change(screen.getByRole('combobox', { name: /role/i }), {
      target: { value: 'MANAGER' },
    });
    fireEvent.submit(screen.getByRole('button', { name: /send invite/i }).closest('form') ?? document.forms[0]!);

    expect(invite.mutate).toHaveBeenCalledWith(
      { name: 'Vikram Shah', email: 'vikram@sunrise.in', role: 'MANAGER' },
      expect.any(Object),
    );
  });

  it('clears the form on success so the next invite does not inherit the last one', () => {
    openInvite();
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Vikram Shah' } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'vikram@sunrise.in' } });
    fireEvent.submit(document.querySelector('#invite-form')!);

    const [, opts] = invite.mutate.mock.calls[0] as [unknown, { onSuccess: () => void }];
    act(() => opts.onSuccess());

    // Dialog closed…
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // …and reopening starts clean, not on Vikram.
    fireEvent.click(screen.getByRole('button', { name: /invite member/i }));
    expect(screen.getByLabelText(/full name/i)).toHaveValue('');
    expect(screen.getByLabelText(/^email$/i)).toHaveValue('');
  });

  it('surfaces a failed invite instead of pretending it was sent', () => {
    invite.isError = true;
    openInvite();

    expect(screen.getByText(/couldn’t send the invite/i)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on cancel without sending', () => {
    openInvite();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(invite.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
