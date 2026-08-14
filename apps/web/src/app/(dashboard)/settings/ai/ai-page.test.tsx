/**
 * Settings → AI — confidence routing and the assistant's behaviour.
 *
 * The two thresholds on this page decide whether the AI answers a customer by
 * itself, drafts for a human, or escalates, so the invariant worth pinning is
 * that the bands can never cross or collapse: each slider's range is bounded
 * by the other, so a drag past the neighbouring threshold clamps instead of
 * inverting the split. The band cards and the stacked bar are read
 * back too, because they are what the operator actually uses to reason about
 * the split — a bar that disagrees with the numbers is worse than no bar.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessSettings, ConfidenceThresholds, Role } from '@/lib/feature-types';

function makeSettings(overrides: Partial<BusinessSettings> = {}): BusinessSettings {
  return {
    aiAutonomyLevel: 'BALANCED',
    aiAutoReplyEnabled: true,
    aiConfidenceThreshold: 70,
    aiAutoExecuteThreshold: 90,
    officeHoursEnabled: false,
    officeHours: {},
    officeHoursTimezone: 'Asia/Kolkata',
    outsideHoursMessage: '',
    emailNotificationsEnabled: true,
    smsNotificationsEnabled: false,
    messageDeliveryDelayMs: 0,
    hitlEnabled: true,
    hitlAutoEscalateAfterMs: 0,
    razorpayEnabled: true,
    codEnabled: false,
    bookingEnabled: true,
    defaultSlotDurationMinutes: 30,
    defaultGreeting: 'Hi there!',
    defaultSignoff: '— Team Sunrise',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const state = {
  thresholds: {
    data: { autoExecute: 90, draftReview: 70 } as ConfidenceThresholds | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  settings: {
    data: makeSettings() as BusinessSettings | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
};

const mutations = { updateThresholds: vi.fn(), updateSettings: vi.fn() };
let role: Role = 'MANAGER';

vi.mock('@/hooks/use-settings', () => ({
  useConfidenceThresholds: () => state.thresholds,
  useBusinessSettings: () => state.settings,
  useUpdateThresholds: () => ({
    mutate: mutations.updateThresholds,
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
  useUpdateBusinessSettings: () => ({
    mutate: mutations.updateSettings,
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
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

import AiConfigPage from './page';

/** The two range inputs, in DOM order: draft-for-review then auto-execute. */
const sliders = () => screen.getAllByRole('slider') as HTMLInputElement[];
const saveButtons = () => screen.getAllByRole('button', { name: /save changes/i });

beforeEach(() => {
  state.thresholds = {
    data: { autoExecute: 90, draftReview: 70 },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  state.settings = { data: makeSettings(), isLoading: false, isError: false, refetch: vi.fn() };
  role = 'MANAGER';
  vi.clearAllMocks();
});

describe('confidence routing', () => {
  it('shows a spinner while the thresholds load', () => {
    state.thresholds = { ...state.thresholds, data: undefined, isLoading: true };
    render(<AiConfigPage />);
    expect(screen.queryByText('Confidence routing')).not.toBeInTheDocument();
  });

  it('offers a retry when the thresholds fail to load', () => {
    const refetch = vi.fn();
    state.thresholds = { data: undefined, isLoading: false, isError: true, refetch };
    render(<AiConfigPage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(refetch).toHaveBeenCalled();
  });

  it('adopts the thresholds the API returned', () => {
    render(<AiConfigPage />);
    const [draft, auto] = sliders();
    expect(draft).toHaveValue('70');
    expect(auto).toHaveValue('90');
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('labels the three bands from the current split', () => {
    render(<AiConfigPage />);
    expect(screen.getByText('< 70%')).toBeInTheDocument();
    expect(screen.getByText('70–89%')).toBeInTheDocument();
    expect(screen.getByText('≥ 90%')).toBeInTheDocument();
  });

  it('sizes the stacked bar to match the bands', () => {
    render(<AiConfigPage />);
    expect(screen.getByText('Escalate', { selector: 'div' })).toHaveStyle({ width: '70%' });
    expect(screen.getByText('Review', { selector: 'div' })).toHaveStyle({ width: '20%' });
    expect(screen.getByText('Auto', { selector: 'div' })).toHaveStyle({ width: '10%' });
  });

  it('bounds each slider by the other so the bands cannot cross', () => {
    render(<AiConfigPage />);
    const [draft, auto] = sliders();
    expect(draft).toHaveAttribute('min', '10');
    expect(draft).toHaveAttribute('max', '89');
    expect(auto).toHaveAttribute('min', '71');
    expect(auto).toHaveAttribute('max', '100');
  });

  it('refuses to drag auto-execute below the review threshold', () => {
    render(<AiConfigPage />);
    // The slider's own min is draftReview + 1, so a drag past it clamps rather
    // than inverting the bands. (The handler's extra guard is the backstop for
    // a value that arrives from anywhere other than this input.)
    fireEvent.change(sliders()[1], { target: { value: '65' } });
    const [draft, auto] = sliders();
    expect(auto).toHaveValue('71');
    expect(draft).toHaveValue('70');
    expect(screen.getByText('70–70%')).toBeInTheDocument();
  });

  it('leaves the review threshold alone when auto-execute stays above it', () => {
    render(<AiConfigPage />);
    fireEvent.change(sliders()[1], { target: { value: '95' } });
    expect(sliders()[0]).toHaveValue('70');
  });

  it('moves the review threshold on its own', () => {
    render(<AiConfigPage />);
    fireEvent.change(sliders()[0], { target: { value: '55' } });
    expect(sliders()[0]).toHaveValue('55');
    expect(screen.getByText('< 55%')).toBeInTheDocument();
    expect(sliders()[1]).toHaveAttribute('min', '56');
  });

  it('keeps Save disabled until a threshold moves', () => {
    render(<AiConfigPage />);
    expect(saveButtons()[0]).toBeDisabled();
    fireEvent.change(sliders()[0], { target: { value: '60' } });
    expect(saveButtons()[0]).toBeEnabled();
  });

  it('submits both thresholds together', () => {
    render(<AiConfigPage />);
    fireEvent.change(sliders()[0], { target: { value: '60' } });
    fireEvent.click(saveButtons()[0]);
    expect(mutations.updateThresholds).toHaveBeenCalledWith({ autoExecute: 90, draftReview: 60 });
  });

  it('explains itself instead of saving for an operator who cannot manage', () => {
    role = 'STAFF';
    render(<AiConfigPage />);
    expect(
      screen.getByText('Only a manager or owner can change confidence routing.'),
    ).toBeInTheDocument();
    expect(sliders()[0]).toBeDisabled();
  });
});

describe('AI behaviour and tone', () => {
  const autoReplySwitch = () => screen.getByRole('switch');

  it('shows a spinner while the settings load', () => {
    state.settings = { ...state.settings, data: undefined, isLoading: true };
    render(<AiConfigPage />);
    expect(screen.queryByText('AI behaviour & tone')).not.toBeInTheDocument();
  });

  it('offers a retry when the settings fail to load', () => {
    const refetch = vi.fn();
    state.settings = { data: undefined, isLoading: false, isError: true, refetch };
    render(<AiConfigPage />);
    const retries = screen.getAllByRole('button', { name: 'Try again' });
    fireEvent.click(retries[retries.length - 1]);
    expect(refetch).toHaveBeenCalled();
  });

  it('adopts the saved behaviour', () => {
    render(<AiConfigPage />);
    expect(autoReplySwitch()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('combobox')).toHaveValue('BALANCED');
    expect(screen.getByDisplayValue('Hi there!')).toBeInTheDocument();
    expect(screen.getByDisplayValue('— Team Sunrise')).toBeInTheDocument();
  });

  it('leaves the greeting and sign-off blank when the business set neither', () => {
    state.settings = {
      ...state.settings,
      data: makeSettings({ defaultGreeting: undefined, defaultSignoff: undefined }),
    };
    render(<AiConfigPage />);
    expect(screen.getByPlaceholderText(/thanks for reaching out/i)).toHaveValue('');
    expect(screen.getByPlaceholderText('— Team [Business]')).toHaveValue('');
  });

  it('offers the three autonomy levels', () => {
    render(<AiConfigPage />);
    const select = screen.getByRole('combobox');
    expect(within(select).getAllByRole('option')).toHaveLength(3);
    expect(
      within(select).getByRole('option', { name: /aggressive — maximise automation/i }),
    ).toBeInTheDocument();
  });

  it('keeps Save disabled until something changes', () => {
    render(<AiConfigPage />);
    const save = saveButtons()[1];
    expect(save).toBeDisabled();
    fireEvent.click(autoReplySwitch());
    expect(saveButtons()[1]).toBeEnabled();
  });

  it('submits the whole behaviour block', () => {
    render(<AiConfigPage />);
    fireEvent.click(autoReplySwitch());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'AGGRESSIVE' } });
    fireEvent.change(screen.getByDisplayValue('Hi there!'), { target: { value: 'Namaste!' } });
    fireEvent.change(screen.getByDisplayValue('— Team Sunrise'), { target: { value: '— Sunrise' } });
    fireEvent.click(saveButtons()[1]);

    expect(mutations.updateSettings).toHaveBeenCalledWith({
      aiAutoReplyEnabled: false,
      aiAutonomyLevel: 'AGGRESSIVE',
      defaultGreeting: 'Namaste!',
      defaultSignoff: '— Sunrise',
    });
  });

  it('goes back to clean when an edit is reverted', () => {
    render(<AiConfigPage />);
    fireEvent.click(autoReplySwitch());
    fireEvent.click(autoReplySwitch());
    expect(saveButtons()[1]).toBeDisabled();
  });

  it('explains itself instead of saving for an operator who cannot manage', () => {
    role = 'VIEWER';
    render(<AiConfigPage />);
    expect(screen.getByText('Only a manager or owner can change AI behaviour.')).toBeInTheDocument();
    expect(autoReplySwitch()).toBeDisabled();
  });
});
