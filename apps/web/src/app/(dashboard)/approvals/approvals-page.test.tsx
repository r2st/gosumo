/**
 * ApprovalsPage — the AI confidence review queue.
 *
 * This is the surface where the platform's confidence routing becomes visible:
 * >=90% auto-executes and never lands here, 70–89% queues as a draft for
 * review, <70% escalates. The queue therefore has to display the score
 * honestly — an operator approving a draft is taking responsibility for it, and
 * the confidence badge is the only cue for how much scrutiny it needs.
 *
 * Band boundaries are asserted on both sides of each threshold, because they
 * are `>=` comparisons that a refactor silently turns into `>`.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Approval } from '@/lib/realty-types';
import type { Role } from '@/lib/feature-types';

let currentRole: Role | null = 'STAFF';

const authValue = () => ({
  status: 'authenticated' as const,
  user: currentRole
    ? {
        id: 'u1',
        email: 'me@acme.in',
        name: 'Me',
        role: currentRole,
        businessId: 'b1',
        twoFactorEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }
    : null,
  business: null,
});

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => authValue(),
  useOptionalAuth: () => authValue(),
}));

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'a1',
    leadId: 'l1',
    conversationId: 'c1',
    draftText: 'Yes, the 2BHK in Powai is available for a visit this Saturday.',
    editedText: null,
    confidence: 82,
    intent: 'SITE_VISIT',
    status: 'PENDING',
    reviewedBy: null,
    reviewedAt: null,
    reason: null,
    createdAt: '2026-08-14T04:00:00.000Z',
    ...overrides,
  };
}

const state = {
  approvals: {
    data: [makeApproval()] as Approval[] | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  resolve: { mutate: vi.fn(), isPending: false },
};

let approvalFilters: unknown[] = [];

vi.mock('@/hooks/use-realty', () => ({
  useApprovals: (filters: unknown) => {
    approvalFilters.push(filters);
    return state.approvals;
  },
  useResolveApproval: () => state.resolve,
}));

const { default: ApprovalsPage } = await import('./page');

beforeEach(() => {
  currentRole = 'STAFF';
  approvalFilters = [];
  state.approvals = {
    data: [makeApproval()],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  state.resolve = { mutate: vi.fn(), isPending: false };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApprovalsPage — load states', () => {
  it('only asks for the PENDING queue', () => {
    render(<ApprovalsPage />);
    expect(approvalFilters[0]).toEqual({ status: 'PENDING' });
  });

  it('shows a loading state while the queue resolves', () => {
    state.approvals.isLoading = true;
    render(<ApprovalsPage />);
    expect(screen.getByText('Loading approval queue…')).toBeInTheDocument();
  });

  it('shows an error state with a retry when the queue fails', () => {
    state.approvals.isError = true;
    render(<ApprovalsPage />);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(state.approvals.refetch).toHaveBeenCalledTimes(1);
  });

  it('says the queue is clear when nothing is waiting', () => {
    state.approvals.data = [];
    render(<ApprovalsPage />);
    expect(screen.getByText('Queue is clear')).toBeInTheDocument();
  });

  it('treats a missing payload as an empty queue, not a crash', () => {
    state.approvals.data = undefined;
    render(<ApprovalsPage />);
    expect(screen.getByText('Queue is clear')).toBeInTheDocument();
  });

  it('explains the routing rule in the empty state, so a clear queue is not alarming', () => {
    state.approvals.data = [];
    render(<ApprovalsPage />);
    expect(screen.getByText(/High-confidence replies send automatically/)).toBeInTheDocument();
  });
});

describe('ApprovalsPage — AI confidence display', () => {
  it('shows the confidence score on the draft', () => {
    render(<ApprovalsPage />);
    expect(screen.getByText('82% confidence')).toBeInTheDocument();
  });

  // The three routing bands from the platform's confidence rules. `success` is
  // the auto-execute band, `warning` the review band, `danger` the escalate band.
  it.each([
    [100, 'bg-emerald-500/15'],
    [90, 'bg-emerald-500/15'],
    [89, 'bg-amber-500/15'],
    [70, 'bg-amber-500/15'],
    [69, 'bg-rose-500/15'],
    [0, 'bg-rose-500/15'],
  ])('tones a %i%% score with %s', (confidence, toneClass) => {
    state.approvals.data = [makeApproval({ confidence })];
    render(<ApprovalsPage />);
    expect(screen.getByText(`${confidence}% confidence`).className).toContain(toneClass);
  });

  it('shows the detected intent alongside the score', () => {
    render(<ApprovalsPage />);
    expect(screen.getByText('SITE_VISIT')).toBeInTheDocument();
  });

  it('omits the intent badge when the AI did not classify one', () => {
    state.approvals.data = [makeApproval({ intent: null })];
    render(<ApprovalsPage />);

    expect(screen.getByText('82% confidence')).toBeInTheDocument();
    expect(screen.queryByText('SITE_VISIT')).not.toBeInTheDocument();
  });

  it('shows the draft text the operator is being asked to vouch for', () => {
    render(<ApprovalsPage />);
    expect(screen.getByText(/2BHK in Powai/)).toBeInTheDocument();
  });

  it('renders one card per queued draft', () => {
    state.approvals.data = [
      makeApproval({ id: 'a1', confidence: 71 }),
      makeApproval({ id: 'a2', confidence: 84 }),
      makeApproval({ id: 'a3', confidence: 88 }),
    ];
    render(<ApprovalsPage />);

    expect(screen.getByText('71% confidence')).toBeInTheDocument();
    expect(screen.getByText('84% confidence')).toBeInTheDocument();
    expect(screen.getByText('88% confidence')).toBeInTheDocument();
  });
});

describe('ApprovalsPage — resolving a draft', () => {
  it('approves the draft unedited', () => {
    render(<ApprovalsPage />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    expect(state.resolve.mutate).toHaveBeenCalledWith({ id: 'a1', status: 'APPROVED' });
  });

  it('rejects the draft', () => {
    render(<ApprovalsPage />);
    fireEvent.click(screen.getByRole('button', { name: /reject/i }));

    expect(state.resolve.mutate).toHaveBeenCalledWith({ id: 'a1', status: 'REJECTED' });
  });

  it('sends an edited draft as EDITED with the new text', () => {
    render(<ApprovalsPage />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Saturday 11am works — shall I confirm?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send edited/i }));

    expect(state.resolve.mutate).toHaveBeenCalledWith({
      id: 'a1',
      status: 'EDITED',
      editedText: 'Saturday 11am works — shall I confirm?',
    });
  });

  it('seeds the editor with the draft so an operator tweaks rather than retypes', () => {
    render(<ApprovalsPage />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    expect(screen.getByRole('textbox')).toHaveValue(
      'Yes, the 2BHK in Powai is available for a visit this Saturday.',
    );
  });

  it('backs out of editing without sending anything', () => {
    render(<ApprovalsPage />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(state.resolve.mutate).not.toHaveBeenCalled();
  });

  it('resolves the card that was clicked, not the first in the queue', () => {
    state.approvals.data = [
      makeApproval({ id: 'a1', confidence: 71 }),
      makeApproval({ id: 'a2', confidence: 84 }),
    ];
    render(<ApprovalsPage />);

    fireEvent.click(screen.getAllByRole('button', { name: /approve/i })[1]);
    expect(state.resolve.mutate).toHaveBeenCalledWith({ id: 'a2', status: 'APPROVED' });
  });

  it('disables the edit control while a resolve is in flight', () => {
    state.resolve.isPending = true;
    render(<ApprovalsPage />);
    expect(screen.getByRole('button', { name: /edit/i })).toBeDisabled();
  });
});

describe('ApprovalsPage — permissions', () => {
  it('offers no resolve controls to a VIEWER', () => {
    currentRole = 'VIEWER';
    render(<ApprovalsPage />);

    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
  });

  it('still shows a VIEWER the draft and its confidence', () => {
    currentRole = 'VIEWER';
    render(<ApprovalsPage />);

    expect(screen.getByText('82% confidence')).toBeInTheDocument();
    expect(screen.getByText(/2BHK in Powai/)).toBeInTheDocument();
  });

  it('offers the controls to STAFF', () => {
    render(<ApprovalsPage />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });
});
