/**
 * The formatter callbacks the analytics charts hand to Recharts.
 *
 * business-sections.test.tsx stubs Recharts to render nothing, which is right
 * for asserting the tables and lists beside the charts — but it means the axis
 * and tooltip formatters are never called. They are not decoration: they are
 * the last conversion before a number reaches a business owner's eyes, and
 * every one of them is doing real work — paise to rupees, a ratio to a percent,
 * a UTC date to IST. A wrong one shows the right chart shape with the wrong
 * money on the axis, which is worse than a chart that fails to render.
 *
 * So this file stubs Recharts differently: instead of dropping the chart
 * elements, it records the props they were given. The tests then call the
 * formatters directly with the values Recharts would pass them.
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DateRange } from '@/components/analytics/date-range-picker';

type Props = Record<string, unknown>;

/** Props of every chart element rendered during the current test. */
const captured: { xAxis: Props[]; yAxis: Props[]; tooltip: Props[] } = {
  xAxis: [],
  yAxis: [],
  tooltip: [],
};

vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nil = () => null;
  const record = (bucket: 'xAxis' | 'yAxis' | 'tooltip') => (props: Props) => {
    captured[bucket].push(props);
    return null;
  };
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
    Legend: Nil,
    XAxis: record('xAxis'),
    YAxis: record('yAxis'),
    Tooltip: record('tooltip'),
  };
});

const revenueQ = { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() };
const conversationsQ = { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() };
const aiQ = { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() };

vi.mock('@/hooks/use-analytics', () => ({
  useRevenueReportFull: () => revenueQ,
  useConversationReportFull: () => conversationsQ,
  useClientReport: () => conversationsQ,
  useAutonomyReport: () => aiQ,
}));

import { RevenueSection } from './revenue-section';
import { ConversationsSection } from './conversations-section';
import { AiSection } from './ai-section';

const RANGE = { from: '2026-07-01', to: '2026-07-31' } as unknown as DateRange;

/** The single formatter of a given kind, asserted to be the only one. */
function only<T>(list: Props[], key: string): T {
  const fns = list.map((p) => p[key]).filter(Boolean);
  expect(fns.length).toBeGreaterThan(0);
  return fns[0] as T;
}

beforeEach(() => {
  captured.xAxis = [];
  captured.yAxis = [];
  captured.tooltip = [];
  revenueQ.data = {
    summary: {
      totalRevenue: 12_50_000,
      netRevenue: 11_00_000,
      totalRefunds: 1_50_000,
      totalOrders: 42,
      avgOrderValue: 29_761,
    },
    timeSeries: [{ date: '2026-07-01', revenue: 50_000, orders: 2 }],
    topProducts: [],
    fulfillmentBreakdown: {},
  };
  conversationsQ.data = {
    summary: { total: 318, avgResolutionTimeMs: 3_600_000, avgFirstResponseTimeMs: 120_000, csat: 4.4 },
    timeSeries: [{ date: '2026-07-01', created: 12, resolved: 10, escalated: 1 }],
    channelBreakdown: [],
    topIntents: [],
    agentPerformance: [],
    newClients: [],
  };
  aiQ.data = {
    summary: { autonomyRate: 0.82, totalDecisions: 900, trend: 4.2 },
    timeSeries: [{ date: '2026-07-01', autonomyRate: 0.82 }],
    confidenceDistribution: [],
    topEscalationReasons: [],
    intentBreakdown: [],
  };
});

describe('RevenueSection chart formatters', () => {
  it('labels the money axis in compact rupees, not raw paise', () => {
    render(<RevenueSection range={RANGE} />);
    const tick = only<(v: number) => string>(captured.yAxis, 'tickFormatter');
    // 12,50,000 paise is ₹12,500, which the compact formatter renders as
    // ₹12.5K. An axis reading "1250000" would be off by a factor of 100.
    expect(tick(12_50_000)).toBe('₹12.5K');
  });

  it('converts an axis value handed over as a string', () => {
    // Recharts types its tick values loosely and passes through whatever is in
    // the data; the formatter coerces with Number() for exactly that reason.
    render(<RevenueSection range={RANGE} />);
    const tick = only<(v: unknown) => string>(captured.yAxis, 'tickFormatter');
    expect(tick('1250000')).toBe(tick(12_50_000));
  });

  it('formats the order count as a count and the revenue as money', () => {
    render(<RevenueSection range={RANGE} />);
    const fmt = only<(v: number, n: string) => [string, string]>(captured.tooltip, 'formatter');

    // The same chart carries both series; only the name distinguishes them, so
    // a mix-up renders an order count as a rupee figure.
    const [orders, ordersName] = fmt(42, 'Orders');
    expect(orders).toBe('42');
    expect(ordersName).toBe('Orders');

    const [revenue] = fmt(12_50_000, 'Revenue');
    expect(revenue).toBe('₹12.5K');
  });

  it('renders the tooltip date in IST', () => {
    render(<RevenueSection range={RANGE} />);
    const label = only<(l: unknown) => string>(captured.tooltip, 'labelFormatter');
    expect(label('2026-07-01')).toMatch(/Jul/);
  });

  it('shortens the date axis rather than printing a full timestamp', () => {
    render(<RevenueSection range={RANGE} />);
    const tick = only<(v: string) => string>(captured.xAxis, 'tickFormatter');
    const out = tick('2026-07-01');
    expect(out.length).toBeLessThan('2026-07-01'.length + 4);
    expect(out).not.toContain('T');
  });
});

describe('ConversationsSection chart formatters', () => {
  it('renders the tooltip date in IST', () => {
    render(<ConversationsSection range={RANGE} />);
    const label = only<(l: unknown) => string>(captured.tooltip, 'labelFormatter');
    expect(label('2026-07-01')).toMatch(/Jul/);
  });

  it('shortens the date axis', () => {
    render(<ConversationsSection range={RANGE} />);
    const tick = only<(v: string) => string>(captured.xAxis, 'tickFormatter');
    expect(tick('2026-07-01')).not.toContain('2026-07-01');
  });
});

describe('AiSection chart formatters', () => {
  it('suffixes the autonomy axis with a percent sign', () => {
    render(<AiSection range={RANGE} />);
    const tick = only<(v: number) => string>(captured.yAxis, 'tickFormatter');
    expect(tick(80)).toBe('80%');
    expect(tick(0)).toBe('0%');
  });

  it('gives the tooltip one decimal place and names the series', () => {
    render(<AiSection range={RANGE} />);
    const fmt = only<(v: number) => [string, string]>(captured.tooltip, 'formatter');
    // Deliberately off the .x5 boundary: toFixed rounds the stored double, and
    // 82.35 is held as slightly less than 82.35, so it gives "82.3". That is
    // JS, not this formatter — pinning it here would test the wrong thing.
    expect(fmt(82.37)).toEqual(['82.4%', 'Autonomy']);
    // A whole number still shows its decimal, so the axis does not jitter
    // between "82%" and "82.4%" as the data changes.
    expect(fmt(82)).toEqual(['82.0%', 'Autonomy']);
  });

  it('renders the tooltip date in IST', () => {
    render(<AiSection range={RANGE} />);
    const label = only<(l: unknown) => string>(captured.tooltip, 'labelFormatter');
    expect(label('2026-07-01')).toMatch(/Jul/);
  });
});
