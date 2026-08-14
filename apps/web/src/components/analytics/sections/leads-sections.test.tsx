/**
 * The two Leads-tab analytics sections: the conversion funnel and source ROI.
 *
 * Both derive their numbers rather than displaying them, and both derivations
 * are easy to get subtly wrong. The funnel turns a *snapshot* of stage occupancy
 * into a cumulative funnel — "reached QUALIFIED" has to include everyone now
 * sitting in a later stage, and lost/dormant leads must not be counted as having
 * reached anything. Source ROI buckets raw lead sources into seven reporting
 * channels (a portal lead's sub-source decides which portal), divides estimated
 * spend by qualified leads, and picks a winner — where a divide-by-zero on a
 * source with no qualified leads is the obvious hazard.
 */
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead, LeadSource, LeadStage, SiteVisit } from '@/lib/realty-types';
import { defaultRange } from '@/components/analytics/date-range-picker';

// Recharts needs a measured container, which jsdom does not provide. The chart
// is not the assertion target here — the derived table and callout are.
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass,
    BarChart: Pass,
    Bar: Pass,
    Cell: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
  };
});

function makeLead(
  id: string,
  stage: LeadStage,
  source: LeadSource,
  subSource: string | null = null,
): Lead {
  return {
    id,
    businessId: 'b1',
    assignedAgentId: null,
    conversationId: null,
    clientId: null,
    whatsappPhone: `+9198000000${id}`,
    altPhone: null,
    email: null,
    name: `Lead ${id}`,
    languagePref: 'en',
    source,
    subSource,
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
    stage,
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
  } as Lead;
}

function makeVisit(id: string, leadId: string): SiteVisit {
  return {
    id,
    businessId: 'b1',
    leadId,
    projectId: 'p1',
    unitId: null,
    assignedAgentId: null,
    scheduledAt: '2026-07-10T00:00:00.000Z',
    durationMinutes: 45,
    timezone: 'Asia/Kolkata',
    status: 'BOOKED',
    bookingId: null,
    calendarEventId: null,
    calendarId: null,
    reminderState: {},
    remindersSent: 0,
    lastReminderAt: null,
    feedback: null,
    outcome: 'PENDING',
    rescheduledFrom: null,
    cancellationReason: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

const state = {
  board: {
    data: [] as Array<{ stage: LeadStage; count: number }> | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  leads: {
    data: { data: [] as Lead[] } as { data: Lead[] } | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  visits: {
    data: { data: [] as SiteVisit[] } as { data: SiteVisit[] } | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
};

vi.mock('@/hooks/use-realty', () => ({
  useLeadBoard: () => state.board,
  useLeads: () => state.leads,
  useSiteVisits: () => state.visits,
}));

import { FunnelSection } from './funnel-section';
import { SourceRoiSection } from './source-roi-section';

const RANGE = defaultRange();

beforeEach(() => {
  state.board = { data: [], isLoading: false, isError: false, refetch: vi.fn() };
  state.leads = { data: { data: [] }, isLoading: false, isError: false, refetch: vi.fn() };
  state.visits = { data: { data: [] }, isLoading: false, isError: false, refetch: vi.fn() };
  vi.clearAllMocks();
});

/**
 * The funnel row for a stage. The stage label also appears in the conversion
 * summary above the funnel, so the row is found through the truncating label
 * paragraph that only the funnel rows use.
 */
function funnelRow(label: string): HTMLElement {
  const el = screen
    .getAllByText(label)
    .find((n) => n.tagName === 'P' && n.className.includes('truncate'))!;
  return el.closest('div.grid') as HTMLElement;
}

/** The row of the source table for a given source name. */
function sourceRow(name: string): HTMLElement {
  return screen.getByRole('cell', { name: new RegExp(`^${name}`) }).closest('tr') as HTMLElement;
}

describe('FunnelSection', () => {
  it('shows a skeleton while the board loads and retries on error', () => {
    state.board = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    const { container, unmount } = render(<FunnelSection />);
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
    unmount();

    const refetch = vi.fn();
    state.board = { data: undefined, isLoading: false, isError: true, refetch };
    render(<FunnelSection />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('explains an empty pipeline rather than dividing by zero', () => {
    render(<FunnelSection />);
    expect(screen.getByText('No leads in the pipeline yet')).toBeInTheDocument();
  });

  it('cumulates forward — a lead in a later stage counts as having reached the earlier ones', () => {
    state.board.data = [
      { stage: 'NEW', count: 10 },
      { stage: 'QUALIFIED', count: 5 },
      { stage: 'CLOSED_WON', count: 2 },
    ];
    render(<FunnelSection />);
    // Entry = 10 + 5 + 2; QUALIFIED = 5 + 2; CLOSED_WON = 2.
    expect(within(funnelRow('New')).getByText('17')).toBeInTheDocument();
    expect(within(funnelRow('Qualified')).getByText('7')).toBeInTheDocument();
    expect(within(funnelRow('Closed Won')).getByText('2')).toBeInTheDocument();
  });

  it('excludes lost and dormant leads from the funnel entirely', () => {
    state.board.data = [
      { stage: 'NEW', count: 10 },
      { stage: 'CLOSED_LOST', count: 40 },
      { stage: 'DORMANT', count: 30 },
    ];
    render(<FunnelSection />);
    // Entry stays at 10 — the 70 leaked leads never inflate the top of funnel.
    expect(within(funnelRow('New')).getByText('10')).toBeInTheDocument();
    expect(screen.queryByText('80')).toBeNull();
  });

  it('reports the overall conversion from entry to Closed Won', () => {
    state.board.data = [
      { stage: 'NEW', count: 8 },
      { stage: 'CLOSED_WON', count: 2 },
    ];
    render(<FunnelSection />);
    expect(screen.getByText('20.0%')).toBeInTheDocument();
    expect(screen.getByText(/2 of 10 leads reach/)).toBeInTheDocument();
  });

  it('labels the first stage as the entry point and the rest by drop-off', () => {
    state.board.data = [
      { stage: 'NEW', count: 10 },
      { stage: 'CONTACTED', count: 10 },
    ];
    render(<FunnelSection />);
    expect(within(funnelRow('New')).getByText('Entry stage')).toBeInTheDocument();
    // 20 reached NEW, 10 reached CONTACTED → 50% drop-off at that step.
    expect(within(funnelRow('Contacted')).getByText('▼ 50% drop-off')).toBeInTheDocument();
  });

  it('renders every forward stage, in journey order', () => {
    state.board.data = [{ stage: 'NEW', count: 1 }];
    render(<FunnelSection />);
    const labels = ['New', 'Contacted', 'Qualified', 'Visit Booked', 'Visited', 'Negotiating', 'Closed Won'];
    for (const label of labels) expect(funnelRow(label)).toBeTruthy();
    expect(screen.queryByText('Closed Lost')).toBeNull();
  });
});

describe('SourceRoiSection bucketing', () => {
  it('splits portal leads by their sub-source, defaulting unlabelled ones to 99acres', () => {
    state.leads.data = {
      data: [
        makeLead('1', 'NEW', 'PORTAL', 'MagicBricks'),
        makeLead('2', 'NEW', 'PORTAL', 'housing.com'),
        makeLead('3', 'NEW', 'PORTAL', null),
        makeLead('4', 'NEW', 'PORTAL', 'Some Other Portal'),
      ],
    };
    render(<SourceRoiSection range={RANGE} />);
    expect(within(sourceRow('MagicBricks')).getAllByRole('cell')[1]).toHaveTextContent('1');
    expect(within(sourceRow('Housing')).getAllByRole('cell')[1]).toHaveTextContent('1');
    // Unlabelled and unrecognised portals both land in 99acres.
    expect(within(sourceRow('99acres')).getAllByRole('cell')[1]).toHaveTextContent('2');
  });

  it('maps ads, IVR, referrals and exchange inbound to their buckets', () => {
    state.leads.data = {
      data: [
        makeLead('1', 'NEW', 'META_LEAD_AD'),
        makeLead('2', 'NEW', 'IVR'),
        makeLead('3', 'NEW', 'REFERRAL'),
        makeLead('4', 'NEW', 'EXCHANGE_INBOUND'),
      ],
    };
    render(<SourceRoiSection range={RANGE} />);
    expect(within(sourceRow('Meta Ads')).getAllByRole('cell')[1]).toHaveTextContent('1');
    expect(within(sourceRow('IVR')).getAllByRole('cell')[1]).toHaveTextContent('1');
    // Referral and exchange-inbound share the Referral bucket.
    expect(within(sourceRow('Referral')).getAllByRole('cell')[1]).toHaveTextContent('2');
  });

  it('folds walk-ins, CTWA, manual entry and CSV imports into Direct', () => {
    state.leads.data = {
      data: [
        makeLead('1', 'NEW', 'WALK_IN'),
        makeLead('2', 'NEW', 'CTWA'),
        makeLead('3', 'NEW', 'MANUAL'),
        makeLead('4', 'NEW', 'CSV'),
      ],
    };
    render(<SourceRoiSection range={RANGE} />);
    expect(within(sourceRow('Direct')).getAllByRole('cell')[1]).toHaveTextContent('4');
  });
});

describe('SourceRoiSection qualification and economics', () => {
  it('counts QUALIFIED and every later forward stage as qualified', () => {
    state.leads.data = {
      data: [
        makeLead('1', 'NEW', 'PORTAL', 'MagicBricks'),
        makeLead('2', 'QUALIFIED', 'PORTAL', 'MagicBricks'),
        makeLead('3', 'NEGOTIATING', 'PORTAL', 'MagicBricks'),
        makeLead('4', 'CLOSED_WON', 'PORTAL', 'MagicBricks'),
      ],
    };
    render(<SourceRoiSection range={RANGE} />);
    expect(within(sourceRow('MagicBricks')).getAllByRole('cell')[2]).toHaveTextContent('3');
  });

  it('does not count lost or dormant leads as qualified, despite their enum position', () => {
    // CLOSED_LOST and DORMANT sit after CLOSED_WON in LEAD_STAGES, so a naive
    // index comparison would count them as qualified-and-progressing.
    state.leads.data = {
      data: [
        makeLead('1', 'CLOSED_LOST', 'PORTAL', 'MagicBricks'),
        makeLead('2', 'DORMANT', 'PORTAL', 'MagicBricks'),
      ],
    };
    render(<SourceRoiSection range={RANGE} />);
    expect(within(sourceRow('MagicBricks')).getAllByRole('cell')[2]).toHaveTextContent('0');
    // No qualified leads → no cost per qualified lead to report.
    expect(within(sourceRow('MagicBricks')).getAllByRole('cell')[4]).toHaveTextContent('—');
  });

  it('divides estimated spend across the qualified leads only', () => {
    // Two MagicBricks leads at ₹550 each = ₹1,100 spend, one qualified.
    state.leads.data = {
      data: [
        makeLead('1', 'NEW', 'PORTAL', 'MagicBricks'),
        makeLead('2', 'QUALIFIED', 'PORTAL', 'MagicBricks'),
      ],
    };
    render(<SourceRoiSection range={RANGE} />);
    expect(within(sourceRow('MagicBricks')).getAllByRole('cell')[4]).toHaveTextContent('₹1,100.00');
  });

  it('labels an organic channel Free rather than ₹0.00', () => {
    state.leads.data = { data: [makeLead('1', 'QUALIFIED', 'REFERRAL')] };
    render(<SourceRoiSection range={RANGE} />);
    expect(within(sourceRow('Referral')).getAllByRole('cell')[4]).toHaveTextContent('Free');
  });

  it('attributes a visit to the source of its lead', () => {
    state.leads.data = {
      data: [makeLead('1', 'VISITED', 'META_LEAD_AD'), makeLead('2', 'NEW', 'REFERRAL')],
    };
    state.visits.data = { data: [makeVisit('v1', '1'), makeVisit('v2', '1')] };
    render(<SourceRoiSection range={RANGE} />);
    expect(within(sourceRow('Meta Ads')).getAllByRole('cell')[3]).toHaveTextContent('2');
    expect(within(sourceRow('Referral')).getAllByRole('cell')[3]).toHaveTextContent('0');
  });

  it('ignores a visit whose lead is not in the loaded page', () => {
    state.leads.data = { data: [makeLead('1', 'NEW', 'META_LEAD_AD')] };
    state.visits.data = { data: [makeVisit('v1', 'unknown-lead')] };
    render(<SourceRoiSection range={RANGE} />);
    expect(within(sourceRow('Meta Ads')).getAllByRole('cell')[3]).toHaveTextContent('0');
  });
});

describe('SourceRoiSection best-source callout', () => {
  it('names the cheapest source per qualified lead and highlights its row', () => {
    state.leads.data = {
      data: [
        makeLead('1', 'QUALIFIED', 'PORTAL', 'MagicBricks'),
        makeLead('2', 'QUALIFIED', 'META_LEAD_AD'),
      ],
    };
    render(<SourceRoiSection range={RANGE} />);
    // Meta Ads at ₹280 beats MagicBricks at ₹550.
    expect(screen.getByText('Best ROI: Meta Ads')).toBeInTheDocument();
    expect(within(sourceRow('Meta Ads')).getByText('Best ROI')).toBeInTheDocument();
  });

  it('describes a zero-cost winner as free rather than quoting ₹0', () => {
    state.leads.data = {
      data: [makeLead('1', 'QUALIFIED', 'REFERRAL'), makeLead('2', 'QUALIFIED', 'META_LEAD_AD')],
    };
    render(<SourceRoiSection range={RANGE} />);
    expect(screen.getByText('Best ROI: Referral')).toBeInTheDocument();
    expect(screen.getByText(/Free channel/)).toBeInTheDocument();
  });

  it('breaks a cost tie on qualified volume', () => {
    state.leads.data = {
      data: [
        makeLead('1', 'QUALIFIED', 'REFERRAL'),
        makeLead('2', 'QUALIFIED', 'WALK_IN'),
        makeLead('3', 'QUALIFIED', 'WALK_IN'),
      ],
    };
    render(<SourceRoiSection range={RANGE} />);
    // Both are free; Direct has two qualified leads to Referral's one.
    expect(screen.getByText('Best ROI: Direct')).toBeInTheDocument();
  });

  it('names no winner when no source produced a qualified lead', () => {
    state.leads.data = { data: [makeLead('1', 'NEW', 'META_LEAD_AD')] };
    render(<SourceRoiSection range={RANGE} />);
    expect(screen.queryByText(/Best ROI:/)).toBeNull();
    // The table still renders the volume it does have.
    expect(within(sourceRow('Meta Ads')).getAllByRole('cell')[1]).toHaveTextContent('1');
  });
});

describe('SourceRoiSection states', () => {
  it('shows a skeleton while either query loads', () => {
    state.visits = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    const { container } = render(<SourceRoiSection range={RANGE} />);
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('retries both queries from one button', () => {
    const leadsRefetch = vi.fn();
    const visitsRefetch = vi.fn();
    state.leads = { data: undefined, isLoading: false, isError: true, refetch: leadsRefetch };
    state.visits = { data: undefined, isLoading: false, isError: false, refetch: visitsRefetch };
    render(<SourceRoiSection range={RANGE} />);
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(leadsRefetch).toHaveBeenCalled();
    expect(visitsRefetch).toHaveBeenCalled();
  });

  it('explains an empty comparison when no leads exist at all', () => {
    render(<SourceRoiSection range={RANGE} />);
    expect(screen.getByText('No leads to compare yet')).toBeInTheDocument();
  });
});
