/**
 * ClientDetailPage — the single-contact profile.
 *
 * Covers the load/error gate, the four metric tiles (each of which formats a
 * different unit: paise, a count, a rupee decimal and a 0–1 ratio), and the
 * activity timeline. The churn-risk tile is asserted on both sides of each
 * band boundary because the thresholds are open/closed comparisons that a
 * refactor silently flips.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Client, ClientTimeline, TimelineEvent } from '@/lib/types';

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: 'cl1',
    businessId: 'b1',
    name: 'Priya Sharma',
    phone: '+919999900001',
    email: 'priya@example.in',
    avatarUrl: null,
    profile: {},
    optOuts: {},
    ltvScore: 12500,
    churnRisk: 0.2,
    totalOrders: 3,
    totalSpentPaise: 1_050_000,
    lastInteractionAt: '2026-08-10T04:00:00.000Z',
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-08-10T04:00:00.000Z',
    ...overrides,
  } as Client;
}

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    type: 'ORDER',
    id: 'ev1',
    timestamp: '2026-08-10T04:00:00.000Z',
    title: 'Order #1042',
    status: 'CONFIRMED',
    amountPaise: 250_000,
    ...overrides,
  } as TimelineEvent;
}

const state = {
  client: {
    data: makeClient() as Client | undefined,
    isLoading: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  timeline: {
    data: { clientId: 'cl1', events: [makeEvent()], total: 1 } as ClientTimeline | undefined,
    isLoading: false,
  },
};

vi.mock('@/hooks/use-queries', () => ({
  useClient: () => state.client,
  useClientTimeline: () => state.timeline,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ clientId: 'cl1' }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { default: ClientDetailPage } = await import('./page');

beforeEach(() => {
  state.client = {
    data: makeClient(),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
  state.timeline = { data: { clientId: 'cl1', events: [makeEvent()], total: 1 }, isLoading: false };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ClientDetailPage — load states', () => {
  it('shows a loading state while the client resolves', () => {
    state.client.isLoading = true;
    render(<ClientDetailPage />);
    expect(screen.getByText('Loading client…')).toBeInTheDocument();
  });

  it('shows the error message and retries on demand', () => {
    state.client.isError = true;
    state.client.error = new Error('Client not found');
    render(<ClientDetailPage />);

    expect(screen.getByText('Client not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(state.client.refetch).toHaveBeenCalledTimes(1);
  });

  it('treats a successful-but-empty response as an error, not a blank profile', () => {
    state.client.data = undefined;
    render(<ClientDetailPage />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByText('Lifetime value')).not.toBeInTheDocument();
  });
});

describe('ClientDetailPage — profile and metrics', () => {
  it('shows the name, phone and email', () => {
    render(<ClientDetailPage />);

    expect(screen.getByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument();
    expect(screen.getByText('+919999900001')).toBeInTheDocument();
    expect(screen.getByText('priya@example.in')).toBeInTheDocument();
  });

  it('omits the phone and email rows entirely when absent', () => {
    state.client.data = makeClient({ phone: null, email: null });
    render(<ClientDetailPage />);

    expect(screen.queryByText('+919999900001')).not.toBeInTheDocument();
    expect(screen.queryByText('priya@example.in')).not.toBeInTheDocument();
  });

  it('renders total spent converted from paise, not the raw integer', () => {
    render(<ClientDetailPage />);
    // 1_050_000 paise = ₹10,500.
    expect(screen.getByText('₹10,500.00')).toBeInTheDocument();
    expect(screen.queryByText(/₹10,50,000/)).not.toBeInTheDocument();
  });

  it('renders lifetime value in rupees — the API sends ltvScore already in rupees', () => {
    render(<ClientDetailPage />);
    expect(screen.getByText('₹12,500')).toBeInTheDocument();
  });

  it('shows an em dash for lifetime value when the score has not been computed', () => {
    state.client.data = makeClient({ ltvScore: null });
    render(<ClientDetailPage />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows the order count', () => {
    render(<ClientDetailPage />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders churn risk as a whole percentage of the 0–1 ratio', () => {
    state.client.data = makeClient({ churnRisk: 0.42 });
    render(<ClientDetailPage />);
    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  // StatusBadge humanises the enum, so the band renders as "Low"/"Medium"/"High".
  it.each([
    [0.2, 'Low'],
    [0.3, 'Low'],
    [0.31, 'Medium'],
    [0.6, 'Medium'],
    [0.61, 'High'],
    [0.9, 'High'],
  ])('bands churn risk %s as %s', (risk, band) => {
    state.client.data = makeClient({ churnRisk: risk });
    render(<ClientDetailPage />);
    expect(screen.getByText(band)).toBeInTheDocument();
  });

  it('shows no churn band at all when the risk is unknown', () => {
    state.client.data = makeClient({ churnRisk: null });
    render(<ClientDetailPage />);

    expect(screen.queryByText('Low')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium')).not.toBeInTheDocument();
    expect(screen.queryByText('High')).not.toBeInTheDocument();
  });

  it('treats a zero churn risk as a real Low reading, not a missing one', () => {
    state.client.data = makeClient({ churnRisk: 0 });
    render(<ClientDetailPage />);

    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
  });
});

describe('ClientDetailPage — activity timeline', () => {
  it('shows a loading state for the timeline while the profile is already up', () => {
    state.timeline.isLoading = true;
    render(<ClientDetailPage />);

    expect(screen.getByRole('heading', { name: 'Priya Sharma' })).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('summarises an event as title · status · amount', () => {
    render(<ClientDetailPage />);
    expect(screen.getByText('Order #1042 · confirmed · ₹2,500.00')).toBeInTheDocument();
  });

  it('drops the amount from the summary when the event carries none', () => {
    state.timeline.data = {
      clientId: 'cl1',
      events: [makeEvent({ type: 'CONVERSATION', title: 'Chat started', amountPaise: undefined })],
      total: 1,
    };
    render(<ClientDetailPage />);
    expect(screen.getByText('Chat started · confirmed')).toBeInTheDocument();
  });

  it('shows an empty state when the client has no activity', () => {
    state.timeline.data = { clientId: 'cl1', events: [], total: 0 };
    render(<ClientDetailPage />);
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });

  it('shows an empty state when the timeline request returned nothing', () => {
    state.timeline.data = undefined;
    render(<ClientDetailPage />);
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });

  it('renders one row per event', () => {
    state.timeline.data = {
      clientId: 'cl1',
      events: [
        makeEvent({ id: 'ev1', title: 'Order #1042' }),
        makeEvent({ id: 'ev2', type: 'PAYMENT', title: 'Payment received' }),
        makeEvent({ id: 'ev3', type: 'BOOKING', title: 'Site visit booked' }),
      ],
      total: 3,
    };
    render(<ClientDetailPage />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText(/Payment received/)).toBeInTheDocument();
    expect(screen.getByText(/Site visit booked/)).toBeInTheDocument();
  });

  it('offers a way back to the client list', () => {
    render(<ClientDetailPage />);
    expect(screen.getByRole('link', { name: /Back to clients/ })).toHaveAttribute(
      'href',
      '/clients',
    );
  });

  it('drops the status from the summary when the event carries none', () => {
    state.timeline.data = {
      clientId: 'cl1',
      events: [makeEvent({ title: 'Order #1042', status: undefined })],
      total: 1,
    };
    render(<ClientDetailPage />);
    expect(screen.getByText('Order #1042 · ₹2,500.00')).toBeInTheDocument();
  });

  it('falls back to a neutral icon for an event type the dashboard does not know', () => {
    // The API can add timeline types ahead of the dashboard; an unmapped type
    // must still render its row rather than crash on an undefined component.
    state.timeline.data = {
      clientId: 'cl1',
      events: [makeEvent({ type: 'REFUND' as TimelineEvent['type'], title: 'Refund issued' })],
      total: 1,
    };
    render(<ClientDetailPage />);
    expect(screen.getByText(/Refund issued/)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows an empty state when the payload arrives without an events array', () => {
    state.timeline.data = { clientId: 'cl1', total: 0 } as unknown as ClientTimeline;
    render(<ClientDetailPage />);
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
  });
});

describe('ClientDetailPage — incomplete client records', () => {
  it('names an unidentified client rather than rendering a blank heading', () => {
    state.client.data = makeClient({ name: null });
    render(<ClientDetailPage />);
    expect(screen.getByRole('heading', { name: 'Unknown' })).toBeInTheDocument();
  });

  it('shows the photo when the client has one, and initials when they do not', () => {
    state.client.data = makeClient({ avatarUrl: 'https://cdn.example.in/priya.jpg' });
    const withPhoto = render(<ClientDetailPage />);
    expect(screen.getByRole('img', { name: 'Priya Sharma' })).toHaveAttribute(
      'src',
      'https://cdn.example.in/priya.jpg',
    );
    withPhoto.unmount();

    state.client.data = makeClient({ avatarUrl: null });
    render(<ClientDetailPage />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows zero orders rather than an empty tile when the count is missing', () => {
    state.client.data = makeClient({ totalOrders: null });
    render(<ClientDetailPage />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
