/**
 * OnboardingChat — the in-flight and degenerate paths.
 *
 * The happy path (send, reply, chips, transport failure, history cap) is
 * covered alongside the wizard in onboarding-wizard.test.tsx, where the mutation
 * is pinned to `isPending: false`. What that file structurally cannot reach is
 * everything gated on the request being *in flight*, plus the two fallbacks
 * that fire when the model answers with less than the component expects.
 *
 * The pending state matters more than it looks: `send()` is reachable from
 * three places (the form, the chips, Enter in the box), and the mutation has no
 * queue. Without the guard a second send while the first is open would drop the
 * user turn into the thread and then race two replies into it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingStepId } from '@/lib/onboarding-types';

const chat = { mutate: vi.fn(), isPending: false, isError: false };
vi.mock('@/hooks/use-onboarding', () => ({ useOnboardingChat: () => chat }));

import { OnboardingChat } from './onboarding-chat';

const props = {
  step: 'CHANNELS' as OnboardingStepId,
  stepTitle: 'Connect channels',
  suggestedQuestions: ['What number format?', 'How do I verify?'],
};

beforeEach(() => {
  chat.isPending = false;
  vi.clearAllMocks();
});

describe('OnboardingChat, before anything is asked', () => {
  it('explains what it can help with instead of showing an empty pane', () => {
    render(<OnboardingChat {...props} />);
    expect(screen.getByText(/Ask me anything about setting up GoSumo/)).toBeInTheDocument();
  });

  it('drops the primer once the thread has a turn in it', () => {
    render(<OnboardingChat {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'What number format?' }));
    expect(screen.queryByText(/Ask me anything about setting up GoSumo/)).toBeNull();
  });
});

describe('OnboardingChat, while a reply is in flight', () => {
  it('shows the thinking indicator', () => {
    chat.isPending = true;
    render(<OnboardingChat {...props} />);
    expect(screen.getByText(/Thinking/)).toBeInTheDocument();
  });

  it('hides the thinking indicator when idle', () => {
    render(<OnboardingChat {...props} />);
    expect(screen.queryByText(/Thinking/)).toBeNull();
  });

  it('disables the chips and the send button', () => {
    chat.isPending = true;
    render(<OnboardingChat {...props} />);
    expect(screen.getByRole('button', { name: 'What number format?' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('refuses a second send, so two replies cannot race into the thread', () => {
    // The controls are disabled, but the form still submits on Enter — the
    // guard inside send() is the thing that actually holds.
    chat.isPending = true;
    const { container } = render(<OnboardingChat {...props} />);
    fireEvent.change(screen.getByPlaceholderText('Ask the digital robot…'), {
      target: { value: 'second question' },
    });
    fireEvent.submit(container.querySelector('form')!);

    expect(chat.mutate).not.toHaveBeenCalled();
    // Nor is the user turn optimistically appended to a request never sent.
    expect(screen.queryByText('second question')).toBeNull();
  });
});

describe('OnboardingChat, degenerate input and replies', () => {
  it('ignores a submit with nothing but whitespace in the box', () => {
    const { container } = render(<OnboardingChat {...props} />);
    fireEvent.change(screen.getByPlaceholderText('Ask the digital robot…'), {
      target: { value: '   ' },
    });
    fireEvent.submit(container.querySelector('form')!);
    expect(chat.mutate).not.toHaveBeenCalled();
  });

  it('ignores a submit on a box that was never typed into', () => {
    const { container } = render(<OnboardingChat {...props} />);
    fireEvent.submit(container.querySelector('form')!);
    expect(chat.mutate).not.toHaveBeenCalled();
  });

  it('trims the question before sending it', () => {
    render(<OnboardingChat {...props} />);
    fireEvent.change(screen.getByPlaceholderText('Ask the digital robot…'), {
      target: { value: '  Is SMS supported?  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(chat.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Is SMS supported?' }),
      expect.anything(),
    );
  });

  it('clears the chips when a reply carries no follow-ups', () => {
    // The model is free to answer without suggesting anything. Leaving the
    // previous step's chips up would offer questions it has already answered.
    render(<OnboardingChat {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'What number format?' }));
    act(() => chat.mutate.mock.calls[0]![1].onSuccess({ reply: 'Use E.164.' }));

    expect(screen.getByText('Use E.164.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'How do I verify?' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'What number format?' })).toBeNull();
  });

  it('clears the chips when a reply carries an empty follow-up list', () => {
    render(<OnboardingChat {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'What number format?' }));
    act(() =>
      chat.mutate.mock.calls[0]![1].onSuccess({ reply: 'Use E.164.', suggestedQuestions: [] }),
    );
    expect(screen.queryByRole('button', { name: 'How do I verify?' })).toBeNull();
  });
});

describe('OnboardingChat, across steps', () => {
  it('restores the new step’s chips but keeps the thread', () => {
    // Messages persist across steps by design; the chips are step-specific.
    const { rerender } = render(<OnboardingChat {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'What number format?' }));
    act(() =>
      chat.mutate.mock.calls[0]![1].onSuccess({ reply: 'Use E.164.', suggestedQuestions: [] }),
    );

    rerender(
      <OnboardingChat
        step={'CATALOG' as OnboardingStepId}
        stepTitle="Add catalog"
        suggestedQuestions={['How do I price a package?']}
      />,
    );

    expect(screen.getByRole('button', { name: 'How do I price a package?' })).toBeInTheDocument();
    expect(screen.getByText('Help with: Add catalog')).toBeInTheDocument();
    expect(screen.getByText('Use E.164.')).toBeInTheDocument();
  });

  it('hides the chip rail entirely when a step suggests nothing', () => {
    render(<OnboardingChat {...props} suggestedQuestions={[]} />);
    expect(screen.queryByRole('button', { name: 'What number format?' })).toBeNull();
    // The composer is still there — an operator can always type.
    expect(screen.getByPlaceholderText('Ask the digital robot…')).toBeInTheDocument();
  });

  it('sends the step the operator is actually on', () => {
    render(
      <OnboardingChat
        step={'AI_CONFIG' as OnboardingStepId}
        stepTitle="AI settings"
        suggestedQuestions={['What is a confidence threshold?']}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'What is a confidence threshold?' }));
    expect(chat.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'AI_CONFIG' }),
      expect.anything(),
    );
  });
});
