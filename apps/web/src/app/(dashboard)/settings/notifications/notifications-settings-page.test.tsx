/**
 * Settings → Notifications.
 *
 * The page is three cards over one PATCH, so the tests centre on the dirty
 * calculation, which is the only non-trivial logic here: quiet hours default
 * to 22:00–08:00 client-side when the server has never stored them, and a form
 * that compares those defaults against `undefined` would open permanently
 * dirty and let an operator "save" changes they never made. The dependent
 * fields — the email box, the phone box, the time range — appear only behind
 * their own switch, so each is asserted in both states.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusinessSettings, Role } from '@/lib/feature-types';

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
    notificationEmail: 'alerts@sunrise.in',
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
  settings: {
    data: makeSettings() as BusinessSettings | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
};

const update = vi.fn();
let role: Role = 'MANAGER';

vi.mock('@/hooks/use-settings', () => ({
  useBusinessSettings: () => state.settings,
  useUpdateBusinessSettings: () => ({
    mutate: update,
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

import NotificationsPage from './page';

/** In DOM order: email, SMS, quiet hours. */
const switches = () => screen.getAllByRole('switch');
const save = () => screen.getByRole('button', { name: /save changes/i });

beforeEach(() => {
  state.settings = { data: makeSettings(), isLoading: false, isError: false, refetch: vi.fn() };
  role = 'MANAGER';
  vi.clearAllMocks();
});

describe('NotificationsPage', () => {
  it('shows a spinner while the settings load', () => {
    state.settings = { ...state.settings, data: undefined, isLoading: true };
    render(<NotificationsPage />);
    expect(screen.queryByText('Delivery channels')).not.toBeInTheDocument();
  });

  it('offers a retry when the settings fail to load', () => {
    const refetch = vi.fn();
    state.settings = { data: undefined, isLoading: false, isError: true, refetch };
    render(<NotificationsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('opens clean even though quiet hours were never stored', () => {
    render(<NotificationsPage />);
    expect(save()).toBeDisabled();
  });

  it('adopts the saved delivery preferences', () => {
    render(<NotificationsPage />);
    const [email, sms, quiet] = switches();
    expect(email).toHaveAttribute('aria-checked', 'true');
    expect(sms).toHaveAttribute('aria-checked', 'false');
    expect(quiet).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByDisplayValue('alerts@sunrise.in')).toBeInTheDocument();
  });

  it('hides the email box when email alerts are off', () => {
    state.settings = { ...state.settings, data: makeSettings({ emailNotificationsEnabled: false }) };
    render(<NotificationsPage />);
    expect(screen.queryByPlaceholderText('alerts@business.in')).not.toBeInTheDocument();
    fireEvent.click(switches()[0]);
    expect(screen.getByPlaceholderText('alerts@business.in')).toBeInTheDocument();
  });

  it('reveals the phone box only once SMS alerts are on', () => {
    render(<NotificationsPage />);
    expect(screen.queryByPlaceholderText('+91…')).not.toBeInTheDocument();
    fireEvent.click(switches()[1]);
    expect(screen.getByPlaceholderText('+91…')).toBeInTheDocument();
  });

  it('starts an empty phone box blank rather than as undefined', () => {
    render(<NotificationsPage />);
    fireEvent.click(switches()[1]);
    expect(screen.getByPlaceholderText('+91…')).toHaveValue('');
  });

  it('reveals the quiet-hours range with the 22:00–08:00 defaults', () => {
    render(<NotificationsPage />);
    expect(screen.queryByDisplayValue('22:00')).not.toBeInTheDocument();
    fireEvent.click(switches()[2]);
    expect(screen.getByDisplayValue('22:00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('08:00')).toBeInTheDocument();
  });

  it('keeps the stored quiet hours when the business has set them', () => {
    state.settings = {
      ...state.settings,
      data: makeSettings({
        quietHoursEnabled: true,
        quietHoursStart: '21:30',
        quietHoursEnd: '07:15',
      }),
    };
    render(<NotificationsPage />);
    expect(screen.getByDisplayValue('21:30')).toBeInTheDocument();
    expect(screen.getByDisplayValue('07:15')).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('turns dirty on an edited address and clean again when reverted', () => {
    render(<NotificationsPage />);
    fireEvent.change(screen.getByDisplayValue('alerts@sunrise.in'), {
      target: { value: 'ops@sunrise.in' },
    });
    expect(save()).toBeEnabled();
    fireEvent.change(screen.getByDisplayValue('ops@sunrise.in'), {
      target: { value: 'alerts@sunrise.in' },
    });
    expect(save()).toBeDisabled();
  });

  it('submits every preference in one patch', () => {
    render(<NotificationsPage />);
    fireEvent.click(switches()[1]);
    fireEvent.change(screen.getByPlaceholderText('+91…'), { target: { value: '+919800000001' } });
    fireEvent.click(switches()[2]);
    fireEvent.change(screen.getByDisplayValue('22:00'), { target: { value: '23:00' } });
    fireEvent.click(save());

    expect(update).toHaveBeenCalledWith({
      emailNotificationsEnabled: true,
      smsNotificationsEnabled: true,
      notificationEmail: 'alerts@sunrise.in',
      notificationPhone: '+919800000001',
      quietHoursEnabled: true,
      quietHoursStart: '23:00',
      quietHoursEnd: '08:00',
    });
  });

  it('records a change to the quiet-hours end time', () => {
    render(<NotificationsPage />);
    fireEvent.click(switches()[2]);
    fireEvent.change(screen.getByDisplayValue('08:00'), { target: { value: '09:00' } });
    fireEvent.click(save());
    expect(update.mock.calls[0][0]).toMatchObject({ quietHoursEnd: '09:00' });
  });

  it('lists the events that trigger an alert and the channels each uses', () => {
    render(<NotificationsPage />);
    expect(screen.getByText('New HITL task needs review')).toBeInTheDocument();
    expect(screen.getByText('A channel went down')).toBeInTheDocument();
    expect(screen.getAllByText('In-app')).toHaveLength(5);
    expect(screen.getAllByText('SMS')).toHaveLength(2);
  });

  it('explains itself instead of saving for an operator who cannot manage', () => {
    role = 'STAFF';
    render(<NotificationsPage />);
    expect(
      screen.getByText('Only a manager or owner can change notification settings.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    expect(switches()[0]).toBeDisabled();
  });
});
