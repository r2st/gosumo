/**
 * The lead detail action bar: assign, restage, book a visit, start a cadence,
 * and switch the follow-up language.
 *
 * Every one of these is a write, so the suite covers three things per action:
 * the mutation is called with the right payload, success and failure produce
 * the right operator feedback, and the modal only closes when the write landed
 * (a modal that closes on failure looks like the change was saved).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Lead, LeadStage } from '@/lib/realty-types';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

let canWrite = true;
vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ canWrite }),
}));

const toast = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};
vi.mock('@/providers/toast-provider', () => ({ useToast: () => toast }));

/** A mutation stub whose `mutate` invokes the caller's success or error callback. */
interface MutationStub {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
}

function mutationStub(): MutationStub {
  return { mutate: vi.fn(), isPending: false, isError: false };
}

const assign = mutationStub();
const transition = mutationStub();
const enroll = mutationStub();
const update = mutationStub();

let team: { data: { data: { id: string; name: string; role: string }[] } | undefined; isLoading: boolean };

vi.mock('@/hooks/use-realty', () => ({
  useAssignLead: () => assign,
  useTransitionStage: () => transition,
  useEnrollCadence: () => enroll,
  useUpdateLead: () => update,
}));

vi.mock('@/hooks/use-settings', () => ({ useTeam: () => team }));

const { LeadActions } = await import('./lead-actions');

const lead = (overrides: Partial<Lead> = {}): Lead =>
  ({
    id: 'lead-1',
    businessId: 'b1',
    assignedAgentId: null,
    whatsappPhone: '+919800000001',
    name: 'Asha Rao',
    languagePref: 'en',
    source: 'PORTAL',
    subSource: null,
    stage: 'NEW' as LeadStage,
    temperature: 'WARM',
    qualScore: 50,
    ...overrides,
  }) as Lead;

/**
 * Resolve the last `mutate` call's success callback with `data`. Wrapped in
 * `act` because the callbacks close modals and set state.
 */
const succeed = (m: MutationStub, data: unknown = { id: 'x' }): void => {
  const [, callbacks] = m.mutate.mock.calls.at(-1) as [
    unknown,
    { onSuccess: (d: unknown) => void },
  ];
  act(() => callbacks.onSuccess(data));
};

const fail = (m: MutationStub): void => {
  const [, callbacks] = m.mutate.mock.calls.at(-1) as [
    unknown,
    { onError: () => void },
  ];
  act(() => callbacks.onError());
};

const openModal = (name: RegExp): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};

const dialogOpen = (): boolean => screen.queryByRole('dialog') !== null;

beforeEach(() => {
  vi.clearAllMocks();
  canWrite = true;
  for (const m of [assign, transition, enroll, update]) {
    m.isPending = false;
    m.isError = false;
  }
  team = {
    data: {
      data: [
        { id: 'agent-1', name: 'Rahul', role: 'STAFF' },
        { id: 'agent-2', name: 'Priya', role: 'MANAGER' },
      ],
    },
    isLoading: false,
  };
});

describe('permission gating', () => {
  it('renders nothing at all for a read-only role', () => {
    canWrite = false;
    const { container } = render(<LeadActions lead={lead()} />);
    expect(container.firstChild).toBeNull();
  });

  it('offers every action to a role that can write', () => {
    render(<LeadActions lead={lead()} />);
    for (const name of [
      /assign agent/i,
      /change stage/i,
      /book visit/i,
      /start cadence/i,
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });
});

describe('book visit', () => {
  it('navigates to the site-visits page rather than opening a modal', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/book visit/i);
    expect(push).toHaveBeenCalledWith('/sitevisits');
    expect(dialogOpen()).toBe(false);
  });
});

describe('assign agent', () => {
  it('lists every team member with their role', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/assign agent/i);
    expect(screen.getByRole('option', { name: 'Rahul · STAFF' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Priya · MANAGER' })).toBeTruthy();
  });

  it('says so when the business has no team members yet', () => {
    team = { data: { data: [] }, isLoading: false };
    render(<LeadActions lead={lead()} />);
    openModal(/assign agent/i);
    expect(screen.getByRole('option', { name: /no team members found/i })).toBeTruthy();
  });

  it('survives the team request returning nothing', () => {
    team = { data: undefined, isLoading: true };
    render(<LeadActions lead={lead()} />);
    openModal(/assign agent/i);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps Assign disabled until an agent is picked', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/assign agent/i);
    const submit = screen.getByRole('button', { name: /^assign$/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/team member/i), {
      target: { value: 'agent-1' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('preselects the agent the lead is already assigned to', () => {
    render(<LeadActions lead={lead({ assignedAgentId: 'agent-2' })} />);
    openModal(/assign agent/i);
    expect((screen.getByLabelText(/team member/i) as HTMLSelectElement).value).toBe(
      'agent-2',
    );
  });

  it('assigns the lead to the selected agent', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/assign agent/i);
    fireEvent.change(screen.getByLabelText(/team member/i), {
      target: { value: 'agent-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));
    expect(assign.mutate).toHaveBeenCalledWith(
      { id: 'lead-1', agentId: 'agent-1' },
      expect.anything(),
    );
  });

  it('names the agent in the confirmation and closes the modal', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/assign agent/i);
    fireEvent.change(screen.getByLabelText(/team member/i), {
      target: { value: 'agent-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));
    succeed(assign);
    expect(toast.success).toHaveBeenCalledWith('Lead assigned to Rahul.', {
      title: 'Agent assigned',
    });
    expect(dialogOpen()).toBe(false);
  });

  it('keeps the modal open and reports the failure when the write fails', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/assign agent/i);
    fireEvent.change(screen.getByLabelText(/team member/i), {
      target: { value: 'agent-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));
    fail(assign);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not assign the lead. Please try again.',
    );
    expect(dialogOpen()).toBe(true);
  });

  it('shows an inline error alongside the toast once the mutation is in an error state', () => {
    assign.isError = true;
    render(<LeadActions lead={lead()} />);
    openModal(/assign agent/i);
    expect(screen.getByText(/could not assign the lead/i)).toBeTruthy();
  });

  it('closes without assigning when cancelled', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/assign agent/i);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(assign.mutate).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(false);
  });
});

describe('change stage', () => {
  it('opens on the lead’s current stage', () => {
    render(<LeadActions lead={lead({ stage: 'QUALIFIED' })} />);
    openModal(/change stage/i);
    expect((screen.getByLabelText(/^stage$/i) as HTMLSelectElement).value).toBe(
      'QUALIFIED',
    );
    expect(screen.getByText(/currently at "qualified"/i)).toBeTruthy();
  });

  it('transitions the lead to the chosen stage', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/change stage/i);
    fireEvent.change(screen.getByLabelText(/^stage$/i), {
      target: { value: 'NEGOTIATING' },
    });
    fireEvent.click(screen.getByRole('button', { name: /update stage/i }));
    expect(transition.mutate).toHaveBeenCalledWith(
      { id: 'lead-1', stage: 'NEGOTIATING' },
      expect.anything(),
    );
  });

  it('closes without a write when the stage was not actually changed', () => {
    render(<LeadActions lead={lead({ stage: 'QUALIFIED' })} />);
    openModal(/change stage/i);
    fireEvent.click(screen.getByRole('button', { name: /update stage/i }));
    expect(transition.mutate).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(false);
  });

  it('confirms with the new stage’s label and closes', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/change stage/i);
    fireEvent.change(screen.getByLabelText(/^stage$/i), {
      target: { value: 'CLOSED_WON' },
    });
    fireEvent.click(screen.getByRole('button', { name: /update stage/i }));
    succeed(transition);
    expect(toast.success).toHaveBeenCalledWith('Moved to “Closed Won”.', {
      title: 'Stage updated',
    });
    expect(dialogOpen()).toBe(false);
  });

  it('keeps the modal open when the transition fails', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/change stage/i);
    fireEvent.change(screen.getByLabelText(/^stage$/i), {
      target: { value: 'VISITED' },
    });
    fireEvent.click(screen.getByRole('button', { name: /update stage/i }));
    fail(transition);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not update the stage. Please try again.',
    );
    expect(dialogOpen()).toBe(true);
  });

  it('shows the inline error in the mutation error state', () => {
    transition.isError = true;
    render(<LeadActions lead={lead()} />);
    openModal(/change stage/i);
    expect(screen.getByText(/could not update the stage/i)).toBeTruthy();
  });
});

describe('start cadence', () => {
  it('defaults to the no-response trigger', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/start cadence/i);
    expect((screen.getByLabelText(/cadence trigger/i) as HTMLSelectElement).value).toBe(
      'NO_RESPONSE',
    );
  });

  it('enrols the lead against the chosen trigger', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/start cadence/i);
    fireEvent.change(screen.getByLabelText(/cadence trigger/i), {
      target: { value: 'POST_VISIT' },
    });
    fireEvent.click(screen.getByRole('button', { name: /enrol/i }));
    expect(enroll.mutate).toHaveBeenCalledWith(
      { leadId: 'lead-1', trigger: 'POST_VISIT' },
      expect.anything(),
    );
  });

  it('confirms and closes when the enrolment lands', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/start cadence/i);
    fireEvent.click(screen.getByRole('button', { name: /enrol/i }));
    succeed(enroll, { id: 'enrolment-1' });
    expect(toast.success).toHaveBeenCalledWith(
      'Enrolled in the No response sequence.',
      { title: 'Cadence started' },
    );
    expect(dialogOpen()).toBe(false);
  });

  it('stays open and warns when no cadence matches the trigger', () => {
    // The API answers null rather than erroring when nothing is configured —
    // closing on that would read as "enrolled" when nothing happened.
    render(<LeadActions lead={lead()} />);
    openModal(/start cadence/i);
    fireEvent.click(screen.getByRole('button', { name: /enrol/i }));
    succeed(enroll, null);
    expect(toast.warning).toHaveBeenCalledWith(
      'No active cadence is configured for this trigger yet.',
    );
    expect(dialogOpen()).toBe(true);
    expect(screen.getByText(/no active cadence is configured/i)).toBeTruthy();
  });

  it('clears the no-cadence notice on the next attempt', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/start cadence/i);
    fireEvent.click(screen.getByRole('button', { name: /enrol/i }));
    succeed(enroll, null);
    expect(screen.queryByText(/no active cadence is configured/i)).not.toBeNull();

    fireEvent.change(screen.getByLabelText(/cadence trigger/i), {
      target: { value: 'DORMANT' },
    });
    fireEvent.click(screen.getByRole('button', { name: /enrol/i }));
    expect(screen.queryByText(/no active cadence is configured/i)).toBeNull();
  });

  it('reports an enrolment failure without closing', () => {
    render(<LeadActions lead={lead()} />);
    openModal(/start cadence/i);
    fireEvent.click(screen.getByRole('button', { name: /enrol/i }));
    fail(enroll);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not enrol the lead. Please try again.',
    );
    expect(dialogOpen()).toBe(true);
  });

  it('shows the inline error in the mutation error state', () => {
    enroll.isError = true;
    render(<LeadActions lead={lead()} />);
    openModal(/start cadence/i);
    expect(screen.getByText(/could not enrol the lead/i)).toBeTruthy();
  });
});

describe('follow-up language', () => {
  const select = (): HTMLSelectElement =>
    screen.getByLabelText(/follow-up language/i) as HTMLSelectElement;

  it('shows the lead’s stored preference', () => {
    render(<LeadActions lead={lead({ languagePref: 'hi' })} />);
    expect(select().value).toBe('hi');
  });

  it('normalizes an unrecognised stored preference to Hinglish', () => {
    render(<LeadActions lead={lead({ languagePref: 'kn' })} />);
    expect(select().value).toBe('hinglish');
  });

  it('saves the new language on change', () => {
    render(<LeadActions lead={lead({ languagePref: 'en' })} />);
    fireEvent.change(select(), { target: { value: 'hi' } });
    expect(update.mutate).toHaveBeenCalledWith(
      { id: 'lead-1', patch: { languagePref: 'hi' } },
      expect.anything(),
    );
  });

  it('does not write when the selection did not change', () => {
    render(<LeadActions lead={lead({ languagePref: 'en' })} />);
    fireEvent.change(select(), { target: { value: 'en' } });
    expect(update.mutate).not.toHaveBeenCalled();
  });

  it('does not write when a legacy value normalizes to the same language', () => {
    render(<LeadActions lead={lead({ languagePref: 'english' })} />);
    fireEvent.change(select(), { target: { value: 'en' } });
    expect(update.mutate).not.toHaveBeenCalled();
  });

  it('confirms the change by name', () => {
    render(<LeadActions lead={lead({ languagePref: 'en' })} />);
    fireEvent.change(select(), { target: { value: 'hinglish' } });
    succeed(update);
    expect(toast.success).toHaveBeenCalledWith(
      'Follow-ups will use Hinglish.',
      { title: 'Language updated' },
    );
  });

  it('reports a failed language change', () => {
    render(<LeadActions lead={lead({ languagePref: 'en' })} />);
    fireEvent.change(select(), { target: { value: 'hi' } });
    fail(update);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not update the language. Please try again.',
    );
  });

  it('locks the selector while the save is in flight', () => {
    update.isPending = true;
    render(<LeadActions lead={lead()} />);
    expect(select().disabled).toBe(true);
  });
});
