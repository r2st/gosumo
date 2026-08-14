/**
 * The dashboard home — five KPI tiles, four charts, and the recent-activity feed.
 *
 * Almost every number on this screen is derived rather than served: the
 * resolution rate is `resolved / total` computed client-side (and must not
 * divide by zero on a fresh tenant), revenue arrives in paise and has to be
 * rendered compact, and the "active bookings" tile reads a *pagination total*
 * rather than the length of the one-row page it requested. Each chart is
 * additionally gated on its own query, so a slow revenue report must not blank
 * the conversation chart next to it. The tests below pin those derivations and
 * the per-query gating; recharts is stubbed since it cannot lay out in jsdom.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Conversation,
  ConversationReport,
  DashboardMetrics,
  RevenueReport,
} from '@/lib/types';

vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Pass,
    AreaChart: Pass,
    BarChart: Pass,
    LineChart: Pass,
    PieChart: Pass,
    Area: Nothing,
    Bar: Nothing,
    Line: Nothing,
    Pie: Nothing,
    Cell: Nothing,
    Legend: Nothing,
    XAxis: Nothing,
    YAxis: Nothing,
    Tooltip: Nothing,
  };
});

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The two realty widgets on this page have their own tests; here they are just
// noise between the KPI row and the charts.
vi.mock('@/components/dashboard/briefing-metrics', () => ({
  BriefingMetrics: () => <div data-testid="briefing-metrics" />,
}));
vi.mock('@/components/dashboard/morning-briefing', () => ({
  MorningBriefing: () => <div data-testid="morning-briefing" />,
}));
vi.mock('@/components/dashboard/north-star-kpi', () => ({
  NorthStarKpi: () => <div data-testid="north-star" />,
}));

interface QueryStub<T> {
  data?: T;
  isLoading: boolean;
  isError: boolean;
  error?: Error;
}

const refetchMetrics = vi.fn();

let metricsQ: QueryStub<DashboardMetrics>;
let convReportQ: QueryStub<ConversationReport>;
let revReportQ: QueryStub<RevenueReport>;
let bookingsQ: QueryStub<{ pagination: { total: number } }>;
let recentQ: QueryStub<{ data: Conversation[] }>;

vi.mock('@/hooks/use-queries', () => ({
  useDashboardMetrics: () => ({ ...metricsQ, refetch: refetchMetrics }),
  useConversationReport: () => convReportQ,
  useRevenueReport: () => revReportQ,
  useBookings: () => bookingsQ,
  useConversations: () => recentQ,
}));

import DashboardPage from './page';

const idle = <T,>(data?: T): QueryStub<T> => ({ data, isLoading: false, isError: false });

function makeMetrics(overrides: Partial<DashboardMetrics> = {}): DashboardMetrics {
  return {
    period: { from: '2026-08-07T00:00:00.000Z', to: '2026-08-14T00:00:00.000Z' },
    conversations: {
      total: 200,
      open: 12,
      resolved: 150,
      escalated: 8,
      avgResolutionTimeMs: 3_600_000,
      avgFirstResponseTimeMs: 90_000,
    },
    messages: { inbound: 500, outbound: 480, aiSent: 400, humanSent: 80 },
    ai: {
      autonomyRate: 0.8,
      avgConfidence: 0.9,
      autoExecuted: 400,
      reviewed: 60,
      escalated: 8,
      approvalRate: 0.94,
    },
    revenue: { total: 12_000_000, orders: 24, avgOrderValue: 500_000 },
    channels: [
      { channelType: 'WHATSAPP', conversationCount: 160, messageCount: 800 },
      { channelType: 'WEB_CHAT', conversationCount: 40, messageCount: 120 },
    ],
    ...overrides,
  } as DashboardMetrics;
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    businessId: 'b1',
    clientId: 'cl1',
    channelType: 'WHATSAPP',
    status: 'OPEN',
    lastMessagePreview: 'Is the 3BHK still available?',
    lastMessageAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    client: { id: 'cl1', name: 'Asha Rao', avatarUrl: null },
    ...overrides,
  } as Conversation;
}

/** The KPI tile whose label is `label`, as a queryable subtree. */
const tile = (label: string) => screen.getByText(label).closest('div')!.parentElement!;

beforeEach(() => {
  vi.clearAllMocks();
  metricsQ = idle(makeMetrics());
  convReportQ = idle({
    timeSeries: [{ date: '2026-08-13', created: 20, resolved: 18 }],
  } as ConversationReport);
  revReportQ = idle({ timeSeries: [{ date: '2026-08-13', revenue: 500_000 }] } as RevenueReport);
  bookingsQ = idle({ pagination: { total: 7 } });
  recentQ = idle({ data: [makeConversation()] });
});

describe('DashboardPage KPI row', () => {
  it('derives the resolution rate from the conversation counters', () => {
    render(<DashboardPage />);

    // 150 / 200 — the API sends the parts, not the percentage.
    expect(tile('Resolution rate')).toHaveTextContent('75.0%');
    expect(tile('Resolution rate')).toHaveTextContent('150 resolved');
  });

  it('reports 0% rather than NaN for a tenant with no conversations yet', () => {
    metricsQ = idle(
      makeMetrics({
        conversations: {
          total: 0,
          open: 0,
          resolved: 0,
          escalated: 0,
          avgResolutionTimeMs: 0,
          avgFirstResponseTimeMs: 0,
        },
      } as Partial<DashboardMetrics>),
    );
    render(<DashboardPage />);

    // 0/0 is NaN; the guard has to short-circuit before the division.
    expect(tile('Resolution rate')).toHaveTextContent('0.0%');
    expect(tile('Resolution rate')).not.toHaveTextContent('NaN');
  });

  it('renders revenue compactly from paise', () => {
    render(<DashboardPage />);

    // 12,000,000 paise = ₹1,20,000.
    expect(tile('Revenue')).toHaveTextContent('₹1.20L');
    expect(tile('Revenue')).toHaveTextContent('24 orders');
  });

  it('reads the booking count from the pagination total, not the page length', () => {
    // The query asks for limit=1 purely to get the count cheaply — using
    // `data.length` here would permanently display "1".
    render(<DashboardPage />);

    expect(tile('Active bookings')).toHaveTextContent('7');
  });

  it('formats the first-response time as a duration', () => {
    render(<DashboardPage />);

    expect(tile('Avg response time')).toHaveTextContent('1m 30s');
  });

  it('shows zeroes instead of crashing before the metrics land', () => {
    metricsQ = { data: undefined, isLoading: true, isError: false };
    bookingsQ = { data: undefined, isLoading: true, isError: false };
    render(<DashboardPage />);

    // Every tile is a skeleton, so none of the fallback zeroes is on screen.
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    expect(screen.getByText('Conversations')).toBeInTheDocument();
  });
});

describe('DashboardPage error handling', () => {
  it('replaces the whole body with a retry when the metrics query fails', () => {
    metricsQ = { data: undefined, isLoading: false, isError: true, error: new Error('boom') };
    render(<DashboardPage />);

    expect(screen.queryByText('Resolution rate')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchMetrics).toHaveBeenCalledTimes(1);
  });

  it('keeps the morning briefing above the error so the day is still readable', () => {
    metricsQ = { data: undefined, isLoading: false, isError: true, error: new Error('boom') };
    render(<DashboardPage />);

    expect(screen.getByTestId('briefing-metrics')).toBeInTheDocument();
    expect(screen.getByTestId('morning-briefing')).toBeInTheDocument();
  });
});

describe('DashboardPage charts', () => {
  it('gates each chart on its own query rather than a shared flag', () => {
    revReportQ = { data: undefined, isLoading: true, isError: false };
    const { container } = render(<DashboardPage />);

    // The revenue card is a skeleton while the conversation card next to it
    // has already rendered.
    const revenueCard = screen.getByText('Revenue trend').closest('div')!.parentElement!;
    expect(revenueCard.querySelector('.animate-pulse')).toBeTruthy();
    expect(container.querySelectorAll('.animate-pulse').length).toBe(1);
  });

  it('shows the empty state when a report came back with no buckets', () => {
    convReportQ = idle({ timeSeries: [] } as unknown as ConversationReport);
    render(<DashboardPage />);

    const card = screen.getByText('Conversation volume (7 days)').closest('div')!.parentElement!;
    expect(within(card).getByText('No data yet')).toBeInTheDocument();
  });

  it('treats an all-zero AI/human split as empty', () => {
    metricsQ = idle(
      makeMetrics({ messages: { inbound: 0, outbound: 0, aiSent: 0, humanSent: 0 } }),
    );
    render(<DashboardPage />);

    const card = screen.getByText('AI vs human resolution').closest('div')!.parentElement!;
    expect(within(card).getByText('No data yet')).toBeInTheDocument();
  });

  it('treats a tenant with no connected channels as an empty channel chart', () => {
    metricsQ = idle(makeMetrics({ channels: [] }));
    render(<DashboardPage />);

    const card = screen.getByText('Conversations by channel').closest('div')!.parentElement!;
    expect(within(card).getByText('No data yet')).toBeInTheDocument();
  });
});

describe('DashboardPage recent activity', () => {
  it('links each row to that conversation in the inbox', () => {
    render(<DashboardPage />);

    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('Is the 3BHK still available?')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Asha Rao/ })).toHaveAttribute(
      'href',
      '/conversations?id=c1',
    );
  });

  it('labels a conversation whose client failed to expand', () => {
    recentQ = idle({ data: [makeConversation({ client: undefined, lastMessagePreview: null })] });
    render(<DashboardPage />);

    expect(screen.getByText('Unknown client')).toBeInTheDocument();
    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });

  it('invites the first conversation when the feed is empty', () => {
    recentQ = idle({ data: [] });
    render(<DashboardPage />);

    expect(screen.getByText('No recent conversations')).toBeInTheDocument();
  });
});
