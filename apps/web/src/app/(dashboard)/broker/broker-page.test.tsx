/**
 * The broker console — six KPI tiles, the notification feed, the autonomy dial
 * and the voice-command history.
 *
 * Three things here can be wrong in ways nothing else catches. The autonomy
 * dial writes on *every* interaction, so each control has to send only its own
 * field — a slider drag that also re-sends `killSwitch` would resurrect a
 * setting the broker just turned off. The voice history has to survive a status
 * string the frontend does not know about (the API owns that vocabulary and can
 * add to it), which is why the component narrows through a membership check
 * rather than indexing the tone map blind. And every write on this page is
 * STAFF+, so a VIEWER must get a readable console with no control at all.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerAlert, BrokerConsoleMetrics, BrokerSettings } from '@/lib/realty-types';
import type { VoiceCommandHistoryItem } from '@/hooks/use-voice';
import type { Role } from '@/lib/feature-types';

interface QueryStub<T> {
  data?: T;
  isLoading: boolean;
}
const idle = <T,>(data: T): QueryStub<T> => ({ data, isLoading: false });
const loading = <T,>(): QueryStub<T> => ({ data: undefined, isLoading: true });

let consoleQ: QueryStub<BrokerConsoleMetrics>;
let alertsQ: QueryStub<{ alerts: BrokerAlert[]; unread: number }>;
let settingsQ: QueryStub<BrokerSettings>;
let voiceQ: QueryStub<VoiceCommandHistoryItem[]>;
let role: Role = 'STAFF';

const updateSettings = { mutate: vi.fn(), isPending: false };
const markRead = { mutate: vi.fn(), isPending: false };
const markAll = { mutate: vi.fn(), isPending: false };

vi.mock('@/hooks/use-realty', () => ({
  useBrokerConsole: () => consoleQ,
  useBrokerAlerts: () => alertsQ,
  useBrokerSettings: () => settingsQ,
  useUpdateBrokerSettings: () => updateSettings,
  useMarkAlertRead: () => markRead,
  useMarkAllAlertsRead: () => markAll,
}));

vi.mock('@/hooks/use-voice', () => ({
  useVoiceCommands: () => voiceQ,
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

import BrokerConsolePage from './page';

function makeAlert(overrides: Partial<BrokerAlert> = {}): BrokerAlert {
  return {
    id: 'al-1',
    type: 'HOT_LEAD',
    leadId: 'lead-1',
    title: 'Asha Rao is hot',
    body: 'Budget confirmed, wants a visit this weekend.',
    payload: {},
    isRead: false,
    readAt: null,
    createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...overrides,
  };
}

function makeSettings(overrides: Partial<BrokerSettings> = {}): BrokerSettings {
  return {
    autonomyLevel: 'ASSISTED',
    autoApproveThreshold: 90,
    killSwitch: false,
    briefingEnabled: true,
    briefingHour: 7,
    briefingMinute: 30,
    hotAlertWhatsapp: null,
    ...overrides,
  };
}

function makeVoice(overrides: Partial<VoiceCommandHistoryItem> = {}): VoiceCommandHistoryItem {
  return {
    id: 'vc-1',
    transcription: 'pause follow-ups for Rahul',
    kind: 'PAUSE_CADENCE',
    status: 'executed',
    detail: 'Paused 1 cadence',
    createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    ...overrides,
  };
}

/** The KPI tile whose label is `label`, as a queryable subtree. */
const tile = (label: string) => screen.getByText(label).closest('div')!.parentElement!;

beforeEach(() => {
  vi.clearAllMocks();
  role = 'STAFF';
  consoleQ = idle({
    activeLeads: 48,
    hotLeads: 6,
    pendingApprovals: 3,
    followupsDueToday: 12,
    activeCadences: 9,
    autonomyLevel: 'ASSISTED',
    aiHandledPct: 78,
  });
  alertsQ = idle({ alerts: [makeAlert()], unread: 1 });
  settingsQ = idle(makeSettings());
  voiceQ = idle([makeVoice()]);
  updateSettings.isPending = false;
  markAll.isPending = false;
});

describe('BrokerConsolePage KPIs', () => {
  it('renders the six pipeline counters from the console payload', () => {
    render(<BrokerConsolePage />);

    expect(tile('Active leads')).toHaveTextContent('48');
    expect(tile('Hot leads')).toHaveTextContent('6');
    expect(tile('To approve')).toHaveTextContent('3');
    expect(tile('Follow-ups due')).toHaveTextContent('12');
    expect(tile('Active cadences')).toHaveTextContent('9');
    // The AI-handled tile is the only one that is a percentage.
    expect(tile('AI-handled')).toHaveTextContent('78%');
  });

  it('holds the tiles as skeletons rather than zeroes while loading', () => {
    consoleQ = loading();
    render(<BrokerConsolePage />);

    expect(screen.getByText('Active leads')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});

describe('BrokerConsolePage notifications', () => {
  it('badges the unread count and offers a bulk mark-read', () => {
    alertsQ = idle({ alerts: [makeAlert(), makeAlert({ id: 'al-2' })], unread: 2 });
    render(<BrokerConsolePage />);

    const card = screen.getByText('Notifications').closest('div')!.parentElement!;
    expect(within(card).getByText('2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    expect(markAll.mutate).toHaveBeenCalledTimes(1);
  });

  it('marks a single alert read by id', () => {
    render(<BrokerConsolePage />);

    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    expect(markRead.mutate).toHaveBeenCalledWith('al-1');
  });

  it('humanises the alert type and shows the relative age', () => {
    render(<BrokerConsolePage />);

    expect(screen.getByText('hot lead')).toBeInTheDocument();
    expect(screen.getByText('Asha Rao is hot')).toBeInTheDocument();
    expect(screen.getByText('30m')).toBeInTheDocument();
  });

  it('dims a read alert and drops its Read affordance', () => {
    alertsQ = idle({ alerts: [makeAlert({ isRead: true })], unread: 0 });
    render(<BrokerConsolePage />);

    expect(screen.getByText('Asha Rao is hot').closest('li')!.className).toContain('opacity-60');
    expect(screen.queryByRole('button', { name: 'Read' })).not.toBeInTheDocument();
    // With nothing unread there is nothing to bulk-clear either.
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
  });

  it('omits the body line when the alert has none', () => {
    alertsQ = idle({ alerts: [makeAlert({ body: null })], unread: 1 });
    render(<BrokerConsolePage />);

    expect(
      screen.queryByText('Budget confirmed, wants a visit this weekend.'),
    ).not.toBeInTheDocument();
  });

  it('says the broker is caught up when the feed is empty', () => {
    alertsQ = idle({ alerts: [], unread: 0 });
    render(<BrokerConsolePage />);

    expect(screen.getByText('All caught up')).toBeInTheDocument();
  });

  it('waits instead of claiming an empty feed while alerts load', () => {
    alertsQ = loading();
    render(<BrokerConsolePage />);

    expect(screen.getByText('Loading notifications…')).toBeInTheDocument();
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();
  });
});

describe('BrokerConsolePage autonomy dial', () => {
  it('sends only the autonomy level when the dropdown changes', () => {
    render(<BrokerConsolePage />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'AUTONOMOUS' } });

    // Only the changed field — a full-settings PATCH here would clobber
    // whatever the broker had just set elsewhere.
    expect(updateSettings.mutate).toHaveBeenCalledWith({ autonomyLevel: 'AUTONOMOUS' });
  });

  it('sends the threshold as a number, not the input string', () => {
    render(<BrokerConsolePage />);

    fireEvent.change(screen.getByRole('slider'), { target: { value: '75' } });

    expect(updateSettings.mutate).toHaveBeenCalledWith({ autoApproveThreshold: 75 });
    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('flips the kill switch on its own', () => {
    render(<BrokerConsolePage />);

    fireEvent.click(screen.getByRole('switch', { name: /Kill switch/ }));

    expect(updateSettings.mutate).toHaveBeenCalledWith({ killSwitch: true });
  });

  it('flips the morning briefing on its own and names the digest time', () => {
    render(<BrokerConsolePage />);

    // 7:30 — the minute is zero-padded, so 7:5 never reaches the operator.
    expect(screen.getByText('Daily digest at 7:30 IST.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: /Morning briefing/ }));
    expect(updateSettings.mutate).toHaveBeenCalledWith({ briefingEnabled: false });
  });

  it('zero-pads a briefing minute below ten', () => {
    settingsQ = idle(makeSettings({ briefingHour: 8, briefingMinute: 5 }));
    render(<BrokerConsolePage />);

    expect(screen.getByText('Daily digest at 8:05 IST.')).toBeInTheDocument();
  });

  it('waits for settings rather than rendering a dial at a default position', () => {
    settingsQ = loading();
    render(<BrokerConsolePage />);

    expect(screen.getByText('Loading settings…')).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('treats a missing settings payload as still loading', () => {
    settingsQ = { data: undefined, isLoading: false };
    render(<BrokerConsolePage />);

    expect(screen.getByText('Loading settings…')).toBeInTheDocument();
  });
});

describe('BrokerConsolePage voice history', () => {
  it('labels each dictated command with its outcome', () => {
    render(<BrokerConsolePage />);

    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByText('“pause follow-ups for Rahul”')).toBeInTheDocument();
    expect(screen.getByText('Paused 1 cadence')).toBeInTheDocument();
    expect(screen.getByText('2h')).toBeInTheDocument();
  });

  it('renders each of the four known outcomes with its own wording', () => {
    voiceQ = idle([
      makeVoice({ id: 'v1', status: 'executed' }),
      makeVoice({ id: 'v2', status: 'not_understood' }),
      makeVoice({ id: 'v3', status: 'unresolved' }),
      makeVoice({ id: 'v4', status: 'failed' }),
    ]);
    render(<BrokerConsolePage />);

    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByText('not understood')).toBeInTheDocument();
    expect(screen.getByText('needs confirm')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('degrades an unknown status to "not understood" instead of crashing', () => {
    // The API owns this vocabulary and can add to it; an unrecognised value
    // must not index the tone map into `undefined` and blow up the Badge.
    voiceQ = idle([makeVoice({ status: 'transcribing' as never })]);
    render(<BrokerConsolePage />);

    expect(screen.getByText('not understood')).toBeInTheDocument();
  });

  it('explains how to dictate when there is no history yet', () => {
    voiceQ = idle([]);
    render(<BrokerConsolePage />);

    expect(screen.getByText('No voice commands yet')).toBeInTheDocument();
    expect(screen.getByText(/pause follow-ups for Rahul/)).toBeInTheDocument();
  });

  it('treats a missing voice payload as an empty history', () => {
    voiceQ = { data: undefined, isLoading: false };
    render(<BrokerConsolePage />);

    expect(screen.getByText('No voice commands yet')).toBeInTheDocument();
  });

  it('waits while the history loads', () => {
    voiceQ = loading();
    render(<BrokerConsolePage />);

    expect(screen.getByText('Loading voice commands…')).toBeInTheDocument();
  });
});

describe('BrokerConsolePage read-only access', () => {
  it('gives a VIEWER the numbers but no way to change anything', () => {
    role = 'VIEWER';
    render(<BrokerConsolePage />);

    expect(tile('Active leads')).toHaveTextContent('48');
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read' })).not.toBeInTheDocument();
  });

  it('disables the whole autonomy fieldset for a VIEWER', () => {
    role = 'VIEWER';
    const { container } = render(<BrokerConsolePage />);

    // The dial stays visible — a viewer should be able to see the current
    // policy — but every control inside it is inert.
    expect(container.querySelector('fieldset')).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
  });
});
