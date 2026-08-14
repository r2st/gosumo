/**
 * The six onboarding step forms.
 *
 * Each step is a controlled form over one slice of the wizard's draft: it reads
 * `value` and reports patches through `onChange`. The failure mode worth
 * covering is the coercion at the boundary — the draft is `Record<string,
 * unknown>` coming back from the API as JSON, so a step handed a number where
 * it expected a string, or nothing at all, must fall back rather than render
 * `[object Object]` or crash. The list steps (catalog, team) additionally have
 * add/remove logic that indexes into an array, which is easy to get wrong.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingStepId } from '@/lib/onboarding-types';

const chat = { mutate: vi.fn(), isPending: false, isError: false };
vi.mock('@/hooks/use-onboarding', () => ({ useOnboardingChat: () => chat }));

import { STEP_COMPONENTS, type StepProps } from './onboarding-steps';

/** Renders one step with a spy `onChange` and returns the spy. */
function renderStep(step: OnboardingStepId, value: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const Step = STEP_COMPONENTS[step] as (props: StepProps) => JSX.Element;
  const utils = render(<Step value={value} onChange={onChange} />);
  return { onChange, ...utils };
}

beforeEach(() => {
  chat.isPending = false;
  vi.clearAllMocks();
});

describe('STEP_COMPONENTS', () => {
  it('has a component for every step id', () => {
    expect(Object.keys(STEP_COMPONENTS)).toEqual([
      'WELCOME',
      'CHANNELS',
      'CATALOG',
      'AI_CONFIG',
      'TEAM',
      'TEST',
    ]);
  });
});

describe('WelcomeStep', () => {
  it('defaults the timezone and hours before anything is saved', () => {
    renderStep('WELCOME');
    expect(screen.getByDisplayValue('Asia/Kolkata')).toBeInTheDocument();
    expect(screen.getByDisplayValue('09:00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('18:00')).toBeInTheDocument();
  });

  it('renders saved values over the defaults', () => {
    renderStep('WELCOME', {
      businessName: 'Acme Salon',
      timezone: 'Asia/Dubai',
      openTime: '10:30',
    });
    expect(screen.getByDisplayValue('Acme Salon')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Asia/Dubai')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10:30')).toBeInTheDocument();
  });

  it('falls back to the default when the saved value is not a string', () => {
    // The draft round-trips through JSON, so a bad write upstream can land a
    // number here. Coercing to '' would blank the field; the default holds.
    renderStep('WELCOME', { timezone: 42, businessName: null });
    expect(screen.getByDisplayValue('Asia/Kolkata')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Acme Salon & Spa')).toHaveValue('');
  });

  it('patches only the edited field', () => {
    const { onChange } = renderStep('WELCOME');
    fireEvent.change(screen.getByPlaceholderText('Acme Salon & Spa'), {
      target: { value: 'Acme' },
    });
    expect(onChange).toHaveBeenCalledWith({ businessName: 'Acme' });

    fireEvent.change(screen.getByPlaceholderText('Salon, Retail, Clinic…'), {
      target: { value: 'Salon' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ industry: 'Salon' });

    fireEvent.change(screen.getByDisplayValue('Asia/Kolkata'), {
      target: { value: 'Asia/Dubai' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ timezone: 'Asia/Dubai' });

    fireEvent.change(screen.getByDisplayValue('18:00'), { target: { value: '20:00' } });
    expect(onChange).toHaveBeenLastCalledWith({ closeTime: '20:00' });
  });

  it('captures the free-text business description', () => {
    const { onChange } = renderStep('WELCOME');
    fireEvent.change(screen.getByPlaceholderText(/neighbourhood salon/), {
      target: { value: 'We sell tea.' },
    });
    expect(onChange).toHaveBeenCalledWith({ description: 'We sell tea.' });
  });
});

describe('ChannelsStep', () => {
  it('offers all five channels', () => {
    renderStep('CHANNELS');
    for (const label of ['WebChat', 'WhatsApp', 'Email', 'SMS', 'Instagram']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('selects a channel and marks it', () => {
    const { onChange } = renderStep('CHANNELS');
    fireEvent.click(screen.getByText('WebChat'));
    expect(onChange).toHaveBeenCalledWith({ selected: ['WEB_CHAT'] });
  });

  it('deselects an already-selected channel without dropping the others', () => {
    const { onChange } = renderStep('CHANNELS', { selected: ['WEB_CHAT', 'SMS'] });
    expect(screen.getAllByText('Selected')).toHaveLength(2);
    fireEvent.click(screen.getByText('WebChat'));
    expect(onChange).toHaveBeenCalledWith({ selected: ['SMS'] });
  });

  it('asks for the number only once WhatsApp is picked', () => {
    const { unmount } = renderStep('CHANNELS', { selected: ['SMS'] });
    expect(screen.queryByPlaceholderText('+91…')).toBeNull();
    unmount();

    const { onChange } = renderStep('CHANNELS', { selected: ['WHATSAPP'] });
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '+919876543210' } });
    expect(onChange).toHaveBeenCalledWith({ whatsappNumber: '+919876543210' });
  });

  it('treats a non-array saved selection as nothing selected', () => {
    renderStep('CHANNELS', { selected: 'WEB_CHAT' });
    expect(screen.queryByText('Selected')).toBeNull();
  });
});

describe('CatalogStep', () => {
  it('appends the drafted item and clears the draft', () => {
    const { onChange } = renderStep('CATALOG');
    fireEvent.change(screen.getByPlaceholderText('Haircut'), { target: { value: 'Colouring' } });
    fireEvent.change(screen.getByPlaceholderText('499'), { target: { value: '1200' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));

    expect(onChange).toHaveBeenCalledWith({
      items: [{ name: 'Colouring', type: 'SERVICE', price: '1200' }],
    });
    expect(screen.getByPlaceholderText('Haircut')).toHaveValue('');
  });

  it('refuses to add an item with a blank name', () => {
    const { onChange } = renderStep('CATALOG');
    fireEvent.change(screen.getByPlaceholderText('Haircut'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lists saved items with a dash for a missing price', () => {
    renderStep('CATALOG', {
      items: [
        { name: 'Haircut', type: 'SERVICE', price: '499' },
        { name: 'Shampoo', type: 'PRODUCT', price: '' },
      ],
    });
    expect(screen.getByText('₹499')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('removes the item at the clicked index, not the first one', () => {
    const { onChange } = renderStep('CATALOG', {
      items: [
        { name: 'Haircut', type: 'SERVICE', price: '499' },
        { name: 'Shampoo', type: 'PRODUCT', price: '250' },
      ],
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    expect(onChange).toHaveBeenCalledWith({
      items: [{ name: 'Haircut', type: 'SERVICE', price: '499' }],
    });
  });

  it('carries the chosen type onto the new item', () => {
    const { onChange } = renderStep('CATALOG');
    fireEvent.change(screen.getByPlaceholderText('Haircut'), { target: { value: 'Shampoo' } });
    fireEvent.change(screen.getByDisplayValue('Service'), { target: { value: 'PRODUCT' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/ }));
    expect(onChange).toHaveBeenCalledWith({
      items: [{ name: 'Shampoo', type: 'PRODUCT', price: '' }],
    });
  });
});

describe('AiConfigStep', () => {
  it('defaults auto-reply on and the two confidence thresholds to 90/70', () => {
    renderStep('AI_CONFIG');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByDisplayValue('90')).toBeInTheDocument();
    expect(screen.getByDisplayValue('70')).toBeInTheDocument();
  });

  it('treats only an explicit false as auto-reply off', () => {
    const { unmount } = renderStep('AI_CONFIG', { autoReply: false });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    unmount();

    // Anything else — including a missing key — keeps the AI answering.
    renderStep('AI_CONFIG', { autoReply: undefined });
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('sends the thresholds back as numbers, not strings', () => {
    const { onChange } = renderStep('AI_CONFIG');
    fireEvent.change(screen.getByDisplayValue('90'), { target: { value: '85' } });
    expect(onChange).toHaveBeenCalledWith({ autoExecuteThreshold: 85 });
    fireEvent.change(screen.getByDisplayValue('70'), { target: { value: '60' } });
    expect(onChange).toHaveBeenLastCalledWith({ reviewThreshold: 60 });
  });

  it('toggles auto-reply and records the tone and language', () => {
    const { onChange } = renderStep('AI_CONFIG');
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith({ autoReply: false });

    fireEvent.change(screen.getByPlaceholderText(/Friendly and concise/), {
      target: { value: 'Warm and brief' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ tone: 'Warm and brief' });

    fireEvent.change(screen.getByDisplayValue('English'), { target: { value: 'hi-en' } });
    expect(onChange).toHaveBeenLastCalledWith({ language: 'hi-en' });
  });
});

describe('TeamStep', () => {
  it('invites the drafted member with the default AGENT role', () => {
    const { onChange } = renderStep('TEAM');
    fireEvent.change(screen.getByPlaceholderText('teammate@business.in'), {
      target: { value: 'ravi@acme.in' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Invite/ }));
    expect(onChange).toHaveBeenCalledWith({
      members: [{ email: 'ravi@acme.in', role: 'AGENT' }],
    });
  });

  it('refuses a blank email', () => {
    const { onChange } = renderStep('TEAM');
    fireEvent.click(screen.getByRole('button', { name: /Invite/ }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lists saved members with their roles and removes by index', () => {
    const { onChange } = renderStep('TEAM', {
      members: [
        { email: 'ravi@acme.in', role: 'AGENT' },
        { email: 'nina@acme.in', role: 'ADMIN' },
      ],
    });
    expect(screen.getByText('ADMIN')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(onChange).toHaveBeenCalledWith({
      members: [{ email: 'nina@acme.in', role: 'ADMIN' }],
    });
  });

  it('carries the chosen role onto the invite', () => {
    const { onChange } = renderStep('TEAM');
    fireEvent.change(screen.getByPlaceholderText('teammate@business.in'), {
      target: { value: 'sam@acme.in' },
    });
    fireEvent.change(screen.getByDisplayValue('Agent'), { target: { value: 'VIEWER' } });
    fireEvent.click(screen.getByRole('button', { name: /Invite/ }));
    expect(onChange).toHaveBeenCalledWith({
      members: [{ email: 'sam@acme.in', role: 'VIEWER' }],
    });
  });
});

describe('TestStep', () => {
  it('seeds a sample question and shows no reply yet', () => {
    renderStep('TEST');
    expect(screen.getByDisplayValue('Hi, what are your opening hours?')).toBeInTheDocument();
    expect(screen.queryByText('AI responded')).toBeNull();
  });

  it('replays a previously saved test message and reply', () => {
    renderStep('TEST', { testMessage: 'Do you deliver?', testReply: 'Yes, within 5km.' });
    expect(screen.getByDisplayValue('Do you deliver?')).toBeInTheDocument();
    expect(screen.getByText('Yes, within 5km.')).toBeInTheDocument();
  });

  it('runs the test against the TEST step and saves the reply into the draft', () => {
    const { onChange } = renderStep('TEST');
    fireEvent.click(screen.getByRole('button', { name: /Send test message/ }));

    expect(chat.mutate).toHaveBeenCalledWith(
      { message: 'Hi, what are your opening hours?', step: 'TEST' },
      expect.anything(),
    );
    // The mutation's callback runs outside React's event loop, so the state
    // update it makes has to be flushed explicitly.
    act(() => chat.mutate.mock.calls[0][1].onSuccess({ reply: 'We open at 9am.' }));
    expect(onChange).toHaveBeenCalledWith({
      testMessage: 'Hi, what are your opening hours?',
      testReply: 'We open at 9am.',
      ran: true,
    });
    expect(screen.getByText('We open at 9am.')).toBeInTheDocument();
  });

  it('does not fire on a blank message', () => {
    renderStep('TEST');
    fireEvent.change(screen.getByDisplayValue('Hi, what are your opening hours?'), {
      target: { value: '  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Send test message/ }));
    expect(chat.mutate).not.toHaveBeenCalled();
  });

  it('shows a pending line and hides a stale reply while a test is running', () => {
    chat.isPending = true;
    renderStep('TEST', { testReply: 'Old answer' });
    expect(screen.getByText(/Getting the AI response/)).toBeInTheDocument();
    expect(screen.queryByText('Old answer')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Send test message/ }));
    expect(chat.mutate).not.toHaveBeenCalled();
  });
});

describe('step isolation', () => {
  it('keeps each step reading only its own slice of the draft', () => {
    // One shared draft object holds every step's keys; a step must ignore the
    // rest rather than, say, rendering the team list in the catalog.
    const shared = {
      businessName: 'Acme',
      items: [{ name: 'Haircut', type: 'SERVICE', price: '499' }],
      members: [{ email: 'ravi@acme.in', role: 'AGENT' }],
    };
    const { unmount } = renderStep('CATALOG', shared);
    expect(screen.queryByText('ravi@acme.in')).toBeNull();
    expect(screen.getByText('Haircut')).toBeInTheDocument();
    unmount();

    renderStep('TEAM', shared);
    const list = screen.getByRole('list');
    expect(within(list).getByText('ravi@acme.in')).toBeInTheDocument();
    expect(screen.queryByText('Haircut')).toBeNull();
  });
});
