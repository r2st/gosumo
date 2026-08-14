/**
 * Settings → Business profile, and the tab shell every settings page sits in.
 *
 * Two behaviours carry the weight here. The forms are dirty-gated: Save stays
 * disabled until a field actually differs from what the server returned, so a
 * test that only checks "Save exists" would pass against a form that can never
 * be submitted. And both cards are MANAGER-only writes, so a STAFF operator
 * must get an inert fieldset plus an explanation rather than controls that
 * look live and fail at the API.
 *
 * The shell's tab matching is covered too: `/settings/team` also starts with
 * `/settings`, so the longest match has to win or every sub-page highlights
 * the profile tab.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessSettings } from '@/lib/feature-types';
import type { BusinessProfile } from '@/lib/types';
import type { Role } from '@/lib/feature-types';

function makeProfile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  return {
    id: 'b1',
    name: 'Sunrise Interiors',
    industry: 'RETAIL',
    timezone: 'Asia/Kolkata',
    description: 'Home interiors studio',
    phone: '+919000000000',
    email: 'hi@sunrise.in',
    website: 'https://sunrise.in',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as BusinessProfile;
}

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
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const state = {
  profile: {
    data: makeProfile() as BusinessProfile | undefined,
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

const mutations = { updateProfile: vi.fn(), updateSettings: vi.fn() };
const flags = { profilePending: false, profileSuccess: false, profileError: false };
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
let role: Role = 'MANAGER';
let pathname = '/settings';

vi.mock('@/hooks/use-settings', () => ({
  useBusinessProfile: () => state.profile,
  useBusinessSettings: () => state.settings,
  useUpdateBusinessProfile: () => ({
    mutate: mutations.updateProfile,
    isPending: flags.profilePending,
    isSuccess: flags.profileSuccess,
    isError: flags.profileError,
  }),
  useUpdateBusinessSettings: () => ({
    mutate: mutations.updateSettings,
    isPending: false,
    isSuccess: false,
    isError: false,
  }),
}));

vi.mock('@/providers/toast-provider', () => ({ useToast: () => toast }));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import BusinessProfilePage from './page';
import SettingsLayout from './layout';
import { LanguageProvider } from '@/providers/language-provider';

const renderLayout = () =>
  render(
    <LanguageProvider>
      <SettingsLayout>
        <div data-testid="child" />
      </SettingsLayout>
    </LanguageProvider>,
  );

beforeEach(() => {
  state.profile = { data: makeProfile(), isLoading: false, isError: false, refetch: vi.fn() };
  state.settings = { data: makeSettings(), isLoading: false, isError: false, refetch: vi.fn() };
  flags.profilePending = false;
  flags.profileSuccess = false;
  flags.profileError = false;
  role = 'MANAGER';
  pathname = '/settings';
  vi.clearAllMocks();
});

// ── The tab shell ────────────────────────────────────────────────────────────

describe('SettingsLayout', () => {
  it('renders the page under a tab for every settings surface', () => {
    renderLayout();
    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(10);
  });

  it('marks the profile tab active at the settings root', () => {
    renderLayout();
    const profile = screen.getAllByRole('link')[0];
    expect(profile).toHaveAttribute('href', '/settings');
    expect(profile.className).toContain('border-primary');
  });

  it('prefers the longest matching path so a sub-page does not also match the root', () => {
    pathname = '/settings/team';
    renderLayout();
    const [profile] = screen.getAllByRole('link');
    const team = screen.getAllByRole('link').find((l) => l.getAttribute('href') === '/settings/team')!;
    expect(team.className).toContain('border-primary');
    expect(profile.className).not.toContain('border-primary');
  });

  it('keeps a tab active on a nested route beneath it', () => {
    pathname = '/settings/channels/whatsapp';
    renderLayout();
    const channels = screen
      .getAllByRole('link')
      .find((l) => l.getAttribute('href') === '/settings/channels')!;
    expect(channels.className).toContain('border-primary');
  });

  it('falls back to the profile tab on a path that matches nothing', () => {
    pathname = '/somewhere-else';
    renderLayout();
    expect(screen.getAllByRole('link')[0].className).toContain('border-primary');
  });
});

// ── Business profile ─────────────────────────────────────────────────────────

describe('the business profile form', () => {
  const nameInput = () => screen.getByDisplayValue('Sunrise Interiors');
  const saveButtons = () => screen.getAllByRole('button', { name: /save changes/i });

  it('shows a spinner while the profile loads', () => {
    state.profile = { ...state.profile, data: undefined, isLoading: true };
    render(<BusinessProfilePage />);
    expect(screen.queryByText('Business profile')).not.toBeInTheDocument();
  });

  it('offers a retry when the profile fails to load', () => {
    const refetch = vi.fn();
    state.profile = { data: undefined, isLoading: false, isError: true, refetch };
    render(<BusinessProfilePage />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0]);
    expect(refetch).toHaveBeenCalled();
  });

  it('fills every field from the loaded profile', () => {
    render(<BusinessProfilePage />);
    expect(nameInput()).toBeInTheDocument();
    expect(screen.getByDisplayValue('Home interiors studio')).toBeInTheDocument();
    expect(screen.getByDisplayValue('+919000000000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('hi@sunrise.in')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://sunrise.in')).toBeInTheDocument();
  });

  it('leaves optional fields blank rather than printing undefined', () => {
    state.profile = {
      ...state.profile,
      data: makeProfile({ description: undefined, phone: undefined, logo: undefined }),
    };
    render(<BusinessProfilePage />);
    expect(screen.getByPlaceholderText('What your business does…')).toHaveValue('');
    expect(screen.getByPlaceholderText('+91…')).toHaveValue('');
  });

  it('locks the industry, which is set at onboarding', () => {
    render(<BusinessProfilePage />);
    expect(screen.getByDisplayValue('RETAIL')).toBeDisabled();
  });

  it('previews the logo once a URL is entered', () => {
    render(<BusinessProfilePage />);
    expect(screen.queryByAltText('Logo')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('https://…/logo.png'), {
      target: { value: 'https://cdn/logo.png' },
    });
    expect(screen.getByAltText('Logo')).toHaveAttribute('src', 'https://cdn/logo.png');
  });

  it('keeps Save disabled until a field actually changes', () => {
    render(<BusinessProfilePage />);
    expect(saveButtons()[0]).toBeDisabled();
    fireEvent.change(nameInput(), { target: { value: 'Sunrise Interiors LLP' } });
    expect(saveButtons()[0]).toBeEnabled();
  });

  it('goes back to clean when the edit is typed away again', () => {
    render(<BusinessProfilePage />);
    fireEvent.change(nameInput(), { target: { value: 'Changed' } });
    fireEvent.change(screen.getByDisplayValue('Changed'), { target: { value: 'Sunrise Interiors' } });
    expect(saveButtons()[0]).toBeDisabled();
  });

  it('submits the whole form and celebrates a save', () => {
    render(<BusinessProfilePage />);
    fireEvent.change(nameInput(), { target: { value: 'Sunrise Interiors LLP' } });
    fireEvent.click(saveButtons()[0]);

    expect(mutations.updateProfile).toHaveBeenCalledTimes(1);
    expect(mutations.updateProfile.mock.calls[0][0]).toMatchObject({
      name: 'Sunrise Interiors LLP',
      timezone: 'Asia/Kolkata',
      email: 'hi@sunrise.in',
    });

    mutations.updateProfile.mock.calls[0][1].onSuccess();
    expect(toast.success).toHaveBeenCalledWith('Business profile saved.', {
      title: 'Settings saved',
    });
  });

  it('warns rather than silently dropping the edit when the save fails', () => {
    render(<BusinessProfilePage />);
    fireEvent.change(nameInput(), { target: { value: 'X' } });
    fireEvent.click(saveButtons()[0]);
    mutations.updateProfile.mock.calls[0][1].onError();
    expect(toast.error).toHaveBeenCalledWith('Could not save your changes. Please try again.');
  });

  it('offers the supported timezones', () => {
    render(<BusinessProfilePage />);
    const tz = screen.getAllByRole('combobox')[0];
    expect(within(tz).getAllByRole('option')).toHaveLength(7);
    expect(within(tz).getByRole('option', { name: 'Asia/Kolkata' })).toBeInTheDocument();
  });

  it('goes inert with an explanation for an operator who cannot manage', () => {
    role = 'STAFF';
    render(<BusinessProfilePage />);
    expect(
      screen.getByText('Only a manager or owner can edit the business profile.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(nameInput()).toBeDisabled();
  });

  it('reports a save in flight and a save that landed', () => {
    flags.profilePending = true;
    render(<BusinessProfilePage />);
    expect(saveButtons()[0]).toBeDisabled();

    flags.profilePending = false;
    flags.profileSuccess = true;
    render(<BusinessProfilePage />);
    expect(screen.getAllByText('Saved')[0]).toBeInTheDocument();

    flags.profileSuccess = false;
    flags.profileError = true;
    render(<BusinessProfilePage />);
    expect(screen.getAllByText('Couldn’t save')[0]).toBeInTheDocument();
  });
});

// ── Business hours ───────────────────────────────────────────────────────────

describe('the business hours form', () => {
  const enforceSwitch = () => screen.getAllByRole('switch')[0];

  it('shows a spinner while the settings load', () => {
    state.settings = { ...state.settings, data: undefined, isLoading: true };
    render(<BusinessProfilePage />);
    expect(screen.queryByText('Business hours')).not.toBeInTheDocument();
  });

  it('offers a retry when the settings fail to load', () => {
    const refetch = vi.fn();
    state.settings = { data: undefined, isLoading: false, isError: true, refetch };
    render(<BusinessProfilePage />);
    const retries = screen.getAllByRole('button', { name: 'Try again' });
    fireEvent.click(retries[retries.length - 1]);
    expect(refetch).toHaveBeenCalled();
  });

  it('hides the schedule until hours are enforced', () => {
    render(<BusinessProfilePage />);
    expect(screen.queryByText('Monday')).not.toBeInTheDocument();
    fireEvent.click(enforceSwitch());
    expect(screen.getByText('Monday')).toBeInTheDocument();
    expect(screen.getByText('Away message')).toBeInTheDocument();
  });

  it('opens with the schedule already showing when hours are enforced', () => {
    state.settings = {
      ...state.settings,
      data: makeSettings({
        officeHoursEnabled: true,
        officeHours: { monday: { isOpen: true, openTime: '10:00', closeTime: '19:00' } },
        outsideHoursMessage: 'We are closed.',
      }),
    };
    render(<BusinessProfilePage />);
    expect(screen.getByDisplayValue('10:00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('We are closed.')).toBeInTheDocument();
  });

  it('saves the toggle, the schedule and the away message together', () => {
    render(<BusinessProfilePage />);
    fireEvent.click(enforceSwitch());
    fireEvent.change(screen.getByPlaceholderText(/we’re currently closed/i), {
      target: { value: 'Back at 10am.' },
    });
    const saves = screen.getAllByRole('button', { name: /save changes/i });
    fireEvent.click(saves[saves.length - 1]);

    expect(mutations.updateSettings).toHaveBeenCalledTimes(1);
    expect(mutations.updateSettings.mock.calls[0][0]).toEqual({
      officeHoursEnabled: true,
      officeHours: {},
      outsideHoursMessage: 'Back at 10am.',
    });
  });

  it('toasts on both outcomes of the hours save', () => {
    render(<BusinessProfilePage />);
    fireEvent.click(enforceSwitch());
    const saves = screen.getAllByRole('button', { name: /save changes/i });
    fireEvent.click(saves[saves.length - 1]);

    mutations.updateSettings.mock.calls[0][1].onSuccess();
    expect(toast.success).toHaveBeenCalledWith('Business hours saved.', { title: 'Settings saved' });
    mutations.updateSettings.mock.calls[0][1].onError();
    expect(toast.error).toHaveBeenCalledWith('Could not save your changes. Please try again.');
  });

  it('records an edit to a single day', () => {
    state.settings = {
      ...state.settings,
      data: makeSettings({
        officeHoursEnabled: true,
        officeHours: { monday: { isOpen: true, openTime: '09:00', closeTime: '18:00' } },
      }),
    };
    render(<BusinessProfilePage />);
    fireEvent.change(screen.getByDisplayValue('18:00'), { target: { value: '20:00' } });
    const saves = screen.getAllByRole('button', { name: /save changes/i });
    fireEvent.click(saves[saves.length - 1]);

    expect(mutations.updateSettings.mock.calls[0][0].officeHours).toEqual({
      monday: { isOpen: true, openTime: '09:00', closeTime: '20:00' },
    });
  });

  it('explains itself instead of saving for an operator who cannot manage', () => {
    role = 'VIEWER';
    render(<BusinessProfilePage />);
    expect(screen.getByText('Only a manager or owner can change business hours.')).toBeInTheDocument();
    expect(enforceSwitch()).toBeDisabled();
  });
});
