/**
 * The onboarding wizard shell — stepper, navigation, chat sidebar and gate.
 *
 * The wizard's whole job is not losing the operator's work: every move between
 * steps (Back, Next, Skip, a stepper click) persists the draft first and only
 * navigates on success, so a failed save must leave you where you were. The
 * status it writes differs per control — Next completes, Skip skips, and a
 * sideways jump must preserve whatever status the step already had rather than
 * silently marking it done. Those distinctions are what these tests pin.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OnboardingProgress,
  OnboardingStepId,
  OnboardingStepState,
} from '@/lib/onboarding-types';

// jsdom implements no layout, so `Element.scrollTo` does not exist at all —
// the chat's scroll-to-bottom effect throws rather than no-opping. Stub it.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

const DEFS: Record<OnboardingStepId, { title: string; description: string; optional: boolean }> = {
  WELCOME: { title: 'Welcome', description: 'Tell us about your business', optional: false },
  CHANNELS: { title: 'Connect channels', description: 'Pick your channels', optional: false },
  CATALOG: { title: 'Add catalog', description: 'Products and services', optional: true },
  AI_CONFIG: { title: 'Configure AI', description: 'Tone and thresholds', optional: false },
  TEAM: { title: 'Invite team', description: 'Add teammates', optional: true },
  TEST: { title: 'Quick test', description: 'Try the AI', optional: false },
};

const ORDER: OnboardingStepId[] = ['WELCOME', 'CHANNELS', 'CATALOG', 'AI_CONFIG', 'TEAM', 'TEST'];

function step(
  id: OnboardingStepId,
  status: OnboardingStepState['status'] = 'pending',
  data: Record<string, unknown> = {},
): OnboardingStepState {
  return {
    step: id,
    status,
    definition: { id, ...DEFS[id] },
    data,
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function makeProgress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    steps: ORDER.map((id) => step(id)),
    currentStep: 'WELCOME',
    completedCount: 0,
    skippedCount: 0,
    totalSteps: 6,
    percentComplete: 0,
    isComplete: false,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

const state = {
  progress: {
    data: undefined as OnboardingProgress | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  status: { data: { needed: true } as { needed: boolean } | undefined },
  updatePending: false,
  completeError: false,
};

const updateStep = vi.fn();
const complete = vi.fn();
const chatMutate = vi.fn();
let authStatus = 'authenticated';

vi.mock('@/hooks/use-onboarding', () => ({
  useOnboardingProgress: () => state.progress,
  useOnboardingStatus: () => state.status,
  useUpdateOnboardingStep: () => ({ mutate: updateStep, isPending: state.updatePending }),
  useCompleteOnboarding: () => ({
    mutate: complete,
    isPending: false,
    isError: state.completeError,
  }),
  useOnboardingChat: () => ({ mutate: chatMutate, isPending: false }),
}));

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ status: authStatus, user: null, business: null }),
}));

import { OnboardingWizard } from './onboarding-wizard';
import { OnboardingStepper } from './onboarding-stepper';
import { OnboardingChat } from './onboarding-chat';
import { OnboardingGate } from './onboarding-gate';

/** Runs the `onSuccess` of the most recent `updateStep.mutate` call. */
function resolveSave(index = -1) {
  const calls = updateStep.mock.calls;
  const call = calls.at(index)!;
  act(() => call[1].onSuccess());
}

beforeEach(() => {
  state.progress = {
    data: makeProgress(),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  state.status = { data: { needed: true } };
  state.updatePending = false;
  state.completeError = false;
  authStatus = 'authenticated';
  vi.clearAllMocks();
});

describe('OnboardingWizard shell', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<OnboardingWizard open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a loading state while progress is fetched', () => {
    state.progress = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    render(<OnboardingWizard open onClose={vi.fn()} />);
    expect(screen.getByText('Loading your setup…')).toBeInTheDocument();
  });

  it('retries a failed progress fetch', () => {
    const refetch = vi.fn();
    state.progress = { data: undefined, isLoading: false, isError: true, refetch };
    render(<OnboardingWizard open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('opens on the step the backend says is current, not always the first', () => {
    state.progress.data = makeProgress({ currentStep: 'AI_CONFIG' });
    render(<OnboardingWizard open onClose={vi.fn()} />);
    expect(screen.getByText('Step 4 of 6')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Configure AI' })).toBeInTheDocument();
  });

  it('falls back to WELCOME when no current step is recorded', () => {
    state.progress.data = makeProgress({ currentStep: null });
    render(<OnboardingWizard open onClose={vi.fn()} />);
    expect(screen.getByText('Step 1 of 6')).toBeInTheDocument();
  });

  it('closes from the header button and from the backdrop', () => {
    const onClose = vi.fn();
    const { container } = render(<OnboardingWizard open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector('[aria-hidden]') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('OnboardingWizard navigation', () => {
  it('disables Back on the first step', () => {
    render(<OnboardingWizard open onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Back/ })).toBeDisabled();
  });

  it('saves as completed and advances on Save & continue', () => {
    render(<OnboardingWizard open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Save & continue/ }));
    expect(updateStep).toHaveBeenCalledWith(
      { step: 'WELCOME', status: 'completed', data: {} },
      expect.anything(),
    );
    resolveSave();
    expect(screen.getByText('Step 2 of 6')).toBeInTheDocument();
  });

  it('stays on the step when the save never succeeds', () => {
    render(<OnboardingWizard open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Save & continue/ }));
    // No onSuccess — a failed PUT must not advance past unsaved work.
    expect(screen.getByText('Step 1 of 6')).toBeInTheDocument();
  });

  it('offers Skip only on an optional step, and records it as skipped', () => {
    state.progress.data = makeProgress({ currentStep: 'CATALOG' });
    render(<OnboardingWizard open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(updateStep).toHaveBeenCalledWith(
      { step: 'CATALOG', status: 'skipped', data: {} },
      expect.anything(),
    );
  });

  it('offers no Skip on a required step', () => {
    render(<OnboardingWizard open onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
  });

  it('offers no Skip on the last step even though it is reachable', () => {
    state.progress.data = makeProgress({
      currentStep: 'TEST',
      steps: ORDER.map((id) => (id === 'TEST' ? step(id, 'pending', {}) : step(id))),
    });
    render(<OnboardingWizard open onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();
    expect(screen.getByRole('button', { name: /Finish setup/ })).toBeInTheDocument();
  });

  it('preserves the existing status when jumping sideways from the stepper', () => {
    state.progress.data = makeProgress({
      currentStep: 'CHANNELS',
      steps: ORDER.map((id) => step(id, id === 'CHANNELS' ? 'skipped' : 'pending')),
    });
    render(<OnboardingWizard open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Invite team/ }));
    // A sideways jump is a save, not a completion — 'skipped' must survive.
    expect(updateStep).toHaveBeenCalledWith(
      { step: 'CHANNELS', status: 'skipped', data: {} },
      expect.anything(),
    );
    resolveSave();
    expect(screen.getByText('Step 5 of 6')).toBeInTheDocument();
  });

  it('goes back one step, saving first', () => {
    state.progress.data = makeProgress({ currentStep: 'CHANNELS' });
    render(<OnboardingWizard open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Back/ }));
    resolveSave();
    expect(screen.getByText('Step 1 of 6')).toBeInTheDocument();
  });

  it('disables navigation while a save is in flight', () => {
    state.updatePending = true;
    state.progress.data = makeProgress({ currentStep: 'CATALOG' });
    render(<OnboardingWizard open onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Back/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();
  });
});

describe('OnboardingWizard draft handling', () => {
  it('seeds the step form from the saved step data', () => {
    state.progress.data = makeProgress({
      currentStep: 'WELCOME',
      steps: ORDER.map((id) =>
        id === 'WELCOME' ? step(id, 'pending', { businessName: 'Acme Salon' }) : step(id),
      ),
    });
    render(<OnboardingWizard open onClose={vi.fn()} />);
    expect(screen.getByDisplayValue('Acme Salon')).toBeInTheDocument();
  });

  it('persists edits made in the step form', () => {
    render(<OnboardingWizard open onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Acme Salon & Spa'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save & continue/ }));
    expect(updateStep).toHaveBeenCalledWith(
      { step: 'WELCOME', status: 'completed', data: { businessName: 'Acme' } },
      expect.anything(),
    );
  });

  it('swaps the draft when the step changes rather than carrying it over', () => {
    state.progress.data = makeProgress({
      steps: ORDER.map((id) =>
        id === 'CHANNELS' ? step(id, 'pending', { selected: ['WHATSAPP'] }) : step(id),
      ),
    });
    render(<OnboardingWizard open onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('Acme Salon & Spa'), {
      target: { value: 'Acme' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save & continue/ }));
    resolveSave();

    // Now on CHANNELS: it must show its own saved data, not WELCOME's draft.
    expect(screen.getByPlaceholderText('+91…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save & continue/ }));
    expect(updateStep).toHaveBeenLastCalledWith(
      { step: 'CHANNELS', status: 'completed', data: { selected: ['WHATSAPP'] } },
      expect.anything(),
    );
  });
});

describe('OnboardingWizard completion', () => {
  function openOnLastStep() {
    state.progress.data = makeProgress({ currentStep: 'TEST' });
    const onClose = vi.fn();
    render(<OnboardingWizard open onClose={onClose} />);
    return onClose;
  }

  it('saves the last step, then marks onboarding complete', () => {
    openOnLastStep();
    fireEvent.click(screen.getByRole('button', { name: /Finish setup/ }));
    expect(updateStep).toHaveBeenCalledWith(
      { step: 'TEST', status: 'completed', data: {} },
      expect.anything(),
    );
    expect(complete).not.toHaveBeenCalled();

    resolveSave();
    expect(complete).toHaveBeenCalled();
  });

  it('shows the celebration view only after the completion call succeeds', () => {
    const onClose = openOnLastStep();
    fireEvent.click(screen.getByRole('button', { name: /Finish setup/ }));
    resolveSave();
    expect(screen.queryByText(/You’re all set/)).toBeNull();

    act(() => complete.mock.calls[0][1].onSuccess());
    expect(screen.getByText(/You're all set/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go to dashboard' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('explains a refused completion instead of silently doing nothing', () => {
    state.completeError = true;
    openOnLastStep();
    expect(screen.getByText('Finish the required steps first.')).toBeInTheDocument();
  });
});

describe('OnboardingStepper', () => {
  const steps = [
    step('WELCOME', 'completed'),
    step('CHANNELS', 'skipped'),
    step('CATALOG', 'pending'),
    step('AI_CONFIG', 'pending'),
  ];

  it('renders the completion percentage', () => {
    render(
      <OnboardingStepper steps={steps} activeStep="CATALOG" onSelect={vi.fn()} percentComplete={50} />,
    );
    expect(screen.getByText('50% complete')).toBeInTheDocument();
  });

  it('labels a pending step Optional or Required from its definition', () => {
    render(
      <OnboardingStepper steps={steps} activeStep="CATALOG" onSelect={vi.fn()} percentComplete={0} />,
    );
    const catalog = screen.getByText('Add catalog').closest('button') as HTMLElement;
    const ai = screen.getByText('Configure AI').closest('button') as HTMLElement;
    expect(within(catalog).getByText('Optional')).toBeInTheDocument();
    expect(within(ai).getByText('Required')).toBeInTheDocument();
  });

  it('shows the raw status for steps that are no longer pending', () => {
    render(
      <OnboardingStepper steps={steps} activeStep="CATALOG" onSelect={vi.fn()} percentComplete={0} />,
    );
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('skipped')).toBeInTheDocument();
  });

  it('numbers only the inactive pending steps', () => {
    render(
      <OnboardingStepper steps={steps} activeStep="CATALOG" onSelect={vi.fn()} percentComplete={0} />,
    );
    // AI_CONFIG is pending and inactive → shows its 1-based position.
    const ai = screen.getByText('Configure AI').closest('button') as HTMLElement;
    expect(within(ai).getByText('4')).toBeInTheDocument();
  });

  it('reports the step the operator clicked', () => {
    const onSelect = vi.fn();
    render(
      <OnboardingStepper steps={steps} activeStep="CATALOG" onSelect={onSelect} percentComplete={0} />,
    );
    fireEvent.click(screen.getByText('Connect channels'));
    expect(onSelect).toHaveBeenCalledWith('CHANNELS');
  });
});

describe('OnboardingChat', () => {
  const props = {
    step: 'CHANNELS' as OnboardingStepId,
    stepTitle: 'Connect channels',
    suggestedQuestions: ['What number format?', 'How do I verify?'],
  };

  it('shows the step it is helping with and the suggested chips', () => {
    render(<OnboardingChat {...props} />);
    expect(screen.getByText('Help with: Connect channels')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'What number format?' })).toBeInTheDocument();
  });

  it('sends a typed question with the active step and clears the box', () => {
    render(<OnboardingChat {...props} />);
    const input = screen.getByPlaceholderText('Ask the assistant…');
    fireEvent.change(input, { target: { value: 'Is SMS supported?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(chatMutate).toHaveBeenCalledWith(
      { message: 'Is SMS supported?', step: 'CHANNELS', history: [] },
      expect.anything(),
    );
    expect(input).toHaveValue('');
    expect(screen.getByText('Is SMS supported?')).toBeInTheDocument();
  });

  it('appends the reply and replaces the chips with the follow-ups', () => {
    render(<OnboardingChat {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'What number format?' }));
    act(() =>
      chatMutate.mock.calls[0][1].onSuccess({
        reply: 'Use E.164, e.g. +919876543210.',
        suggestedQuestions: ['What is E.164?'],
      }),
    );
    expect(screen.getByText('Use E.164, e.g. +919876543210.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'What is E.164?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'How do I verify?' })).toBeNull();
  });

  it('says so in the thread when the assistant is unreachable', () => {
    render(<OnboardingChat {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'What number format?' }));
    act(() => chatMutate.mock.calls[0][1].onError());
    expect(screen.getByText(/couldn't reach the assistant/)).toBeInTheDocument();
  });

  it('keeps the send button disabled for an empty box', () => {
    render(<OnboardingChat {...props} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Ask the assistant…'), {
      target: { value: '   ' },
    });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('caps the history it sends at the last six turns', () => {
    render(<OnboardingChat {...props} />);
    const input = screen.getByPlaceholderText('Ask the assistant…');
    for (let i = 1; i <= 8; i++) {
      fireEvent.change(input, { target: { value: `q${i}` } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    }
    const lastHistory = chatMutate.mock.calls.at(-1)![0].history;
    expect(lastHistory).toHaveLength(6);
    expect(lastHistory.at(-1)).toEqual({ role: 'user', content: 'q7' });
  });
});

describe('OnboardingGate', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('renders nothing until the session is authenticated', () => {
    authStatus = 'loading';
    const { container } = render(<OnboardingGate />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the wizard when onboarding is still needed', () => {
    render(<OnboardingGate />);
    expect(screen.getByRole('dialog', { name: 'Onboarding setup wizard' })).toBeInTheDocument();
  });

  it('stays shut when the backend says onboarding is done', () => {
    state.status = { data: { needed: false } };
    render(<OnboardingGate />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not re-pop in the same browser session once dismissed', () => {
    const { unmount } = render(<OnboardingGate />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    render(<OnboardingGate />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/**
 * Two paths that only run once a save has actually resolved, plus the case
 * where the progress payload and the step order disagree.
 */
describe('OnboardingWizard skip and desynced progress', () => {
  it('advances to the next step once the skip has saved', () => {
    // The existing Skip test asserts the PUT and stops there, so the
    // `target && setActiveStep(target)` continuation never ran — a Skip that
    // recorded the status but left the operator on the same step would pass.
    state.progress.data = makeProgress({ currentStep: 'CATALOG' });
    render(<OnboardingWizard open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(screen.getByText('Step 3 of 6')).toBeInTheDocument();

    resolveSave();
    expect(screen.getByText('Step 4 of 6')).toBeInTheDocument();
  });

  it('navigates from a step the progress payload does not describe', () => {
    // A step added server-side before the tenant's rows are backfilled leaves
    // `steps` without an entry for the active step. Every read of it is
    // optional-chained; the status written on navigation falls back to
    // 'pending' rather than crashing or inventing a completion.
    state.progress.data = makeProgress({
      currentStep: 'CATALOG',
      steps: ORDER.filter((id) => id !== 'CATALOG').map((id) => step(id)),
    });
    render(<OnboardingWizard open onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Back/ }));

    expect(updateStep).toHaveBeenCalledWith(
      { step: 'CATALOG', status: 'pending', data: {} },
      expect.anything(),
    );
    resolveSave();
    expect(screen.getByText('Step 2 of 6')).toBeInTheDocument();
  });
});
