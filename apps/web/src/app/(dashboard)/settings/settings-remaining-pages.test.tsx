/**
 * The three settings tabs that had no coverage: API keys, Integrations, Setup.
 *
 * Each one is mostly a static catalogue, so the tests concentrate on the parts
 * that can be wrong. On API keys that is the provider catalogue itself — the
 * page hands each card a `credential` looked up by provider key, and a mismatch
 * there would show one integration's saved state under another's name. On
 * Integrations it is the role split: connect/disconnect are MANAGER-only while
 * "Sync now" is open to STAFF, so a VIEWER must see neither and a STAFF must
 * see exactly one. On Setup it is the per-step status mapping and the progress
 * bar width, which is the only place `percentComplete` is rendered as geometry
 * rather than text.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarIntegration, Role } from '@/lib/feature-types';
import type { OnboardingProgress, OnboardingStepState } from '@/lib/onboarding-types';

// ── Shared query stubs ──────────────────────────────────────────────────────

interface QueryStub<T> {
  data?: T;
  isLoading: boolean;
  isError: boolean;
}
const idle = <T,>(data: T): QueryStub<T> => ({ data, isLoading: false, isError: false });
const loading = <T,>(): QueryStub<T> => ({ data: undefined, isLoading: true, isError: false });
const failed = <T,>(): QueryStub<T> => ({ data: undefined, isLoading: false, isError: true });

const refetchCreds = vi.fn();
const refetchCalendar = vi.fn();
const refetchProgress = vi.fn();

let credentialsQ: QueryStub<Record<string, { configured: boolean }>>;
let calendarQ: QueryStub<CalendarIntegration>;
let progressQ: QueryStub<OnboardingProgress>;
let role: Role = 'MANAGER';

const connect = { mutate: vi.fn(), isPending: false };
const disconnect = { mutate: vi.fn(), isPending: false };
const sync = { mutate: vi.fn(), isPending: false, isSuccess: false };

vi.mock('@/hooks/use-integrations', () => ({
  useIntegrationCredentials: () => ({ ...credentialsQ, refetch: refetchCreds }),
}));

vi.mock('@/hooks/use-settings', () => ({
  useCalendarIntegration: () => ({ ...calendarQ, refetch: refetchCalendar }),
  useConnectCalendar: () => connect,
  useDisconnectCalendar: () => disconnect,
  useSyncCalendar: () => sync,
}));

vi.mock('@/hooks/use-onboarding', () => ({
  useOnboardingProgress: () => ({ ...progressQ, refetch: refetchProgress }),
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

// The cards and the wizard have their own tests; here they are stand-ins that
// record what the page decided to hand them.
vi.mock('@/components/settings/integration-card', () => ({
  IntegrationCard: ({
    def,
    credential,
  }: {
    def: { provider: string; label: string; fields: { name: string }[] };
    credential?: { configured: boolean };
  }) => (
    <div
      data-testid={`integration-${def.provider}`}
      data-configured={String(Boolean(credential?.configured))}
      data-fields={def.fields.map((f) => f.name).join(',')}
    >
      {def.label}
    </div>
  ),
}));

vi.mock('@/components/settings/api-keys-manager', () => ({
  ApiKeysManager: () => <div data-testid="api-keys-manager" />,
}));

vi.mock('@/components/onboarding/onboarding-wizard', () => ({
  OnboardingWizard: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div data-testid="wizard">
        <button onClick={onClose}>close wizard</button>
      </div>
    ) : null,
}));

import ApiKeysPage from './api-keys/page';
import IntegrationsPage from './integrations/page';
import SetupWizardSettingsPage from './setup/page';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<OnboardingStepState> = {}): OnboardingStepState {
  return {
    step: 'CHANNELS',
    status: 'pending',
    definition: {
      id: 'CHANNELS',
      title: 'Connect a channel',
      description: 'Hook up WhatsApp.',
      optional: false,
    },
    data: {},
    updatedAt: null,
    ...overrides,
  };
}

function makeProgress(overrides: Partial<OnboardingProgress> = {}): OnboardingProgress {
  return {
    steps: [makeStep()],
    currentStep: 'CHANNELS',
    completedCount: 0,
    skippedCount: 0,
    totalSteps: 1,
    percentComplete: 40,
    isComplete: false,
    startedAt: '2026-08-01T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  role = 'MANAGER';
  credentialsQ = idle({ RAZORPAY: { configured: true } });
  calendarQ = idle({ connected: false, syncEnabled: false });
  progressQ = idle(makeProgress());
  connect.isPending = false;
  disconnect.isPending = false;
  sync.isPending = false;
  sync.isSuccess = false;
});

// ── API keys ────────────────────────────────────────────────────────────────

describe('ApiKeysPage', () => {
  it('groups the five providers under Payments, Messaging and Email', () => {
    render(<ApiKeysPage />);

    expect(screen.getByTestId('integration-RAZORPAY')).toBeInTheDocument();
    expect(screen.getByTestId('integration-STRIPE')).toBeInTheDocument();
    expect(screen.getByTestId('integration-WHATSAPP')).toBeInTheDocument();
    expect(screen.getByTestId('integration-SMS')).toBeInTheDocument();
    expect(screen.getByTestId('integration-SMTP')).toBeInTheDocument();
    expect(screen.getByText('Payments')).toBeInTheDocument();
    expect(screen.getByText('Messaging')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('gives each card only its own saved credential', () => {
    render(<ApiKeysPage />);

    // The lookup is keyed by provider — Razorpay is configured, Stripe is not.
    expect(screen.getByTestId('integration-RAZORPAY')).toHaveAttribute('data-configured', 'true');
    expect(screen.getByTestId('integration-STRIPE')).toHaveAttribute('data-configured', 'false');
  });

  it('declares the SMS sub-provider fields the card conditionally reveals', () => {
    render(<ApiKeysPage />);

    // Both Twilio and MSG91 field sets ship in one definition; the card shows
    // whichever matches `subProvider`, so both must be present here.
    const fields = screen.getByTestId('integration-SMS').getAttribute('data-fields');
    expect(fields).toContain('twilioAccountSid');
    expect(fields).toContain('msg91AuthKey');
  });

  it('keeps the developer API-key manager below the bring-your-own credentials', () => {
    render(<ApiKeysPage />);

    expect(screen.getByTestId('api-keys-manager')).toBeInTheDocument();
    expect(screen.getByText('Developer')).toBeInTheDocument();
  });

  it('shows a loading state instead of an empty catalogue', () => {
    credentialsQ = loading();
    render(<ApiKeysPage />);

    expect(screen.queryByTestId('integration-RAZORPAY')).not.toBeInTheDocument();
  });

  it('offers a retry when the credential lookup fails', () => {
    credentialsQ = failed();
    render(<ApiKeysPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchCreds).toHaveBeenCalledTimes(1);
  });
});

// ── Integrations ────────────────────────────────────────────────────────────

describe('IntegrationsPage', () => {
  it('offers Connect while the calendar is unlinked', () => {
    render(<IntegrationsPage />);

    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sync now/ })).not.toBeInTheDocument();
  });

  it('sends the operator to the OAuth URL the connect mutation returns', () => {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, href: original.href },
      writable: true,
      configurable: true,
    });
    connect.mutate.mockImplementation((_vars, opts) =>
      opts.onSuccess({ authUrl: 'https://accounts.google.com/o/oauth2/consent' }),
    );

    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));

    expect(window.location.href).toBe('https://accounts.google.com/o/oauth2/consent');

    Object.defineProperty(window, 'location', {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  it('stays put when the connect response carries no auth URL', () => {
    connect.mutate.mockImplementation((_vars, opts) => opts.onSuccess(undefined));

    expect(() => {
      render(<IntegrationsPage />);
      fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    }).not.toThrow();
  });

  it('shows the linked account and the last sync once connected', () => {
    calendarQ = idle({
      connected: true,
      syncEnabled: true,
      accountEmail: 'ops@sharma.in',
      lastSyncedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    render(<IntegrationsPage />);

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('ops@sharma.in')).toBeInTheDocument();
    expect(screen.getByText('2h')).toBeInTheDocument();
  });

  it('says "never" rather than an empty cell for a calendar that has not synced', () => {
    calendarQ = idle({ connected: true, syncEnabled: true, accountEmail: 'ops@sharma.in' });
    render(<IntegrationsPage />);

    expect(screen.getByText('never')).toBeInTheDocument();
  });

  it('lets a STAFF member sync but not disconnect', () => {
    // /bookings/calendar/sync is undecorated (STAFF+); connect and disconnect
    // are @Roles(MANAGER).
    role = 'STAFF';
    calendarQ = idle({ connected: true, syncEnabled: true });
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Sync now/ }));
    expect(sync.mutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('gives a VIEWER no write control at all', () => {
    role = 'VIEWER';
    calendarQ = idle({ connected: true, syncEnabled: true });
    render(<IntegrationsPage />);

    expect(screen.queryByRole('button', { name: /Sync now/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('hides Connect from a VIEWER on an unlinked calendar', () => {
    role = 'VIEWER';
    render(<IntegrationsPage />);

    expect(screen.queryByRole('button', { name: /Connect/ })).not.toBeInTheDocument();
  });

  it('disconnects on demand for a manager', () => {
    calendarQ = idle({ connected: true, syncEnabled: true });
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(disconnect.mutate).toHaveBeenCalledTimes(1);
  });

  it('confirms a completed sync inline', () => {
    calendarQ = idle({ connected: true, syncEnabled: true });
    sync.isSuccess = true;
    render(<IntegrationsPage />);

    expect(screen.getByText('Calendar synced successfully.')).toBeInTheDocument();
  });

  it('treats a missing payload the same as a failed request', () => {
    calendarQ = { data: undefined, isLoading: false, isError: false };
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchCalendar).toHaveBeenCalledTimes(1);
  });

  it('waits rather than rendering a half-known state', () => {
    calendarQ = loading();
    render(<IntegrationsPage />);

    expect(screen.queryByText('Google Calendar')).not.toBeInTheDocument();
  });
});

// ── Setup wizard ────────────────────────────────────────────────────────────

describe('SetupWizardSettingsPage', () => {
  it('renders the progress percentage as both text and bar width', () => {
    const { container } = render(<SetupWizardSettingsPage />);

    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(container.querySelector<HTMLElement>('.bg-primary')?.style.width).toBe('40%');
  });

  it('labels each step by its status', () => {
    progressQ = idle(
      makeProgress({
        steps: [
          makeStep({ step: 'WELCOME', status: 'completed' }),
          makeStep({ step: 'CATALOG', status: 'skipped' }),
          makeStep({ step: 'TEAM', status: 'pending' }),
          makeStep({
            step: 'TEST',
            status: 'pending',
            definition: {
              id: 'TEST',
              title: 'Send a test message',
              description: '',
              optional: true,
            },
          }),
        ],
      }),
    );
    render(<SetupWizardSettingsPage />);

    const rows = screen.getAllByRole('listitem');
    expect(within(rows[0]).getByText('Done')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Skipped')).toBeInTheDocument();
    // A pending step reads Required or Optional depending on the definition —
    // that is the only place `optional` reaches the operator.
    expect(within(rows[2]).getByText('Required')).toBeInTheDocument();
    expect(within(rows[3]).getByText('Optional')).toBeInTheDocument();
  });

  it('invites the operator to continue an unfinished setup', () => {
    render(<SetupWizardSettingsPage />);

    expect(screen.getByRole('button', { name: /Continue setup/ })).toBeInTheDocument();
    expect(screen.queryByText('Complete')).not.toBeInTheDocument();
  });

  it('offers a re-run once setup is complete', () => {
    progressQ = idle(makeProgress({ isComplete: true, percentComplete: 100 }));
    render(<SetupWizardSettingsPage />);

    expect(screen.getByRole('button', { name: /Re-run setup wizard/ })).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('opens and closes the wizard without leaving the settings tab', () => {
    render(<SetupWizardSettingsPage />);

    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Continue setup/ }));
    expect(screen.getByTestId('wizard')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'close wizard' }));
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument();
    expect(screen.getByText('Setup wizard')).toBeInTheDocument();
  });

  it('offers a retry when progress cannot be loaded', () => {
    progressQ = failed();
    render(<SetupWizardSettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchProgress).toHaveBeenCalledTimes(1);
  });

  it('waits while progress is in flight', () => {
    progressQ = loading();
    render(<SetupWizardSettingsPage />);

    expect(screen.queryByText('Setup wizard')).not.toBeInTheDocument();
  });
});
