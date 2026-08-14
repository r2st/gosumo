/**
 * One syndicated deal — its lifecycle controls and the settlement it produces.
 *
 * A syndication moves OFFERED → ACCEPTED → VISIT → CLOSED, and each transition
 * is offered by exactly one control. Rendering "Accept" on an already-accepted
 * deal, or leaving the action rail up after a dispute, would let an operator
 * fire a transition the API refuses; those state-to-control mappings are what
 * this file pins, alongside the two money conversions (rupees in, paise out)
 * and the counterparty-id truncation the exchange relies on for privacy.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Syndication, SyndicationState } from '@/lib/realty-types';
import { SyndicationTimeline } from '@/components/exchange/state-timeline';

function makeSyndication(overrides: Partial<Syndication> = {}): Syndication {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    businessId: 'b1',
    leadId: 'lead-1',
    fromBusinessId: '11111111-2222-3333-4444-555555555555',
    toBusinessId: '99999999-8888-7777-6666-555555555555',
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

const state = {
  data: makeSyndication() as Syndication | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
};

const mutations = {
  accept: vi.fn(),
  visit: vi.fn(),
  expire: vi.fn(),
  close: vi.fn(),
  dispute: vi.fn(),
  rate: vi.fn(),
};

const asMutation = (mutate: ReturnType<typeof vi.fn>) => ({
  mutate,
  isPending: false,
  isError: false,
});

/** The id the page passed to `useSyndication`, i.e. what it read off the route. */
let requestedId: string | null = null;
let routeParams: { syndicationId?: string } | null = { syndicationId: 'syn-1' };

vi.mock('next/navigation', () => ({ useParams: () => routeParams }));

vi.mock('@/hooks/use-realty', () => ({
  useSyndication: (id: string | null) => {
    requestedId = id;
    return { ...state, error: state.isError ? new Error('boom') : undefined };
  },
  useAcceptSyndication: () => asMutation(mutations.accept),
  useRecordVisit: () => asMutation(mutations.visit),
  useExpireSyndication: () => asMutation(mutations.expire),
  useCloseSyndication: () => asMutation(mutations.close),
  useDisputeSyndication: () => asMutation(mutations.dispute),
  useRateSyndication: () => asMutation(mutations.rate),
}));

import SyndicationDetailPage from './page';

/** Renders the page with the syndication in a given lifecycle state. */
function renderAt(syndicationState: SyndicationState, overrides: Partial<Syndication> = {}) {
  state.data = makeSyndication({ state: syndicationState, ...overrides });
  return render(<SyndicationDetailPage />);
}

beforeEach(() => {
  state.data = makeSyndication();
  state.isLoading = false;
  state.isError = false;
  routeParams = { syndicationId: 'syn-1' };
  requestedId = null;
  vi.clearAllMocks();
});

describe('SyndicationDetailPage shell', () => {
  it('loads the syndication named in the route', () => {
    render(<SyndicationDetailPage />);
    expect(requestedId).toBe('syn-1');
  });

  it('asks for nothing when the route has no id', () => {
    routeParams = null;
    render(<SyndicationDetailPage />);
    expect(requestedId).toBeNull();
  });

  it('shows a placeholder breadcrumb while loading', () => {
    state.isLoading = true;
    state.data = undefined;
    render(<SyndicationDetailPage />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByText('Loading syndication…')).toBeInTheDocument();
  });

  it('retries a failed load', () => {
    state.isError = true;
    state.data = undefined;
    render(<SyndicationDetailPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(state.refetch).toHaveBeenCalled();
  });

  it('reports a syndication that does not exist', () => {
    state.data = undefined;
    render(<SyndicationDetailPage />);
    expect(screen.getByText('Syndication not found')).toBeInTheDocument();
  });

  it('links back to the exchange and through to the lead', () => {
    render(<SyndicationDetailPage />);
    expect(screen.getByRole('link', { name: 'Exchange' })).toHaveAttribute('href', '/exchange');
    expect(screen.getByRole('link', { name: /View lead/ })).toHaveAttribute('href', '/leads/lead-1');
  });
});

describe('SyndicationDetailPage attribution', () => {
  it('truncates both business ids rather than printing them in full', () => {
    render(<SyndicationDetailPage />);
    expect(screen.queryByText('99999999-8888-7777-6666-555555555555')).toBeNull();
    expect(screen.getByText(/99999999/)).toBeInTheDocument();
  });

  it('omits the developer row on a two-way split and shows it on a three-way', () => {
    const { unmount } = render(<SyndicationDetailPage />);
    expect(screen.queryByText('Developer')).toBeNull();
    expect(screen.getByText('50 / 50')).toBeInTheDocument();
    unmount();

    renderAt('OFFERED', {
      developerId: 'dddddddd-1111-2222-3333-444444444444',
      splitTerms: { originatorPct: 40, counterpartyPct: 40, developerPct: 20 },
    });
    expect(screen.getByText('Developer')).toBeInTheDocument();
    expect(screen.getByText('40 / 40 / 20')).toBeInTheDocument();
  });

  it('says so when the buyer consent was never recorded', () => {
    renderAt('OFFERED', { buyerConsentAt: null });
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
  });

  it('renders the commission pool and platform fee in rupees', () => {
    renderAt('CLOSED', { commissionPoolPaise: 5_00_000_00, platformFeePaise: 30_000_00 });
    expect(screen.getByText('Platform fee')).toBeInTheDocument();
    expect(screen.getByText('₹30,000.00')).toBeInTheDocument();
  });
});

describe('SyndicationDetailPage lifecycle controls', () => {
  it('offers Accept only while the deal is merely offered', () => {
    const { unmount } = renderAt('OFFERED');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(mutations.accept).toHaveBeenCalledWith(state.data!.id);
    expect(screen.queryByRole('button', { name: 'Record visit' })).toBeNull();
    unmount();

    renderAt('ACCEPTED');
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('offers Record visit only once accepted', () => {
    renderAt('ACCEPTED');
    fireEvent.click(screen.getByRole('button', { name: 'Record visit' }));
    expect(mutations.visit).toHaveBeenCalledWith(state.data!.id);
  });

  it('offers Close deal from ACCEPTED and VISIT but not from OFFERED', () => {
    const { unmount } = renderAt('OFFERED');
    expect(screen.queryByRole('button', { name: 'Close deal' })).toBeNull();
    unmount();

    const second = renderAt('ACCEPTED');
    expect(screen.getByRole('button', { name: 'Close deal' })).toBeInTheDocument();
    second.unmount();

    renderAt('VISIT');
    expect(screen.getByRole('button', { name: 'Close deal' })).toBeInTheDocument();
  });

  it('expires a live deal', () => {
    render(<SyndicationDetailPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Expire' }));
    expect(mutations.expire).toHaveBeenCalledWith(state.data!.id);
  });

  it('withdraws the whole action rail once the deal is terminal', () => {
    for (const terminal of ['CLOSED', 'EXPIRED', 'DISPUTED'] as SyndicationState[]) {
      const { unmount } = renderAt(terminal);
      expect(screen.queryByRole('button', { name: 'Expire' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Dispute' })).toBeNull();
      unmount();
    }
  });

  it('offers the rating card only on a closed deal', () => {
    const { unmount } = renderAt('DISPUTED');
    expect(screen.queryByRole('button', { name: 'Rate this deal' })).toBeNull();
    unmount();

    renderAt('CLOSED');
    expect(screen.getByRole('button', { name: 'Rate this deal' })).toBeInTheDocument();
  });
});

describe('SyndicationDetailPage close modal', () => {
  function open() {
    renderAt('VISIT');
    fireEvent.click(screen.getByRole('button', { name: 'Close deal' }));
    return screen.getByRole('dialog');
  }

  it('refuses a zero or empty commission pool', () => {
    const dialog = open();
    const submit = within(dialog).getByRole('button', { name: 'Close deal' });
    expect(submit).toBeDisabled();

    fireEvent.change(dialog.querySelector('input') as HTMLInputElement, { target: { value: '0' } });
    expect(submit).toBeDisabled();
  });

  it('converts the pool from rupees to paise', () => {
    const dialog = open();
    fireEvent.change(dialog.querySelector('input') as HTMLInputElement, {
      target: { value: '500000' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close deal' }));
    expect(mutations.close).toHaveBeenCalledWith(
      { id: state.data!.id, commissionPoolPaise: 50_000_000 },
      expect.anything(),
    );
  });

  it('rounds a fractional rupee amount to whole paise', () => {
    const dialog = open();
    fireEvent.change(dialog.querySelector('input') as HTMLInputElement, {
      target: { value: '1000.005' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close deal' }));
    expect(mutations.close.mock.calls[0][0].commissionPoolPaise).toBe(100001);
  });
});

describe('SyndicationDetailPage dispute modal', () => {
  function open() {
    renderAt('ACCEPTED');
    fireEvent.click(screen.getByRole('button', { name: 'Dispute' }));
    return screen.getByRole('dialog');
  }

  it('requires a written reason', () => {
    const dialog = open();
    const submit = within(dialog).getByRole('button', { name: 'Raise dispute' });
    expect(submit).toBeDisabled();

    fireEvent.change(dialog.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: '   ' },
    });
    expect(submit).toBeDisabled();
  });

  it('raises the dispute with the reason', () => {
    const dialog = open();
    fireEvent.change(dialog.querySelector('textarea') as HTMLTextAreaElement, {
      target: { value: 'Counterparty never showed up' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Raise dispute' }));
    expect(mutations.dispute).toHaveBeenCalledWith(
      { id: state.data!.id, reason: 'Counterparty never showed up' },
      expect.anything(),
    );
  });
});

describe('SyndicationDetailPage rating modal', () => {
  function open() {
    renderAt('CLOSED');
    fireEvent.click(screen.getByRole('button', { name: 'Rate this deal' }));
    return screen.getByRole('dialog');
  }

  it('defaults every behavioural rating to positive', () => {
    const dialog = open();
    for (const box of Array.from(dialog.querySelectorAll('input[type="checkbox"]'))) {
      expect(box).toBeChecked();
    }
  });

  it('submits the ratings, omitting an unmeasured response time', () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByLabelText('Showed up for the visit'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit rating' }));

    expect(mutations.rate).toHaveBeenCalledWith(
      {
        id: state.data!.id,
        ratings: {
          showedUp: false,
          splitHonored: true,
          documented: true,
          responseMinutes: undefined,
        },
      },
      expect.anything(),
    );
  });

  it('sends the response time as a number when supplied', () => {
    const dialog = open();
    fireEvent.change(dialog.querySelector('input[type="number"]') as HTMLInputElement, {
      target: { value: '45' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit rating' }));
    expect(mutations.rate.mock.calls[0][0].ratings.responseMinutes).toBe(45);
  });
});

describe('SyndicationTimeline', () => {
  it('marks nothing done at the first step beyond the current one', () => {
    render(<SyndicationTimeline state="OFFERED" />);
    const list = screen.getByRole('list', { name: 'Syndication progress' });
    // Only OFFERED is reached, so ACCEPTED/VISIT/CLOSED still show their number.
    expect(within(list).getByText('2')).toBeInTheDocument();
    expect(within(list).getByText('4')).toBeInTheDocument();
  });

  it('marks every node done at the end of the happy path', () => {
    render(<SyndicationTimeline state="CLOSED" />);
    const list = screen.getByRole('list', { name: 'Syndication progress' });
    expect(within(list).queryByText('2')).toBeNull();
    expect(within(list).queryByText('4')).toBeNull();
  });

  it('renders an off-path end node for DISPUTED and leaves the path inert', () => {
    render(<SyndicationTimeline state="DISPUTED" />);
    const list = screen.getByRole('list', { name: 'Syndication progress' });
    // The happy path stays un-ticked — its nodes still carry their numbers.
    expect(within(list).getByText('1')).toBeInTheDocument();
    expect(within(list).getByText('4')).toBeInTheDocument();
    expect(within(list).getByText('Disputed')).toBeInTheDocument();
  });

  it('renders EXPIRED the same way, as its own terminal node', () => {
    render(<SyndicationTimeline state="EXPIRED" />);
    const list = screen.getByRole('list', { name: 'Syndication progress' });
    expect(within(list).getByText('Expired')).toBeInTheDocument();
    expect(within(list).getByText('1')).toBeInTheDocument();
  });

  it('labels every happy-path node', () => {
    render(<SyndicationTimeline state="ACCEPTED" />);
    for (const label of ['Offered', 'Accepted', 'Visited', 'Closed']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
