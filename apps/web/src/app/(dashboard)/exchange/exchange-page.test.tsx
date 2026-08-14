/**
 * The Exchange — co-broking across tenant boundaries.
 *
 * Everything on this page crosses a business boundary, so the tests centre on
 * the guards rather than the layout: a lead can only be syndicated with the
 * buyer's share consent (the picker has to say so), a split that does not sum
 * to 100 must never reach the API, rupees typed by the operator have to leave
 * as paise, and counterparty identifiers are shown truncated rather than in
 * full. The tab-scoped header action is covered too — "Syndicate a lead" and
 * "New resale listing" write to different endpoints and must not be offered on
 * the wrong tab, or to a VIEWER at all.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExchangeMatchResult,
  ReliabilityScore,
  ResaleListing,
  Syndication,
} from '@/lib/realty-types';
import type { Role } from '@/lib/feature-types';

function makeSyndication(overrides: Partial<Syndication> = {}): Syndication {
  return {
    id: 'syn-1',
    businessId: 'b1',
    leadId: 'l1',
    fromBusinessId: '11111111-2222-3333-4444-555555555555',
    toBusinessId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    developerId: null,
    splitTerms: { originatorPct: 50, counterpartyPct: 50 },
    buyerConsentAt: '2026-08-01T00:00:00.000Z',
    state: 'OFFERED',
    commissionPoolPaise: 0,
    platformFeePaise: 0,
    settlementState: 'PENDING',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as Syndication;
}

function makeScore(overrides: Partial<ReliabilityScore> = {}): ReliabilityScore {
  return {
    id: 'rs-1',
    businessId: 'b1',
    targetBusinessId: '11111111-2222-3333-4444-555555555555',
    responseSpeedScore: 80,
    showupIntegrityScore: 70,
    splitHonoringScore: 90,
    documentationHygieneScore: 60,
    compositeScore: 75,
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeListing(overrides: Partial<ResaleListing> = {}): ResaleListing {
  return {
    id: 'rl-1',
    businessId: 'b1',
    projectId: null,
    locality: 'Baner',
    config: '2BHK',
    carpetSqft: 850,
    askingPricePaise: 9_500_000_00,
    sellerPhone: '+919800000009',
    status: 'ACTIVE',
    verifiedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const LEADS = [
  {
    id: 'lead-with-consent',
    name: 'Asha Rao',
    whatsappPhone: '+919800000001',
    shareConsent: true,
    bltc: { config: '3BHK', localities: ['Whitefield'] },
  },
  {
    id: 'lead-no-consent',
    name: null,
    whatsappPhone: '+919800000002',
    shareConsent: false,
    bltc: { config: null, localities: [] },
  },
];

const query = <T,>(data: T) => ({
  data,
  isLoading: false,
  isError: false,
  error: undefined,
  refetch: vi.fn(),
});

const state = {
  syndications: query<Syndication[] | undefined>([makeSyndication()]),
  scores: query<ReliabilityScore[] | undefined>([makeScore()]),
  listings: query<ResaleListing[] | undefined>([makeListing()]),
  match: query<ExchangeMatchResult | undefined>(undefined),
};

/** The filter the syndications tab passed to its query on the latest render. */
let syndicationFilter: Record<string, unknown> | null = null;
/** The lead id and options the match panel most recently asked for. */
let matchArgs: [string | null, { aiRationale: boolean }] | null = null;

const createSyndication = vi.fn();
const createResale = vi.fn();
const createState = { syndicationError: false, resaleError: false };
let role: Role = 'STAFF';

vi.mock('@/hooks/use-realty', () => ({
  useSyndications: (filter: Record<string, unknown>) => {
    syndicationFilter = filter;
    return state.syndications;
  },
  useReliabilityScores: () => state.scores,
  useResaleListings: () => state.listings,
  useExchangeMatch: (leadId: string | null, opts: { aiRationale: boolean }) => {
    matchArgs = [leadId, opts];
    return state.match;
  },
  useLeads: () => ({ data: { data: LEADS }, isLoading: false, isError: false }),
  useCreateSyndication: () => ({
    mutate: createSyndication,
    isPending: false,
    isError: createState.syndicationError,
  }),
  useCreateResaleListing: () => ({
    mutate: createResale,
    isPending: false,
    isError: createState.resaleError,
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

import ExchangePage from './page';

beforeEach(() => {
  state.syndications = query([makeSyndication()]);
  state.scores = query([makeScore()]);
  state.listings = query([makeListing()]);
  state.match = query(undefined);
  createState.syndicationError = false;
  createState.resaleError = false;
  syndicationFilter = null;
  matchArgs = null;
  role = 'STAFF';
  vi.clearAllMocks();
});

const goToTab = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));

describe('ExchangePage tabs', () => {
  it('opens on syndications', () => {
    render(<ExchangePage />);
    // "Offered" is both a state filter pill and the card's state badge.
    expect(screen.getAllByText('Offered').length).toBeGreaterThan(1);
  });

  it('swaps the header action to match the tab', () => {
    render(<ExchangePage />);
    expect(screen.getByRole('button', { name: /Syndicate a lead/ })).toBeInTheDocument();

    goToTab('Resale supply');
    expect(screen.queryByRole('button', { name: /Syndicate a lead/ })).toBeNull();
    expect(screen.getByRole('button', { name: /New resale listing/ })).toBeInTheDocument();
  });

  it('offers no header action on the read-only tabs', () => {
    render(<ExchangePage />);
    goToTab('Reliability');
    expect(screen.queryByRole('button', { name: /Syndicate a lead/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New resale listing/ })).toBeNull();
  });

  it('offers a VIEWER no write action on any tab', () => {
    role = 'VIEWER';
    render(<ExchangePage />);
    expect(screen.queryByRole('button', { name: /Syndicate a lead/ })).toBeNull();
    goToTab('Resale supply');
    expect(screen.queryByRole('button', { name: /New resale listing/ })).toBeNull();
  });
});

describe('ExchangePage syndications tab', () => {
  it('queries unfiltered until a state pill is chosen', () => {
    render(<ExchangePage />);
    expect(syndicationFilter).toEqual({});
    goToTab('Disputed');
    expect(syndicationFilter).toEqual({ state: 'DISPUTED' });
  });

  it('shows the loading, error and empty states', () => {
    state.syndications = { ...query(undefined), isLoading: true };
    const { unmount } = render(<ExchangePage />);
    expect(screen.getByText('Loading syndications…')).toBeInTheDocument();
    unmount();

    const refetch = vi.fn();
    state.syndications = { ...query(undefined), isError: true, refetch };
    const second = render(<ExchangePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
    second.unmount();

    state.syndications = query([]);
    render(<ExchangePage />);
    expect(screen.getByText('No syndications yet')).toBeInTheDocument();
  });

  it('shows the counterparty ids truncated, never in full', () => {
    render(<ExchangePage />);
    expect(screen.queryByText('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeNull();
    expect(screen.getByText(/aaaaaaaa/)).toBeInTheDocument();
  });

  it('shows the created date while open and the commission once closed', () => {
    state.syndications = query([
      makeSyndication({
        state: 'CLOSED',
        commissionPoolPaise: 5_000_000_00,
        platformFeePaise: 250_000_00,
      }),
    ]);
    render(<ExchangePage />);
    expect(screen.getAllByText('Closed').length).toBeGreaterThan(1);
    expect(screen.getByText(/fee/)).toBeInTheDocument();
  });

  it('renders the three-way split when a developer takes a cut', () => {
    state.syndications = query([
      makeSyndication({
        splitTerms: { originatorPct: 40, counterpartyPct: 40, developerPct: 20 },
      }),
    ]);
    render(<ExchangePage />);
    expect(screen.getByText('Split 40/40/20')).toBeInTheDocument();
  });
});

describe('ExchangePage reliability tab', () => {
  it('ranks members by composite score, best first', () => {
    state.scores = query([
      makeScore({ id: 'a', targetBusinessId: 'aaaaaaaa-0000-0000-0000-000000000000', compositeScore: 40 }),
      makeScore({ id: 'b', targetBusinessId: 'bbbbbbbb-0000-0000-0000-000000000000', compositeScore: 90 }),
    ]);
    render(<ExchangePage />);
    goToTab('Reliability');
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText(/bbbbbbbb/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/aaaaaaaa/)).toBeInTheDocument();
  });

  it('rounds each sub-score for display', () => {
    state.scores = query([makeScore({ responseSpeedScore: 79.6, compositeScore: 75.4 })]);
    render(<ExchangePage />);
    goToTab('Reliability');
    expect(screen.getByText('80')).toBeInTheDocument();
    expect(screen.getByText('75')).toBeInTheDocument();
  });

  it('shows the loading, error and empty states', () => {
    state.scores = { ...query(undefined), isLoading: true };
    const { unmount } = render(<ExchangePage />);
    goToTab('Reliability');
    expect(screen.getByText('Loading reliability scores…')).toBeInTheDocument();
    unmount();

    const refetch = vi.fn();
    state.scores = { ...query(undefined), isError: true, refetch };
    const second = render(<ExchangePage />);
    goToTab('Reliability');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
    second.unmount();

    state.scores = query([]);
    render(<ExchangePage />);
    goToTab('Reliability');
    expect(screen.getByText('No reliability scores yet')).toBeInTheDocument();
  });
});

describe('ExchangePage resale tab', () => {
  it('renders a listing with its price, carpet area and verification state', () => {
    render(<ExchangePage />);
    goToTab('Resale supply');
    expect(screen.getByText('2BHK · Baner')).toBeInTheDocument();
    expect(screen.getByText('850 sqft carpet')).toBeInTheDocument();
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('omits the carpet line when the area is unknown and dates a verified listing', () => {
    state.listings = query([
      makeListing({ carpetSqft: null, verifiedAt: '2026-08-05T00:00:00.000Z', status: 'SOLD' }),
    ]);
    render(<ExchangePage />);
    goToTab('Resale supply');
    expect(screen.queryByText(/sqft carpet/)).toBeNull();
    expect(screen.getByText(/^Verified /)).toBeInTheDocument();
    expect(screen.getByText('Sold')).toBeInTheDocument();
  });

  it('shows the loading, error and empty states', () => {
    state.listings = { ...query(undefined), isLoading: true };
    const { unmount } = render(<ExchangePage />);
    goToTab('Resale supply');
    expect(screen.getByText('Loading resale listings…')).toBeInTheDocument();
    unmount();

    const refetch = vi.fn();
    state.listings = { ...query(undefined), isError: true, refetch };
    const second = render(<ExchangePage />);
    goToTab('Resale supply');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
    second.unmount();

    state.listings = query([]);
    render(<ExchangePage />);
    goToTab('Resale supply');
    expect(screen.getByText('No resale listings yet')).toBeInTheDocument();
  });
});

describe('ExchangePage match panel', () => {
  it('asks for nothing until a lead is picked', () => {
    render(<ExchangePage />);
    goToTab('Matches');
    expect(matchArgs).toEqual([null, { aiRationale: false }]);
    expect(screen.getByText('Pick a lead to find network matches')).toBeInTheDocument();
  });

  it('requests matches for the picked lead and opts into the AI rationale', () => {
    render(<ExchangePage />);
    goToTab('Matches');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lead-with-consent' } });
    expect(matchArgs![0]).toBe('lead-with-consent');

    fireEvent.click(screen.getByRole('checkbox'));
    expect(matchArgs![1]).toEqual({ aiRationale: true });
  });

  it('summarises each lead by its BLTC, defaulting missing parts to "any"', () => {
    render(<ExchangePage />);
    goToTab('Matches');
    const options = Array.from(
      (screen.getByRole('combobox') as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(options).toContain('Asha Rao · 3BHK · Whitefield');
    // An unnamed lead falls back to its phone, and an empty BLTC to "any".
    expect(options).toContain('+919800000002 · any · any');
  });

  it('reports an empty network rather than an error', () => {
    state.match = query({ leadId: 'lead-with-consent', matches: [], aiRationale: null });
    render(<ExchangePage />);
    goToTab('Matches');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lead-with-consent' } });
    expect(screen.getByText('No network matches yet')).toBeInTheDocument();
  });

  it('renders a match with its scores, reasons and truncated counterparty', () => {
    state.match = query({
      leadId: 'lead-with-consent',
      matches: [
        {
          listingId: 'u1',
          sourceType: 'UNIT' as const,
          ownerBusinessId: 'ffffffff-1111-2222-3333-444444444444',
          projectName: 'Prestige Lakeside',
          locality: 'Whitefield',
          config: '3BHK',
          askingPricePaise: 1_20_00_000_00,
          fitScore: 82,
          reliabilityScore: 74.6,
          blendedScore: 79,
          reasons: ['Budget fit', 'Locality match'],
        },
      ],
      aiRationale: 'Strong locality and budget alignment.',
    });
    render(<ExchangePage />);
    goToTab('Matches');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lead-with-consent' } });

    expect(screen.getByText('3BHK · Whitefield')).toBeInTheDocument();
    expect(screen.getByText('Prestige Lakeside')).toBeInTheDocument();
    expect(screen.getByText('Budget fit')).toBeInTheDocument();
    expect(screen.getByText('match 79')).toBeInTheDocument();
    expect(screen.getByText('fit 82')).toBeInTheDocument();
    expect(screen.getByText('reliability 75')).toBeInTheDocument();
    expect(screen.getByText('Strong locality and budget alignment.')).toBeInTheDocument();
    expect(screen.queryByText(/ffffffff-1111/)).toBeNull();
  });

  it('shows a searching state while the network is queried', () => {
    state.match = { ...query(undefined), isLoading: true };
    render(<ExchangePage />);
    goToTab('Matches');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lead-with-consent' } });
    expect(screen.getByText('Searching the network…')).toBeInTheDocument();
  });
});

describe('ExchangePage new syndication modal', () => {
  function open() {
    render(<ExchangePage />);
    fireEvent.click(screen.getByRole('button', { name: /Syndicate a lead/ }));
    return screen.getByRole('dialog');
  }

  it('flags leads whose buyer has not consented to sharing', () => {
    const dialog = open();
    const labels = Array.from(
      (dialog.querySelector('select') as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(labels).toContain('Asha Rao');
    expect(labels).toContain('+919800000002 (no consent)');
  });

  it('refuses a split that does not sum to 100', () => {
    const dialog = open();
    fireEvent.change(dialog.querySelector('select') as HTMLSelectElement, {
      target: { value: 'lead-with-consent' },
    });
    fireEvent.change(dialog.querySelector('input[type="text"], input:not([type])') as HTMLInputElement, {
      target: { value: 'partner-uuid' },
    });

    const [originator] = Array.from(dialog.querySelectorAll('input[type="number"]'));
    fireEvent.change(originator, { target: { value: '60' } });

    expect(screen.getByText(/Split must sum to 100 \(currently 110\)/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Offer syndication' })).toBeDisabled();
  });

  it('offers the syndication once lead, counterparty and a valid split are set', () => {
    const dialog = open();
    fireEvent.change(dialog.querySelector('select') as HTMLSelectElement, {
      target: { value: 'lead-with-consent' },
    });
    fireEvent.change(
      dialog.querySelector('input[placeholder^="UUID"]') as HTMLInputElement,
      { target: { value: 'partner-uuid' } },
    );
    const [originator, counterparty] = Array.from(dialog.querySelectorAll('input[type="number"]'));
    fireEvent.change(originator, { target: { value: '60' } });
    fireEvent.change(counterparty, { target: { value: '40' } });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Offer syndication' }));
    expect(createSyndication).toHaveBeenCalledWith(
      {
        leadId: 'lead-with-consent',
        toBusinessId: 'partner-uuid',
        splitTerms: { originatorPct: 60, counterpartyPct: 40 },
      },
      expect.anything(),
    );
  });

  it('explains a rejected offer as a likely consent problem', () => {
    createState.syndicationError = true;
    open();
    expect(screen.getByText(/may not have consented to sharing/)).toBeInTheDocument();
  });

  it('closes without writing', () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(createSyndication).not.toHaveBeenCalled();
  });
});

describe('ExchangePage new resale modal', () => {
  function open() {
    render(<ExchangePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Resale supply' }));
    fireEvent.click(screen.getByRole('button', { name: /New resale listing/ }));
    return screen.getByRole('dialog');
  }

  it('requires locality, config, price and seller phone', () => {
    const dialog = open();
    const submit = within(dialog).getByRole('button', { name: 'Add listing' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('Baner'), { target: { value: 'Baner' } });
    fireEvent.change(screen.getByPlaceholderText('2BHK'), { target: { value: '2BHK' } });
    expect(submit).toBeDisabled();

    const [price] = Array.from(dialog.querySelectorAll('input[type="number"]'));
    fireEvent.change(price, { target: { value: '9500000' } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText('+9198…'), { target: { value: '+919800000009' } });
    expect(submit).toBeEnabled();
  });

  it('converts the asking price from rupees to paise and omits a blank carpet area', () => {
    const dialog = open();
    fireEvent.change(screen.getByPlaceholderText('Baner'), { target: { value: 'Baner' } });
    fireEvent.change(screen.getByPlaceholderText('2BHK'), { target: { value: '2BHK' } });
    const [price] = Array.from(dialog.querySelectorAll('input[type="number"]'));
    fireEvent.change(price, { target: { value: '9500000.5' } });
    fireEvent.change(screen.getByPlaceholderText('+9198…'), { target: { value: '+919800000009' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add listing' }));

    expect(createResale).toHaveBeenCalledWith(
      {
        locality: 'Baner',
        config: '2BHK',
        askingPricePaise: 950000050,
        sellerPhone: '+919800000009',
        carpetSqft: undefined,
      },
      expect.anything(),
    );
  });

  it('sends the carpet area as a number when given', () => {
    const dialog = open();
    fireEvent.change(screen.getByPlaceholderText('Baner'), { target: { value: 'Baner' } });
    fireEvent.change(screen.getByPlaceholderText('2BHK'), { target: { value: '2BHK' } });
    const [price, carpet] = Array.from(dialog.querySelectorAll('input[type="number"]'));
    fireEvent.change(price, { target: { value: '9500000' } });
    fireEvent.change(carpet, { target: { value: '850' } });
    fireEvent.change(screen.getByPlaceholderText('+9198…'), { target: { value: '+919800000009' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add listing' }));

    expect(createResale.mock.calls[0][0].carpetSqft).toBe(850);
  });

  it('reports a rejected listing', () => {
    createState.resaleError = true;
    open();
    expect(screen.getByText('Could not add the listing. Check the details.')).toBeInTheDocument();
  });
});
