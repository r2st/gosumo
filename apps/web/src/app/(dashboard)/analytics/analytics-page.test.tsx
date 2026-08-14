/**
 * The Analytics page and the six report sections it switches between.
 *
 * The page itself is a router over sections, so the tests walk every tab and
 * check that each one renders its own report rather than the previous tab's,
 * and that the two exports behave differently by design: the CSV is built in
 * the browser from data already on screen and stays available to every role,
 * while the PDF queues a server-side render and is therefore a write that a
 * VIEWER must not be offered. The sections are covered through the numbers they
 * derive — approval rate, churn rate, leaderboard order — rather than markup.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutonomyReport, ClientReport, Role } from '@/lib/feature-types';
import type { ConversationReport, DashboardMetrics, RevenueReport } from '@/lib/types';

// Recharts cannot lay out in jsdom; the assertions are about the surrounding
// tables, KPI tiles and legends the sections derive.
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nothing = () => null;
  return {
    ResponsiveContainer: Pass,
    AreaChart: Pass,
    BarChart: Pass,
    LineChart: Pass,
    PieChart: Pass,
    ComposedChart: Pass,
    Area: Nothing,
    Bar: Pass,
    Line: Nothing,
    Pie: Nothing,
    Cell: Nothing,
    XAxis: Nothing,
    YAxis: Nothing,
    Tooltip: Nothing,
    Legend: Nothing,
    CartesianGrid: Nothing,
  };
});

const METRICS: DashboardMetrics = {
  period: { from: '2026-07-15T00:00:00.000Z', to: '2026-08-14T00:00:00.000Z' },
  conversations: {
    total: 420,
    open: 30,
    resolved: 380,
    escalated: 10,
    avgResolutionTimeMs: 3_600_000,
    avgFirstResponseTimeMs: 120_000,
  },
  messages: { inbound: 900, outbound: 850, aiSent: 700, humanSent: 150 },
  ai: {
    autonomyRate: 0.82,
    avgConfidence: 0.91,
    autoExecuted: 700,
    reviewed: 120,
    escalated: 30,
    approvalRate: 0.95,
  },
  revenue: { total: 12_50_000_00, orders: 40, payments: 38, avgOrderValue: 31_250_00 },
  clients: { total: 300, newThisPeriod: 25, activeThisPeriod: 180, churnRisk: 12 },
  channels: [
    { channelType: 'WHATSAPP', messageCount: 800, conversationCount: 300 },
    { channelType: 'INSTAGRAM', messageCount: 100, conversationCount: 60 },
  ],
};

const CONVERSATIONS: ConversationReport & { agentPerformance?: unknown[] } = {
  summary: {
    total: 420,
    avgResolutionTimeMs: 3_600_000,
    avgFirstResponseTimeMs: 120_000,
    csat: 4.35,
  },
  timeSeries: [{ date: '2026-08-01', created: 20, resolved: 18, escalated: 1, avgResolutionTimeMs: 3_000_000 }],
  channelBreakdown: [{ channel: 'WHATSAPP', count: 300, avgResolutionTimeMs: 3_000_000 }],
  topIntents: [
    { intent: 'PRICE_ENQUIRY', count: 120 },
    { intent: 'BOOKING_REQUEST', count: 60 },
  ],
  agentPerformance: [
    {
      userId: 'u2',
      name: 'Nina Shah',
      resolved: 40,
      avgResolutionTimeMs: 2_400_000,
      tasksApproved: 9,
      tasksRejected: 1,
    },
    {
      userId: 'u1',
      name: 'Ravi Kumar',
      resolved: 120,
      avgResolutionTimeMs: 1_800_000,
      tasksApproved: 4,
      tasksRejected: 6,
    },
  ],
};

const REVENUE: RevenueReport & { fulfillmentBreakdown?: Record<string, { orders: number; revenue: number }> } = {
  summary: {
    totalRevenue: 12_50_000_00,
    totalOrders: 40,
    avgOrderValue: 31_250_00,
    totalRefunds: 50_000_00,
    netRevenue: 12_00_000_00,
  },
  timeSeries: [{ date: '2026-08-01', revenue: 1_00_000_00, orders: 4, refunds: 0 }],
  topProducts: [{ itemId: 'i1', name: 'Deluxe Package', quantity: 12, revenue: 3_00_000_00 }],
  fulfillmentBreakdown: { HOME_DELIVERY: { orders: 30, revenue: 9_00_000_00 } },
};

const CLIENTS: ClientReport = {
  summary: { total: 300, newClients: 25, returning: 275, avgLtv: 40_000_00, churnRiskHigh: 12 },
  acquisitionTimeSeries: [{ date: '2026-08-01', newClients: 3 }],
  churnRiskBreakdown: { low: 200, medium: 88, high: 12 },
  sentimentDistribution: { POSITIVE: 200, NEUTRAL: 80, NEGATIVE: 20 },
  topTags: [{ tag: 'vip', count: 10 }],
  channelPreferences: { WHATSAPP: 250, SMS: 50 },
};

const AUTONOMY: AutonomyReport = {
  summary: { autonomyRate: 0.82, trend: 3.4, totalDecisions: 850 },
  timeSeries: [
    { date: '2026-08-01', autonomyRate: 0.8, autoExecuted: 40, reviewed: 8, escalated: 2 },
  ],
  intentBreakdown: [{ intent: 'PRICE_ENQUIRY', count: 120, autonomyRate: 0.9, avgConfidence: 0.93 }],
  confidenceDistribution: [
    { bucket: '50-59', count: 10 },
    { bucket: '70-79', count: 40 },
    { bucket: '90-99', count: 300 },
  ],
  topEscalationReasons: [{ reason: 'LOW_CONFIDENCE', count: 18 }],
};

const q = <T,>(data: T) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });

const state = {
  metrics: q<DashboardMetrics | undefined>(METRICS),
  conversations: q<typeof CONVERSATIONS | undefined>(CONVERSATIONS),
  revenue: q<typeof REVENUE | undefined>(REVENUE),
  clients: q<ClientReport | undefined>(CLIENTS),
  autonomy: q<AutonomyReport | undefined>(AUTONOMY),
  board: q<Array<{ stage: string; count: number }> | undefined>([]),
  leads: q<{ data: unknown[] } | undefined>({ data: [] }),
  visits: q<{ data: unknown[] } | undefined>({ data: [] }),
};

const exportReport = vi.fn();
let role: Role = 'MANAGER';

vi.mock('@/hooks/use-queries', () => ({ useDashboardMetrics: () => state.metrics }));

vi.mock('@/hooks/use-analytics', () => ({
  useConversationReportFull: () => state.conversations,
  useRevenueReportFull: () => state.revenue,
  useClientReport: () => state.clients,
  useAutonomyReport: () => state.autonomy,
  useExportReport: () => ({ mutate: exportReport, isPending: false }),
}));

vi.mock('@/hooks/use-realty', () => ({
  useLeadBoard: () => state.board,
  useLeads: () => state.leads,
  useSiteVisits: () => state.visits,
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

const downloadCsv = vi.fn();
vi.mock('@/lib/csv-export', async () => {
  const actual = await vi.importActual<typeof import('@/lib/csv-export')>('@/lib/csv-export');
  return { ...actual, downloadCsv: (...args: unknown[]) => downloadCsv(...args) };
});

import AnalyticsPage from './page';

const goToTab = (label: string) => fireEvent.click(screen.getByRole('button', { name: label }));

beforeEach(() => {
  state.metrics = q(METRICS);
  state.conversations = q(CONVERSATIONS);
  state.revenue = q(REVENUE);
  state.clients = q(CLIENTS);
  state.autonomy = q(AUTONOMY);
  state.board = q([]);
  state.leads = q({ data: [] });
  state.visits = q({ data: [] });
  role = 'MANAGER';
  vi.clearAllMocks();
});

describe('AnalyticsPage tabs', () => {
  it('opens on Overview with the headline KPIs', () => {
    render(<AnalyticsPage />);
    // "Conversations" is also a tab label, so it is matched loosely here.
    expect(screen.getAllByText('Conversations').length).toBeGreaterThan(1);
    expect(screen.getByText('AI autonomy')).toBeInTheDocument();
    expect(screen.getByText('Net revenue')).toBeInTheDocument();
  });

  it('shows each tab its own section and drops the previous one', () => {
    render(<AnalyticsPage />);
    goToTab('Revenue');
    expect(screen.getByText('Revenue trend')).toBeInTheDocument();
    expect(screen.queryByText('AI vs human resolution')).toBeNull();

    goToTab('Clients');
    expect(screen.getByText('Client acquisition')).toBeInTheDocument();
    expect(screen.queryByText('Revenue trend')).toBeNull();

    goToTab('AI Performance');
    expect(screen.getByText('Confidence distribution')).toBeInTheDocument();

    goToTab('Team');
    expect(screen.getByText('Agent leaderboard')).toBeInTheDocument();

    goToTab('Conversations');
    expect(screen.getByText('Conversation volume')).toBeInTheDocument();
  });

  it('puts the funnel and source ROI side by side on the Leads tab', () => {
    render(<AnalyticsPage />);
    goToTab('Leads');
    expect(screen.getByText('No leads in the pipeline yet')).toBeInTheDocument();
    expect(screen.getByText('No leads to compare yet')).toBeInTheDocument();
  });
});

describe('AnalyticsPage exports', () => {
  it('queues a PDF for the report type matching the active tab', () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    expect(exportReport).toHaveBeenCalledWith(
      expect.objectContaining({ reportType: 'CONVERSATIONS', format: 'PDF' }),
      expect.anything(),
    );

    goToTab('Revenue');
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    expect(exportReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ reportType: 'REVENUE' }),
      expect.anything(),
    );

    goToTab('AI Performance');
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    expect(exportReport).toHaveBeenLastCalledWith(
      expect.objectContaining({ reportType: 'AI_AUTONOMY' }),
      expect.anything(),
    );
  });

  /**
   * The button flips to a "Queued" confirmation and flips back on a timer. The
   * revert is the part that can silently rot: nothing else clears the flag, so
   * a broken timer leaves the control reading "Queued" forever, and an operator
   * who wants a second export has no way to tell whether the first one landed.
   */
  it('confirms the queue, then returns the button to its normal label', () => {
    vi.useFakeTimers();
    try {
      render(<AnalyticsPage />);
      fireEvent.click(screen.getByRole('button', { name: /PDF/ }));

      // The page only shows the confirmation once the mutation reports success.
      act(() => {
        exportReport.mock.calls[0]![1].onSuccess();
      });
      expect(screen.getByRole('button', { name: /Queued/ })).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(2500));
      expect(screen.queryByRole('button', { name: /Queued/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /PDF/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exports the Leads tab as a client report', () => {
    render(<AnalyticsPage />);
    goToTab('Leads');
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    expect(exportReport).toHaveBeenCalledWith(
      expect.objectContaining({ reportType: 'CLIENTS' }),
      expect.anything(),
    );
  });

  it('passes the selected range through to the export', () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    fireEvent.click(screen.getByRole('button', { name: /PDF/ }));
    const sent = exportReport.mock.calls[0][0];
    const days = (new Date(sent.to).getTime() - new Date(sent.from).getTime()) / 86_400_000;
    expect(days).toBeLessThan(8);
  });

  it('offers a VIEWER the CSV but not the server-rendered PDF', () => {
    role = 'VIEWER';
    render(<AnalyticsPage />);
    expect(screen.queryByRole('button', { name: /PDF/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Export/ })).toBeEnabled();
  });

  it('builds a CSV of the on-screen summary, one row per metric', () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));

    expect(downloadCsv).toHaveBeenCalledTimes(1);
    const [filename, csv] = downloadCsv.mock.calls[0] as [string, string];
    expect(filename).toMatch(/^analytics-.*\.csv$/);
    expect(csv).toContain('Metric,Value');
    expect(csv).toContain('Conversations — total');
    expect(csv).toContain('AI autonomy rate');
    // Channel rows are appended per channel, named rather than coded.
    expect(csv).toContain('Channel — WhatsApp conversations');
    expect(csv).toContain('Channel — Instagram conversations');
  });

  it('disables the CSV button and writes nothing until the metrics arrive', () => {
    state.metrics = { ...q(undefined), isLoading: true };
    render(<AnalyticsPage />);
    expect(screen.getByRole('button', { name: /Export/ })).toBeDisabled();
    expect(downloadCsv).not.toHaveBeenCalled();
  });
});

describe('OverviewSection', () => {
  it('summarises conversations, revenue, autonomy and clients', () => {
    render(<AnalyticsPage />);
    expect(screen.getByText('30 open · 380 resolved')).toBeInTheDocument();
    expect(screen.getByText(/40 orders/)).toBeInTheDocument();
    expect(screen.getByText('avg confidence 91.0%')).toBeInTheDocument();
    expect(screen.getByText('25 new · 12 at risk')).toBeInTheDocument();
  });

  it('splits resolution into AI, human and escalated, dropping empty slices', () => {
    render(<AnalyticsPage />);
    expect(screen.getByText('AI handled')).toBeInTheDocument();
    expect(screen.getByText('Human handled')).toBeInTheDocument();
    // "Escalated" labels both a KPI tile and the pie slice legend.
    expect(screen.getAllByText('Escalated').length).toBeGreaterThan(1);
  });

  it('says so when nothing has been handled at all', () => {
    state.metrics = q({
      ...METRICS,
      messages: { inbound: 0, outbound: 0, aiSent: 0, humanSent: 0 },
      conversations: { ...METRICS.conversations, escalated: 0 },
    });
    render(<AnalyticsPage />);
    expect(screen.getByText('No resolution data yet.')).toBeInTheDocument();
  });

  it('retries a failed overview', () => {
    const refetch = vi.fn();
    state.metrics = { ...q(undefined), isError: true, refetch };
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('ConversationsSection', () => {
  it('renders the CSAT to one decimal out of five', () => {
    render(<AnalyticsPage />);
    goToTab('Conversations');
    expect(screen.getByText('4.3/5')).toBeInTheDocument();
  });

  it('falls back to an em dash when CSAT was never collected', () => {
    state.conversations = q({ ...CONVERSATIONS, summary: { ...CONVERSATIONS.summary, csat: undefined } });
    render(<AnalyticsPage />);
    goToTab('Conversations');
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('humanises the intent codes', () => {
    render(<AnalyticsPage />);
    goToTab('Conversations');
    expect(screen.getByText('Price Enquiry')).toBeInTheDocument();
    expect(screen.queryByText('PRICE_ENQUIRY')).toBeNull();
  });

  it('reports empty series without collapsing the whole section', () => {
    state.conversations = q({
      ...CONVERSATIONS,
      timeSeries: [],
      channelBreakdown: [],
      topIntents: [],
    });
    render(<AnalyticsPage />);
    goToTab('Conversations');
    expect(screen.getByText('No conversations in this period')).toBeInTheDocument();
    expect(screen.getByText('No channel data')).toBeInTheDocument();
    expect(screen.getByText('No intents detected')).toBeInTheDocument();
  });
});

describe('RevenueSection', () => {
  it('shows the refunded amount alongside net revenue', () => {
    render(<AnalyticsPage />);
    goToTab('Revenue');
    expect(screen.getByText('₹50,000.00 refunded')).toBeInTheDocument();
  });

  it('lists the top products and the fulfillment mix', () => {
    render(<AnalyticsPage />);
    goToTab('Revenue');
    expect(screen.getByText('Deluxe Package')).toBeInTheDocument();
    expect(screen.getByText('Home Delivery')).toBeInTheDocument();
    expect(screen.getByText('30 orders')).toBeInTheDocument();
  });

  it('reports the empty cases per card', () => {
    state.revenue = q({
      ...REVENUE,
      timeSeries: [],
      topProducts: [],
      fulfillmentBreakdown: {},
    });
    render(<AnalyticsPage />);
    goToTab('Revenue');
    expect(screen.getByText('No revenue in this period')).toBeInTheDocument();
    expect(screen.getByText('No sales data yet')).toBeInTheDocument();
    expect(screen.getByText('No fulfillment data')).toBeInTheDocument();
  });
});

describe('ClientsSection', () => {
  it('reports the high-churn share of all rated clients', () => {
    render(<AnalyticsPage />);
    goToTab('Clients');
    // 12 high out of 300 rated.
    expect(screen.getByText('4.0%')).toBeInTheDocument();
    expect(screen.getByText('12 clients')).toBeInTheDocument();
  });

  it('avoids dividing by zero when no client has a churn rating', () => {
    state.clients = q({ ...CLIENTS, churnRiskBreakdown: { low: 0, medium: 0, high: 0 } });
    render(<AnalyticsPage />);
    goToTab('Clients');
    expect(screen.getByText('0.0%')).toBeInTheDocument();
  });

  it('drops an empty slice from the new-vs-returning split', () => {
    state.clients = q({ ...CLIENTS, summary: { ...CLIENTS.summary, newClients: 0, returning: 0 } });
    render(<AnalyticsPage />);
    goToTab('Clients');
    expect(screen.getByText('No client data')).toBeInTheDocument();
  });
});

describe('AiSection', () => {
  it('renders the autonomy rate, decision count and trend direction', () => {
    render(<AnalyticsPage />);
    goToTab('AI Performance');
    expect(screen.getByText('850')).toBeInTheDocument();
    expect(screen.getByText('+3.4%')).toBeInTheDocument();
  });

  it('signs a falling trend without a plus', () => {
    state.autonomy = q({ ...AUTONOMY, summary: { ...AUTONOMY.summary, trend: -2.5 } });
    render(<AnalyticsPage />);
    goToTab('AI Performance');
    expect(screen.getByText('-2.5%')).toBeInTheDocument();
  });

  it('labels the three confidence routing bands', () => {
    render(<AnalyticsPage />);
    goToTab('AI Performance');
    expect(screen.getByText('< 70 · Escalate')).toBeInTheDocument();
    expect(screen.getByText('70–89 · Draft review')).toBeInTheDocument();
    expect(screen.getByText('≥ 90 · Auto-execute')).toBeInTheDocument();
  });

  it('reports the empty cases per card', () => {
    state.autonomy = q({
      ...AUTONOMY,
      confidenceDistribution: [],
      timeSeries: [],
    });
    render(<AnalyticsPage />);
    goToTab('AI Performance');
    expect(screen.getByText('Not enough data for a trend')).toBeInTheDocument();
  });
});

describe('TeamSection', () => {
  it('ranks agents by conversations resolved, not by API order', () => {
    render(<AnalyticsPage />);
    goToTab('Team');
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('Ravi Kumar')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Nina Shah')).toBeInTheDocument();
  });

  it('computes each agent’s approval rate from their own tasks', () => {
    render(<AnalyticsPage />);
    goToTab('Team');
    const ravi = screen.getByText('Ravi Kumar').closest('tr') as HTMLElement;
    const nina = screen.getByText('Nina Shah').closest('tr') as HTMLElement;
    expect(within(ravi).getByText('40%')).toBeInTheDocument();
    expect(within(nina).getByText('90%')).toBeInTheDocument();
  });

  it('shows 0% rather than NaN for an agent who reviewed nothing', () => {
    state.conversations = q({
      ...CONVERSATIONS,
      agentPerformance: [
        {
          userId: 'u3',
          name: 'Sam Idle',
          resolved: 5,
          avgResolutionTimeMs: 0,
          tasksApproved: 0,
          tasksRejected: 0,
        },
      ],
    });
    render(<AnalyticsPage />);
    goToTab('Team');
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('says so when nobody handled anything in the period', () => {
    state.conversations = q({ ...CONVERSATIONS, agentPerformance: [] });
    render(<AnalyticsPage />);
    goToTab('Team');
    expect(screen.getByText('No agent activity in this period')).toBeInTheDocument();
  });
});
