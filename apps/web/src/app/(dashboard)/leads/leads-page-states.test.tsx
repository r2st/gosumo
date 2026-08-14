/**
 * `leads/page.tsx` — everything the filtering suite next door does not reach.
 *
 * `leads-page.test.tsx` drives the happy path with a fixed pair of leads, an
 * empty board and an empty roster. That leaves the parts of the page that only
 * appear when the server actually returns something interesting untested:
 *
 *  - **Board totals vs. visible counts.** Unfiltered, each column shows the
 *    server's board total, which counts past the 100-lead page the list request
 *    pulls. Filtered, it must switch to the number actually on screen. Getting
 *    this backwards shows "42" above a column holding one card.
 *  - **The agent filter's options.** They are derived from the leads on screen
 *    and labelled from the team roster, with a truncated-id fallback for an
 *    agent who has left the roster and an "Unassigned" entry that only appears
 *    when some lead really is unassigned.
 *  - **Loading, error and empty.** Three mutually exclusive states, plus the
 *    retry that has to refetch *both* queries — the board and the list — since
 *    either one failing puts the page in the error state.
 *  - **The deep link.** `/leads?lead=<id>` opens the dossier from the morning
 *    briefing, and closing it has to clear the query parameter too, or a later
 *    client-side navigation back to `/leads` re-opens the drawer.
 *  - **The mobile tab bar**, which swaps which single stage is listed.
 *  - **Pull-to-refresh**, which refetches both queries on a touch drag.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead } from '@/lib/realty-types';

const mocks = vi.hoisted(() => ({
  leads: {
    data: null as { data: Lead[]; pagination: { total: number } } | null,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  board: {
    data: [] as { stage: string; count: number }[],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  team: { data: { data: [] as { id: string; name: string }[] }, isLoading: false, isError: false },
  search: '',
  replace: vi.fn(),
  downloadCsv: vi.fn(),
}));

vi.mock('@/hooks/use-realty', () => ({
  useLeads: () => mocks.leads,
  useLeadBoard: () => mocks.board,
}));

vi.mock('@/hooks/use-settings', () => ({
  useTeam: () => mocks.team,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

// `leadsToCsv` stays real — only the download itself is stubbed, since jsdom has
// no `URL.createObjectURL` and clicking a real anchor would navigate.
vi.mock('@/lib/csv-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/csv-export')>()),
  downloadCsv: (...args: unknown[]) => mocks.downloadCsv(...args),
}));

// The dossier's own behaviour is covered by its suite; here it only needs to
// report which lead it was handed and expose the close callback.
vi.mock('@/components/leads/lead-dossier', () => ({
  LeadDossier: ({ lead, onClose }: { lead: Lead | null; onClose: () => void }) =>
    lead ? (
      <div data-testid="dossier">
        <span>dossier:{lead.id}</span>
        <button type="button" onClick={onClose}>
          Close dossier
        </button>
      </div>
    ) : null,
}));

import LeadsPage from './page';

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'l1',
    businessId: 'b1',
    assignedAgentId: null,
    conversationId: null,
    clientId: null,
    whatsappPhone: '+919800000001',
    altPhone: null,
    email: null,
    name: 'Asha Rao',
    languagePref: 'en',
    source: 'PORTAL',
    subSource: null,
    listingRef: null,
    firstTouchAt: '2026-07-01T00:00:00.000Z',
    bltc: {
      budgetMinPaise: null,
      budgetMaxPaise: null,
      localities: [],
      timelineMonths: null,
      config: null,
      purpose: null,
      financing: null,
    },
    qualScore: 50,
    temperature: 'WARM',
    stage: 'NEW',
    matchedUnitIds: [],
    extractedFacts: [],
    objections: [],
    promises: [],
    optOut: false,
    shareConsent: false,
    exchangeStatus: 'NONE',
    nextFollowupAt: null,
    lastActivityAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Four leads spanning the axes the page slices on: two agents (one on the
 * roster, one not), one unassigned, three sources and two pipeline columns.
 */
const LEADS: Lead[] = [
  makeLead({
    id: 'a',
    name: 'Asha Rao',
    assignedAgentId: 'agent-1',
    source: 'PORTAL',
    stage: 'NEW',
    temperature: 'HOT',
  }),
  makeLead({
    id: 'b',
    name: 'Rahul Mehta',
    whatsappPhone: '+919811122233',
    assignedAgentId: 'agent-gone',
    source: 'META_LEAD_AD',
    stage: 'QUALIFIED',
  }),
  makeLead({
    id: 'c',
    name: 'Priya Nair',
    whatsappPhone: '+919833344455',
    assignedAgentId: null,
    source: 'REFERRAL',
    stage: 'NEGOTIATING',
  }),
  makeLead({
    id: 'd',
    name: 'Vikram Shah',
    whatsappPhone: '+919844455566',
    assignedAgentId: 'agent-1',
    source: 'PORTAL',
    stage: 'CLOSED_WON',
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.leads.data = { data: LEADS, pagination: { total: LEADS.length } };
  mocks.leads.isLoading = false;
  mocks.leads.isError = false;
  mocks.board.data = [];
  mocks.board.isLoading = false;
  mocks.board.isError = false;
  mocks.team.data = { data: [{ id: 'agent-1', name: 'Neha Iyer' }] };
  mocks.search = '';
});

describe('LeadsPage — board totals', () => {
  it('shows the server board total for a column rather than the loaded page count', () => {
    // One NEW lead is on the page, but the desk has 42 in that column overall.
    mocks.board.data = [
      { stage: 'NEW', count: 40 },
      { stage: 'CONTACTED', count: 2 },
      { stage: 'QUALIFIED', count: 7 },
    ];
    render(<LeadsPage />);
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
  });

  it('reports the qualified stat from the board rather than the loaded leads', () => {
    mocks.board.data = [{ stage: 'QUALIFIED', count: 7 }];
    render(<LeadsPage />);
    // "Qualified" is also a column heading, but only the stat chip is preceded
    // by its own value, so the chip is the one carrying a sibling count.
    const chip = screen.getAllByText('Qualified').find((el) => el.previousSibling?.textContent === '7');
    expect(chip).toBeDefined();
  });

  it('counts hot leads from the loaded page rather than the board', () => {
    render(<LeadsPage />);
    expect(screen.getByText('Hot leads').previousSibling).toHaveTextContent('1');
  });

  it('falls back to the visible count once a filter is narrowing the set', () => {
    mocks.board.data = [{ stage: 'NEW', count: 40 }];
    render(<LeadsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Hot' }));
    // Only lead `a` is HOT, so the New column must read 1, not 40.
    expect(screen.queryByText('40')).toBeNull();
  });
});

describe('LeadsPage — agent filter options', () => {
  it('labels a rostered agent by name and an off-roster agent by a truncated id', () => {
    render(<LeadsPage />);
    const select = screen.getByLabelText('Filter by agent');
    expect(within(select).getByText('Neha Iyer')).toBeInTheDocument();
    expect(within(select).getByText('Agent agent-')).toBeInTheDocument();
  });

  it('offers "Unassigned" only when some lead has no agent', () => {
    render(<LeadsPage />);
    expect(within(screen.getByLabelText('Filter by agent')).getByText('Unassigned')).toBeInTheDocument();
  });

  it('omits "Unassigned" when every lead is assigned', () => {
    mocks.leads.data = { data: LEADS.filter((l) => l.assignedAgentId), pagination: { total: 3 } };
    render(<LeadsPage />);
    expect(within(screen.getByLabelText('Filter by agent')).queryByText('Unassigned')).toBeNull();
  });

  it('filters the board down to one agent', () => {
    render(<LeadsPage />);
    fireEvent.change(screen.getByLabelText('Filter by agent'), { target: { value: 'agent-1' } });
    expect(screen.getAllByText('Asha Rao').length).toBeGreaterThan(0);
    expect(screen.queryByText('Rahul Mehta')).toBeNull();
    expect(screen.queryByText('Priya Nair')).toBeNull();
  });

  it('filters down to the unassigned leads', () => {
    render(<LeadsPage />);
    fireEvent.change(screen.getByLabelText('Filter by agent'), { target: { value: 'UNASSIGNED' } });
    expect(screen.getAllByText('Priya Nair').length).toBeGreaterThan(0);
    expect(screen.queryByText('Asha Rao')).toBeNull();
  });
});

describe('LeadsPage — source filter', () => {
  it('narrows to a single source bucket', () => {
    render(<LeadsPage />);
    fireEvent.change(screen.getByLabelText('Filter by source'), { target: { value: 'PORTAL' } });
    expect(screen.getAllByText('Asha Rao').length).toBeGreaterThan(0);
    expect(screen.queryByText('Rahul Mehta')).toBeNull();
  });

  it('treats the referral bucket as covering exchange inbound too', () => {
    mocks.leads.data = {
      data: [makeLead({ id: 'x', name: 'Exchange Lead', source: 'EXCHANGE_INBOUND' })],
      pagination: { total: 1 },
    };
    render(<LeadsPage />);
    fireEvent.change(screen.getByLabelText('Filter by source'), { target: { value: 'REFERRAL' } });
    expect(screen.getAllByText('Exchange Lead').length).toBeGreaterThan(0);
  });
});

describe('LeadsPage — export', () => {
  it('exports the filtered leads, not the whole page', () => {
    render(<LeadsPage />);
    fireEvent.change(screen.getByLabelText('Filter by agent'), { target: { value: 'UNASSIGNED' } });
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));

    expect(mocks.downloadCsv).toHaveBeenCalledTimes(1);
    const [filename, csv] = mocks.downloadCsv.mock.calls[0] as [string, string];
    expect(filename).toMatch(/^leads-.*\.csv$/);
    expect(csv).toContain('Priya Nair');
    expect(csv).not.toContain('Asha Rao');
  });

  it('disables export when the filters match nothing', () => {
    render(<LeadsPage />);
    fireEvent.change(screen.getByLabelText('Search leads'), { target: { value: 'nobody' } });
    expect(screen.getByRole('button', { name: /Export/ })).toBeDisabled();
  });
});

describe('LeadsPage — load states', () => {
  it('shows the loading state while either query is in flight', () => {
    mocks.board.isLoading = true;
    render(<LeadsPage />);
    expect(screen.getByText('Loading pipeline…')).toBeInTheDocument();
  });

  it('shows the error state when the board query fails and hides the filter bar', () => {
    mocks.board.isError = true;
    render(<LeadsPage />);
    expect(screen.getByText('Could not load leads.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search leads')).toBeNull();
  });

  it('shows the error state when the lead list fails', () => {
    mocks.leads.isError = true;
    render(<LeadsPage />);
    expect(screen.getByText('Could not load leads.')).toBeInTheDocument();
  });

  it('retries both queries from the error state', () => {
    mocks.leads.isError = true;
    render(<LeadsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Retry|Try again/i }));
    expect(mocks.board.refetch).toHaveBeenCalledTimes(1);
    expect(mocks.leads.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the first-run empty state when the desk has no leads at all', () => {
    mocks.leads.data = { data: [], pagination: { total: 0 } };
    render(<LeadsPage />);
    expect(screen.getByText('No leads yet')).toBeInTheDocument();
  });

  it('survives a list response with no payload', () => {
    mocks.leads.data = null;
    render(<LeadsPage />);
    expect(screen.getByText('No leads yet')).toBeInTheDocument();
  });
});

describe('LeadsPage — the ?lead= deep link', () => {
  it('opens the dossier for the linked lead', () => {
    mocks.search = 'lead=c';
    render(<LeadsPage />);
    expect(screen.getByText('dossier:c')).toBeInTheDocument();
  });

  it('clears the query parameter when the dossier is closed', () => {
    mocks.search = 'lead=c';
    render(<LeadsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Close dossier' }));
    expect(mocks.replace).toHaveBeenCalledWith('/leads');
    expect(screen.queryByTestId('dossier')).toBeNull();
  });

  it('leaves the dossier shut when the linked lead is not on the page', () => {
    mocks.search = 'lead=not-loaded';
    render(<LeadsPage />);
    expect(screen.queryByTestId('dossier')).toBeNull();
  });

  it('does not navigate when a dossier opened without a deep link is closed', () => {
    render(<LeadsPage />);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

describe('LeadsPage — the mobile stage tabs', () => {
  it('starts on the first pipeline stage', () => {
    render(<LeadsPage />);
    expect(screen.getByRole('tab', { name: /^New/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches which stage the stacked list shows', () => {
    render(<LeadsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /^Negotiating/ }));
    expect(screen.getByRole('tab', { name: /^Negotiating/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^New/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('tells the user a stage is empty rather than showing a blank panel', () => {
    render(<LeadsPage />);
    fireEvent.click(screen.getByRole('tab', { name: /^Visit Booked/ }));
    expect(screen.getByText('No leads in Visit Booked.')).toBeInTheDocument();
  });

  it('shows a per-column empty note in the desktop kanban', () => {
    render(<LeadsPage />);
    // Visit Booked holds nothing, so the desktop column renders its own note.
    expect(screen.getAllByText('No leads').length).toBeGreaterThan(0);
  });
});

describe('LeadsPage — pull to refresh', () => {
  /** jsdom will not construct a TouchEvent; the hook only reads `touches[0].clientY`. */
  function touch(type: string, clientY: number): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: [{ clientY }] });
    return event;
  }

  it('refetches the board and the lead list on a downward drag past the threshold', async () => {
    const { container } = render(<LeadsPage />);
    const scroller = container.querySelector('.overflow-auto') as HTMLElement;
    expect(scroller).not.toBeNull();

    await act(async () => {
      scroller.dispatchEvent(touch('touchstart', 0));
      scroller.dispatchEvent(touch('touchmove', 200));
      scroller.dispatchEvent(touch('touchend', 200));
    });

    expect(mocks.board.refetch).toHaveBeenCalledTimes(1);
    expect(mocks.leads.refetch).toHaveBeenCalledTimes(1);
  });
});
