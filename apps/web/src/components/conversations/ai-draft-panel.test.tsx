/**
 * AiDraftPanel — the in-thread HITL review card.
 *
 * This is the surface where an operator decides whether an AI draft reaches a
 * real customer, so the tests care about two things above all: that the
 * confidence band is displayed honestly (the operator's only cue for how much
 * to trust the draft), and that approve/edit/reject send exactly what the
 * operator saw — never a stale or silently-edited body.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HitlTask } from '@/lib/types';
import type { Role } from '@/lib/feature-types';
import { ApiError } from '@/lib/api-client';

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

const approveMutate = vi.fn();
const rejectMutate = vi.fn();
const approveState = {
  mutate: approveMutate,
  isPending: false,
  isError: false,
  error: null as Error | null,
};
const rejectState = {
  mutate: rejectMutate,
  isPending: false,
  isError: false,
  error: null as Error | null,
};

vi.mock('@/hooks/use-queries', () => ({
  useApproveTask: () => approveState,
  useRejectTask: () => rejectState,
}));

// Imported after the mocks so the component picks them up.
const { AiDraftPanel } = await import('./ai-draft-panel');

function makeTask(overrides: Partial<HitlTask> = {}): HitlTask {
  return {
    id: 'task-1',
    businessId: 'b1',
    conversationId: 'c1',
    type: 'DRAFT_REVIEW',
    status: 'PENDING',
    priority: 'MEDIUM',
    title: 'Booking request from Priya',
    description: 'Customer asked for a 3pm slot tomorrow.',
    aiDraft: 'Aapki booking kal 3 baje confirm ho gayi hai!',
    aiConfidence: 82,
    aiReasoning: 'Slot is free and the cancellation policy is unambiguous.',
    createdAt: '2026-08-14T04:00:00.000Z',
    updatedAt: '2026-08-14T04:00:00.000Z',
    ...overrides,
  } as HitlTask;
}

beforeEach(() => {
  currentRole = 'STAFF';
  approveMutate.mockClear();
  rejectMutate.mockClear();
  approveState.isPending = false;
  approveState.isError = false;
  approveState.error = null;
  rejectState.isPending = false;
  rejectState.isError = false;
  rejectState.error = null;
});

describe('AiDraftPanel — confidence display', () => {
  it('shows the rounded confidence percentage', () => {
    render(<AiDraftPanel task={makeTask({ aiConfidence: 82.4 })} />);
    expect(screen.getByText('82% confidence')).toBeInTheDocument();
  });

  // The Badge tone → colour map, so a tone change has to be deliberate here too.
  const TONE_CLASS = {
    success: 'bg-emerald-500/15',
    warning: 'bg-amber-500/15',
    danger: 'bg-rose-500/15',
  } as const;

  it.each([
    [95, 'success'],
    [90, 'success'],
    [89, 'warning'],
    [70, 'warning'],
    [69, 'danger'],
    [12, 'danger'],
  ] as const)('tones a %i%% score as %s', (confidence, expectedTone) => {
    // The band boundaries mirror the API's routing thresholds (90 / 70). An
    // operator reading calm green on a 69% draft would be told the AI is more
    // sure than the pipeline actually judged it to be.
    render(<AiDraftPanel task={makeTask({ aiConfidence: confidence })} />);
    const badge = screen.getByText(`${confidence}% confidence`);
    expect(badge.className).toContain(TONE_CLASS[expectedTone]);
  });

  it('treats a missing score as zero rather than rendering NaN', () => {
    render(<AiDraftPanel task={makeTask({ aiConfidence: undefined })} />);
    expect(screen.getByText('0% confidence')).toBeInTheDocument();
  });

  it('shows the reasoning the model gave', () => {
    render(<AiDraftPanel task={makeTask()} />);
    expect(
      screen.getByText(/Slot is free and the cancellation policy is unambiguous/),
    ).toBeInTheDocument();
  });

  it('omits the reasoning block entirely when there is none', () => {
    render(<AiDraftPanel task={makeTask({ aiReasoning: undefined })} />);
    expect(screen.queryByText(/Reasoning:/)).not.toBeInTheDocument();
  });

  it('renders the task title and the draft body', () => {
    render(<AiDraftPanel task={makeTask()} />);
    expect(screen.getByText('Booking request from Priya')).toBeInTheDocument();
    expect(
      screen.getByText('Aapki booking kal 3 baje confirm ho gayi hai!'),
    ).toBeInTheDocument();
  });

  it('says so explicitly when the model produced no draft', () => {
    render(<AiDraftPanel task={makeTask({ aiDraft: undefined })} />);
    expect(screen.getByText('No draft provided.')).toBeInTheDocument();
  });
});

describe('AiDraftPanel — approve / edit / reject', () => {
  it('approves the untouched draft without an edited body', () => {
    render(<AiDraftPanel task={makeTask()} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve & send/ }));

    expect(approveMutate).toHaveBeenCalledWith({
      id: 'task-1',
      editedResponse: undefined,
    });
  });

  it('sends the edited body when the operator changed it', () => {
    render(<AiDraftPanel task={makeTask()} />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Kal 3 baje slot confirm hai, dhanyavaad!' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send edited/ }));

    expect(approveMutate).toHaveBeenCalledWith({
      id: 'task-1',
      editedResponse: 'Kal 3 baje slot confirm hai, dhanyavaad!',
    });
  });

  it('does not flag an edit the operator opened but did not change', () => {
    // Otherwise an operator who clicks Edit, reads, and approves would be
    // recorded as having rewritten the AI — polluting the override signal the
    // precedent learning feeds on.
    render(<AiDraftPanel task={makeTask()} />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.click(screen.getByRole('button', { name: /Approve & send/ }));

    expect(approveMutate).toHaveBeenCalledWith({
      id: 'task-1',
      editedResponse: undefined,
    });
  });

  it('restores the original label when the edit is cancelled', () => {
    render(<AiDraftPanel task={makeTask()} />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(screen.getByRole('button', { name: /Cancel edit/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Cancel edit/ }));
    expect(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('rejects with just the task id', () => {
    render(<AiDraftPanel task={makeTask()} />);

    fireEvent.click(screen.getByRole('button', { name: /Reject & take over/ }));

    expect(rejectMutate).toHaveBeenCalledWith({ id: 'task-1' });
  });

  it('disables every action while an approval is in flight', () => {
    // Double-approving would send the customer two messages.
    approveState.isPending = true;
    render(<AiDraftPanel task={makeTask()} />);

    for (const name of [/Approve & send/, /Edit/, /Reject & take over/]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('disables every action while a rejection is in flight', () => {
    rejectState.isPending = true;
    render(<AiDraftPanel task={makeTask()} />);

    expect(screen.getByRole('button', { name: /Approve & send/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Reject & take over/ })).toBeDisabled();
  });

  it('surfaces the failure message when approval fails', () => {
    approveState.isError = true;
    approveState.error = new Error('Conversation already resolved');
    render(<AiDraftPanel task={makeTask()} />);

    expect(screen.getByText('Conversation already resolved')).toBeInTheDocument();
  });

  it('falls back to a generic message when the error carries none', () => {
    rejectState.isError = true;
    rejectState.error = null;
    render(<AiDraftPanel task={makeTask()} />);

    expect(screen.getByText('That action didn’t go through. Please try again.')).toBeInTheDocument();
  });

  it('translates a transport-level failure rather than showing its raw text', () => {
    rejectState.isError = true;
    rejectState.error = new ApiError(
      0,
      'NETWORK_ERROR',
      'Unable to reach the GoSumo Realty API. Is it running?',
    );
    render(<AiDraftPanel task={makeTask()} />);

    expect(screen.getByText(/Check your internet connection/)).toBeInTheDocument();
    expect(screen.queryByText(/Is it running/)).not.toBeInTheDocument();
  });

  it('explains a permission failure as a permission failure', () => {
    rejectState.isError = true;
    rejectState.error = new ApiError(403, 'FORBIDDEN', 'Forbidden');
    render(<AiDraftPanel task={makeTask()} />);

    expect(screen.getByText(/don’t have permission/)).toBeInTheDocument();
  });
});

describe('AiDraftPanel — role gating', () => {
  it('offers no send controls to a VIEWER', () => {
    // Approving pushes a real message to a customer; the API refuses it for a
    // VIEWER, so the button must not be offered either.
    currentRole = 'VIEWER';
    render(<AiDraftPanel task={makeTask()} />);

    expect(screen.queryByRole('button', { name: /Approve & send/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject & take over/ })).not.toBeInTheDocument();
  });

  it('still shows a VIEWER the draft and its confidence', () => {
    currentRole = 'VIEWER';
    render(<AiDraftPanel task={makeTask()} />);

    expect(screen.getByText('82% confidence')).toBeInTheDocument();
    expect(
      screen.getByText('Aapki booking kal 3 baje confirm ho gayi hai!'),
    ).toBeInTheDocument();
  });

  it('offers the controls to STAFF and above', () => {
    for (const role of ['STAFF', 'MANAGER', 'OWNER'] as Role[]) {
      currentRole = role;
      const { unmount } = render(<AiDraftPanel task={makeTask()} />);
      expect(screen.getByRole('button', { name: /Approve & send/ })).toBeInTheDocument();
      unmount();
    }
  });
});
