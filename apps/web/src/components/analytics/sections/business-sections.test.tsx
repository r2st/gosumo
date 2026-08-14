/**
 * The five business-analytics sections: Revenue, Conversations, Clients, AI
 * and Team.
 *
 * Each is mostly a chart, and the charts are stubbed here — a Recharts
 * `<ResponsiveContainer>` measures to zero in jsdom and renders nothing, so
 * asserting on it proves only that jsdom has no layout. What is worth pinning
 * is everything *around* the charts, which is where a wrong number reaches a
 * business owner looking at their own money:
 *
 *  - **Derived percentages with a zero denominator.** Churn rate, per-agent
 *    approval rate and the bar widths all divide by a total that is legitimately
 *    zero on a quiet period. Each must read 0%, not NaN%.
 *  - **Ordering the caller did not do.** The agent leaderboard sorts by
 *    resolved count itself and paints the top three; the source array arrives
 *    unsorted, so a section that trusted its input would crown the wrong agent.
 *  - **Empty vs absent.** Every section distinguishes "the request failed",
 *    "the request is in flight", "there is no data at all" and "there is data
 *    but this particular slice is empty" — four states that look alike in code
 *    and completely different to a reader.
 *
 * `TeamSection` is the one that deliberately renders without `data`: it reads
 * `data?.agentPerformance ?? []`, so a report that came back empty shows the
 * leaderboard's own empty state rather than the section-level one.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DateRange } from '@/components/analytics/date-range-picker';

// jsdom gives Recharts no box to measure, so the real components render
// nothing at all. Stub them to pass children straight through — the numbers
// under test live in the tables and lists beside the charts.
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nil = () => null;
  return {
    ResponsiveContainer: Pass,
    ComposedChart: Pass,
    AreaChart: Pass,
    BarChart: Pass,
    LineChart: Pass,
    PieChart: Pass,
    Area: Nil,
    Bar: Pass,
    Line: Nil,
    Pie: Pass,
    Cell: Nil,
    XAxis: Nil,
    YAxis: Nil,
    Tooltip: Nil,
    Legend: Nil,
  };
});

interface Query<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: ReturnType<typeof vi.fn>;
}

function idle<T>(data: T): Query<T> {
  return { data, isLoading: false, isError: false, refetch: vi.fn() };
}
function loading<T>(): Query<T> {
  return { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
}
function failed<T>(): Query<T> {
  return { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
}
function blank<T>(): Query<T> {
  // Resolved, but with nothing usable — distinct from both loading and error.
  return { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let revenueQ: Query<any>;
let conversationsQ: Query<any>;
let clientsQ: Query<any>;
let aiQ: Query<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

vi.mock('@/hooks/use-analytics', () => ({
  useRevenueReportFull: () => revenueQ,
  useConversationReportFull: () => conversationsQ,
  useClientReport: () => clientsQ,
  useAutonomyReport: () => aiQ,
}));

import { RevenueSection } from './revenue-section';
import { ConversationsSection } from './conversations-section';
import { ClientsSection } from './clients-section';
import { AiSection } from './ai-section';
import { TeamSection } from './team-section';

const RANGE = { from: '2026-07-01', to: '2026-07-31' } as unknown as DateRange;

function makeRevenue(overrides: Record<string, unknown> = {}) {
  return {
    summary: {
      totalRevenue: 12_50_000,
      netRevenue: 11_00_000,
      totalRefunds: 1_50_000,
      totalOrders: 42,
      avgOrderValue: 29_761,
    },
    timeSeries: [{ date: '2026-07-01', revenue: 50_000, orders: 2 }],
    topProducts: [{ itemId: 'p1', name: 'Turmeric Latte Mix', quantity: 18, revenue: 8_10_000 }],
    fulfillmentBreakdown: { HOME_DELIVERY: { orders: 30, revenue: 9_00_000 } },
    ...overrides,
  };
}

function makeConversations(overrides: Record<string, unknown> = {}) {
  return {
    summary: {
      total: 318,
      avgResolutionTimeMs: 3_600_000,
      avgFirstResponseTimeMs: 120_000,
      csat: 4.4,
    },
    timeSeries: [{ date: '2026-07-01', created: 12, resolved: 10, escalated: 1 }],
    channelBreakdown: [{ channel: 'WHATSAPP', count: 200 }],
    topIntents: [
      { intent: 'ORDER_STATUS', count: 80 },
      { intent: 'PRICE_ENQUIRY', count: 20 },
    ],
    agentPerformance: [],
    ...overrides,
  };
}

function makeClients(overrides: Record<string, unknown> = {}) {
  return {
    summary: { total: 540, newClients: 60, returning: 480, avgLtv: 4_50_000, churnRiskHigh: 12 },
    acquisitionTimeSeries: [{ date: '2026-07-01', newClients: 4 }],
    churnRiskBreakdown: { low: 400, medium: 128, high: 12 },
    channelPreferences: { WHATSAPP: 300, INSTAGRAM: 100 },
    sentimentDistribution: { POSITIVE: 250, NEUTRAL: 200 },
    ...overrides,
  };
}

function makeAi(overrides: Record<string, unknown> = {}) {
  return {
    summary: { autonomyRate: 0.82, totalDecisions: 1420, trend: 3.4 },
    timeSeries: [{ date: '2026-07-01', autonomyRate: 0.8 }],
    confidenceDistribution: [
      { bucket: '50-59', count: 20 },
      { bucket: '70-79', count: 60 },
      { bucket: '90-99', count: 300 },
    ],
    topEscalationReasons: [
      { reason: 'Refund over policy limit', count: 30 },
      { reason: 'Unknown product', count: 5 },
    ],
    intentBreakdown: [
      { intent: 'ORDER_STATUS', count: 400, autonomyRate: 0.95, avgConfidence: 0.92 },
    ],
    ...overrides,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'u1',
    name: 'Priya Nair',
    resolved: 40,
    avgResolutionTimeMs: 1_800_000,
    tasksApproved: 18,
    tasksRejected: 2,
    ...overrides,
  };
}

beforeEach(() => {
  revenueQ = idle(makeRevenue());
  conversationsQ = idle(makeConversations());
  clientsQ = idle(makeClients());
  aiQ = idle(makeAi());
});

// ── Every section handles the same four query states ────────────────────────

describe('query states', () => {
  const sections = [
    ['Revenue', () => <RevenueSection range={RANGE} />, () => revenueQ, 'No revenue data'],
    [
      'Conversations',
      () => <ConversationsSection range={RANGE} />,
      () => conversationsQ,
      'No conversation data',
    ],
    ['Clients', () => <ClientsSection range={RANGE} />, () => clientsQ, 'No client data'],
    ['AI', () => <AiSection range={RANGE} />, () => aiQ, 'No AI decisions yet'],
  ] as const;

  it.each(sections)('%s offers a retry when the report fails', (_name, Section, get) => {
    Object.assign(get(), failed());

    render(<Section />);
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));

    expect(get().refetch).toHaveBeenCalled();
  });

  it.each(sections)('%s shows a skeleton while the report loads', (_name, Section, get) => {
    Object.assign(get(), loading());

    render(<Section />);

    // No numbers on screen yet — a section that rendered zeros here would read
    // as a real (and alarming) result.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again|retry/i })).not.toBeInTheDocument();
  });

  it.each(sections)('%s says "%s" when the report is empty', (_n, Section, get, message) => {
    Object.assign(get(), blank());

    render(<Section />);

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('an error takes precedence over a stale loading flag', () => {
    // React Query can report both during a background refetch that fails; the
    // retry button is the more useful of the two.
    Object.assign(revenueQ, { data: undefined, isLoading: true, isError: true });

    render(<RevenueSection range={RANGE} />);

    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });
});

// ── Revenue ─────────────────────────────────────────────────────────────────

describe('RevenueSection', () => {
  it('shows the money in rupees, never in the paise it arrived as', () => {
    render(<RevenueSection range={RANGE} />);

    expect(screen.queryByText(/1250000/)).not.toBeInTheDocument();
    expect(screen.getByText('Total revenue')).toBeInTheDocument();
    expect(screen.getByText('Net revenue')).toBeInTheDocument();
  });

  it('reports refunds as a hint on net revenue, so the gap is explained', () => {
    render(<RevenueSection range={RANGE} />);

    expect(screen.getByText(/refunded/)).toBeInTheDocument();
  });

  it('lists top products with units and revenue', () => {
    render(<RevenueSection range={RANGE} />);

    const row = screen.getByText('Turmeric Latte Mix').closest('tr') as HTMLElement;
    expect(within(row).getByText('18')).toBeInTheDocument();
  });

  it('caps the product table at ten rows', () => {
    revenueQ = idle(
      makeRevenue({
        topProducts: Array.from({ length: 25 }, (_, i) => ({
          itemId: `p${i}`,
          name: `Product ${i}`,
          quantity: 1,
          revenue: 100,
        })),
      }),
    );

    render(<RevenueSection range={RANGE} />);

    expect(screen.getByText('Product 9')).toBeInTheDocument();
    expect(screen.queryByText('Product 10')).not.toBeInTheDocument();
  });

  it('humanises the fulfillment enum rather than printing it raw', () => {
    render(<RevenueSection range={RANGE} />);

    expect(screen.queryByText('HOME_DELIVERY')).not.toBeInTheDocument();
    expect(screen.getByText(/30 orders/)).toBeInTheDocument();
  });

  it('distinguishes an empty slice from an empty report', () => {
    revenueQ = idle(makeRevenue({ timeSeries: [], topProducts: [], fulfillmentBreakdown: {} }));

    render(<RevenueSection range={RANGE} />);

    // The KPIs are still there — the period had revenue, this breakdown just
    // has nothing in it.
    expect(screen.getByText('Total revenue')).toBeInTheDocument();
    expect(screen.getByText('No revenue in this period')).toBeInTheDocument();
    expect(screen.getByText('No sales data yet')).toBeInTheDocument();
    expect(screen.getByText('No fulfillment data')).toBeInTheDocument();
  });

  it('survives a report with no fulfillment key at all', () => {
    revenueQ = idle(makeRevenue({ fulfillmentBreakdown: undefined }));

    expect(() => render(<RevenueSection range={RANGE} />)).not.toThrow();
    expect(screen.getByText('No fulfillment data')).toBeInTheDocument();
  });
});

// ── Conversations ───────────────────────────────────────────────────────────

describe('ConversationsSection', () => {
  it('renders CSAT out of five', () => {
    render(<ConversationsSection range={RANGE} />);

    expect(screen.getByText('4.4/5')).toBeInTheDocument();
    // …and not the raw float.
    expect(screen.queryByText('4.4')).not.toBeInTheDocument();
  });

  it('dashes CSAT rather than showing 0.0/5 when nobody has rated', () => {
    // `0.0/5` would read as universally terrible service instead of "no data".
    conversationsQ = idle(makeConversations({ summary: { ...makeConversations().summary, csat: null } }));

    render(<ConversationsSection range={RANGE} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('0.0/5')).not.toBeInTheDocument();
  });

  it('scales intent bars against the largest intent, not against the total', () => {
    render(<ConversationsSection range={RANGE} />);

    const rows = screen.getByText('Price Enquiry').closest('li') as HTMLElement;
    // 20 of a 80-max ⇒ 25%, not 20% of the 100 total.
    expect(rows.querySelector<HTMLElement>('div > div')?.style.width).toBe('25%');
  });

  it('keeps a sliver of bar visible for a negligible intent', () => {
    conversationsQ = idle(
      makeConversations({
        topIntents: [
          { intent: 'ORDER_STATUS', count: 1000 },
          { intent: 'OTHER', count: 1 },
        ],
      }),
    );

    render(<ConversationsSection range={RANGE} />);

    const li = screen.getByText('Other').closest('li') as HTMLElement;
    expect(li.querySelector<HTMLElement>('div > div')?.style.width).toBe('4%');
  });

  it('caps the intent list at eight', () => {
    conversationsQ = idle(
      makeConversations({
        topIntents: Array.from({ length: 20 }, (_, i) => ({ intent: `INTENT_${i}`, count: 20 - i })),
      }),
    );

    render(<ConversationsSection range={RANGE} />);

    expect(screen.getByText('Intent 7')).toBeInTheDocument();
    expect(screen.queryByText('Intent 8')).not.toBeInTheDocument();
  });

  it('does not divide by zero when every intent has a zero count', () => {
    conversationsQ = idle(makeConversations({ topIntents: [{ intent: 'GREETING', count: 0 }] }));

    render(<ConversationsSection range={RANGE} />);

    const li = screen.getByText('Greeting').closest('li') as HTMLElement;
    expect(li.querySelector<HTMLElement>('div > div')?.style.width).toBe('4%');
  });

  it('shows each empty slice on its own', () => {
    conversationsQ = idle(
      makeConversations({ timeSeries: [], channelBreakdown: [], topIntents: [] }),
    );

    render(<ConversationsSection range={RANGE} />);

    expect(screen.getByText('No conversations in this period')).toBeInTheDocument();
    expect(screen.getByText('No channel data')).toBeInTheDocument();
    expect(screen.getByText('No intents detected')).toBeInTheDocument();
  });
});

// ── Clients ─────────────────────────────────────────────────────────────────

describe('ClientsSection', () => {
  it('computes the high-churn rate against the whole risk population', () => {
    render(<ClientsSection range={RANGE} />);

    // 12 high of 540 classified ⇒ 2.2%.
    expect(screen.getByText('2.2%')).toBeInTheDocument();
  });

  it('reads 0.0% rather than NaN% when nobody has been classified yet', () => {
    clientsQ = idle(makeClients({ churnRiskBreakdown: { low: 0, medium: 0, high: 0 } }));

    render(<ClientsSection range={RANGE} />);

    expect(screen.getByText('0.0%')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('shows every risk band, including the ones with nobody in them', () => {
    clientsQ = idle(makeClients({ churnRiskBreakdown: { low: 10, medium: 0, high: 0 } }));

    render(<ClientsSection range={RANGE} />);

    // A missing band would read as "we stopped tracking medium risk".
    expect(screen.getByText('high risk')).toBeInTheDocument();
    expect(screen.getByText('medium risk')).toBeInTheDocument();
    expect(screen.getByText('low risk')).toBeInTheDocument();
  });

  it('drops a zero slice from the new-vs-returning donut', () => {
    // A zero-value wedge renders as an invisible slice with a visible legend
    // row claiming a colour nobody can see.
    clientsQ = idle(
      makeClients({ summary: { ...makeClients().summary, newClients: 0, returning: 480 } }),
    );

    render(<ClientsSection range={RANGE} />);

    const donut = screen.getByText('New vs returning').closest('div')
      ?.parentElement as HTMLElement;
    expect(within(donut).queryByText('New')).not.toBeInTheDocument();
    expect(within(donut).getByText('Returning')).toBeInTheDocument();
  });

  it('falls back to an empty state when neither new nor returning has anyone', () => {
    clientsQ = idle(
      makeClients({ summary: { ...makeClients().summary, newClients: 0, returning: 0 } }),
    );

    render(<ClientsSection range={RANGE} />);

    expect(screen.getAllByText('No client data').length).toBeGreaterThan(0);
  });

  it('orders acquisition channels by volume, largest first', () => {
    clientsQ = idle(makeClients({ channelPreferences: { INSTAGRAM: 10, WHATSAPP: 300, SMS: 50 } }));

    render(<ClientsSection range={RANGE} />);

    const labels = screen
      .getByText('Acquisition channels')
      .closest('div')
      ?.parentElement?.querySelectorAll('li span:first-child');
    expect(labels?.[0]?.textContent).toBe('WhatsApp');
  });

  it('copes with a report carrying neither channel nor sentiment keys', () => {
    clientsQ = idle(makeClients({ channelPreferences: undefined, sentimentDistribution: {} }));

    expect(() => render(<ClientsSection range={RANGE} />)).not.toThrow();
    expect(screen.getByText('No channel data')).toBeInTheDocument();
    expect(screen.getByText('No sentiment data')).toBeInTheDocument();
  });

  it('humanises sentiment labels', () => {
    render(<ClientsSection range={RANGE} />);

    expect(screen.queryByText('POSITIVE')).not.toBeInTheDocument();
    expect(screen.getByText('Positive')).toBeInTheDocument();
  });
});

// ── AI ──────────────────────────────────────────────────────────────────────

describe('AiSection', () => {
  /** The trend figure, sign and all, as one string. */
  function trendText(): string {
    return screen.getByText('vs previous').previousElementSibling?.textContent ?? '';
  }

  it('signs a rising trend with an explicit plus', () => {
    render(<AiSection range={RANGE} />);

    expect(trendText()).toBe('+3.4%');
  });

  it('shows a falling trend without a spurious plus', () => {
    aiQ = idle(makeAi({ summary: { autonomyRate: 0.6, totalDecisions: 100, trend: -2.5 } }));

    render(<AiSection range={RANGE} />);

    // The minus already comes from the number; a `+-2.5%` would be nonsense.
    expect(trendText()).toBe('-2.5%');
  });

  it('colours a fall as a loss rather than a gain', () => {
    aiQ = idle(makeAi({ summary: { autonomyRate: 0.6, totalDecisions: 100, trend: -2.5 } }));

    render(<AiSection range={RANGE} />);

    const el = screen.getByText('vs previous').previousElementSibling as HTMLElement;
    expect(el.className).toContain('text-danger');
  });

  it('labels the three confidence routing bands from the blueprint', () => {
    render(<AiSection range={RANGE} />);

    expect(screen.getByText('< 70 · Escalate')).toBeInTheDocument();
    expect(screen.getByText('70–89 · Draft review')).toBeInTheDocument();
    expect(screen.getByText('≥ 90 · Auto-execute')).toBeInTheDocument();
  });

  it('scales escalation bars against the most common reason', () => {
    render(<AiSection range={RANGE} />);

    const li = screen.getByText('Unknown product').closest('li') as HTMLElement;
    // 5 of a 30-max ⇒ 16.67%.
    expect(li.querySelector<HTMLElement>('div > div')?.style.width).toMatch(/^16\.6/);
  });

  it('caps escalation reasons and the intent table at eight rows each', () => {
    aiQ = idle(
      makeAi({
        topEscalationReasons: Array.from({ length: 12 }, (_, i) => ({
          reason: `Reason ${i}`,
          count: 12 - i,
        })),
        intentBreakdown: Array.from({ length: 12 }, (_, i) => ({
          intent: `INTENT_${i}`,
          count: 1,
          autonomyRate: 0.5,
          avgConfidence: 0.5,
        })),
      }),
    );

    render(<AiSection range={RANGE} />);

    expect(screen.getByText('Reason 7')).toBeInTheDocument();
    expect(screen.queryByText('Reason 8')).not.toBeInTheDocument();
    expect(screen.getByText('Intent 7')).toBeInTheDocument();
    expect(screen.queryByText('Intent 8')).not.toBeInTheDocument();
  });

  it('celebrates rather than blanks when there were no escalations', () => {
    aiQ = idle(makeAi({ topEscalationReasons: [] }));

    render(<AiSection range={RANGE} />);

    expect(screen.getByText('No escalations — nice!')).toBeInTheDocument();
  });

  it('shows each empty slice on its own', () => {
    aiQ = idle(makeAi({ confidenceDistribution: [], timeSeries: [], intentBreakdown: [] }));

    render(<AiSection range={RANGE} />);

    expect(screen.getByText('No AI decisions yet')).toBeInTheDocument();
    expect(screen.getByText('Not enough data for a trend')).toBeInTheDocument();
    expect(screen.getByText('No intent data')).toBeInTheDocument();
  });
});

// ── Team ────────────────────────────────────────────────────────────────────

describe('TeamSection', () => {
  function withAgents(agents: Record<string, unknown>[]) {
    conversationsQ = idle(makeConversations({ agentPerformance: agents }));
  }

  it('ranks agents by resolved count regardless of the order they arrive in', () => {
    withAgents([
      makeAgent({ userId: 'u1', name: 'Priya Nair', resolved: 12 }),
      makeAgent({ userId: 'u2', name: 'Vikram Shah', resolved: 40 }),
      makeAgent({ userId: 'u3', name: 'Anita Rao', resolved: 25 }),
    ]);

    render(<TeamSection range={RANGE} />);

    // The name cell also holds an avatar with the agent's initials, so read
    // the name span rather than the whole cell.
    const names = [...screen.getAllByRole('row')]
      .slice(1)
      .map((r) => r.querySelector('td:nth-child(2) span.font-medium')?.textContent);
    expect(names).toEqual(['Vikram Shah', 'Anita Rao', 'Priya Nair']);
  });

  it('does not mutate the array it was handed while sorting it', () => {
    // The same report object backs the Conversations tab; sorting in place
    // would reorder that view as a side effect of visiting this one.
    const agents = [
      makeAgent({ userId: 'u1', name: 'Priya Nair', resolved: 12 }),
      makeAgent({ userId: 'u2', name: 'Vikram Shah', resolved: 40 }),
    ];
    withAgents(agents);

    render(<TeamSection range={RANGE} />);

    expect(agents[0]!.name).toBe('Priya Nair');
  });

  it('medals only the top three', () => {
    withAgents(
      Array.from({ length: 5 }, (_, i) =>
        makeAgent({ userId: `u${i}`, name: `Agent ${i}`, resolved: 100 - i }),
      ),
    );

    render(<TeamSection range={RANGE} />);

    const rows = [...screen.getAllByRole('row')].slice(1);
    // The medal is a coloured pill; ranks four and up are plain text.
    expect(rows[2]!.querySelector('span')?.className).toContain('rounded-full');
    expect(rows[3]!.querySelector('span')?.className).not.toContain('rounded-full');
  });

  it('computes approval against reviewed tasks only', () => {
    withAgents([makeAgent({ tasksApproved: 18, tasksRejected: 2 })]);

    render(<TeamSection range={RANGE} />);

    expect(screen.getByText('90%')).toBeInTheDocument();
  });

  it('reads 0% rather than NaN% for an agent who has reviewed nothing', () => {
    withAgents([makeAgent({ tasksApproved: 0, tasksRejected: 0 })]);

    render(<TeamSection range={RANGE} />);

    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it.each([
    [18, 2, 'emerald'],  // success — 90%
    [6, 4, 'amber'],     // warning — 60%
    [2, 8, 'rose'],      // danger  — 20%
  ])('tones a %i/%i approval record with the %s palette', (approved, rejected, palette) => {
    withAgents([makeAgent({ tasksApproved: approved, tasksRejected: rejected })]);

    render(<TeamSection range={RANGE} />);

    const pct = ((approved / (approved + rejected)) * 100).toFixed(0);
    expect(screen.getByText(`${pct}%`).className).toContain(palette);
  });

  it('shows the leaderboard empty state when the report has no agents', () => {
    withAgents([]);

    render(<TeamSection range={RANGE} />);

    expect(screen.getByText('No agent activity in this period')).toBeInTheDocument();
  });

  it('shows the same empty state when the report itself is absent', () => {
    // Unlike its siblings this section has no `if (!data)` guard — it reads
    // `data?.agentPerformance ?? []`, so a blank report must land here rather
    // than throw.
    Object.assign(conversationsQ, blank());

    expect(() => render(<TeamSection range={RANGE} />)).not.toThrow();
    expect(screen.getByText('No agent activity in this period')).toBeInTheDocument();
  });

  it('offers a retry when the report fails', () => {
    Object.assign(conversationsQ, failed());

    render(<TeamSection range={RANGE} />);
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));

    expect(conversationsQ.refetch).toHaveBeenCalled();
  });
});
