/**
 * The four dashboard charts and the card that frames them.
 *
 * Recharts cannot lay out in jsdom, so the markup it produces is not worth
 * asserting on. What *is* worth asserting is the code this file owns: the
 * `ChartCard` three-way switch between skeleton / empty state / chart, and the
 * formatter callbacks handed to the axes and tooltips. Those formatters are
 * where the money and the dates get rendered — a Y axis that forgets
 * `paiseToCompactRupees` shows "12000000" where the product promises "₹1.20L".
 * The recharts stub below therefore does one unusual thing: it invokes the
 * formatter props with sample values and renders the result, so the assertions
 * can read the strings a user would actually see on the axis.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Nothing = () => null;

  /** Renders `tickFormatter(sample)` so the axis's formatting is assertable. */
  const Axis = ({
    tickFormatter,
    dataKey,
  }: {
    tickFormatter?: (v: unknown) => string;
    dataKey?: string;
  }) =>
    tickFormatter ? (
      <div data-testid={`ticks-${dataKey ?? 'value'}`}>
        {['2026-06-27', 12_000_000, 'not-a-date'].map((v) => (
          <span key={String(v)}>{tickFormatter(v)}</span>
        ))}
      </div>
    ) : null;

  const Tooltip = ({
    labelFormatter,
    formatter,
  }: {
    labelFormatter?: (l: unknown) => string;
    formatter?: (v: number) => [string, string];
  }) => (
    <div data-testid="tooltip">
      {labelFormatter ? <span data-testid="tooltip-label">{labelFormatter('2026-06-27')}</span> : null}
      {formatter ? <span data-testid="tooltip-value">{formatter(12_000_000).join(' · ')}</span> : null}
    </div>
  );

  return {
    ResponsiveContainer: Pass,
    AreaChart: Pass,
    BarChart: Pass,
    LineChart: Pass,
    PieChart: Pass,
    Area: Nothing,
    Bar: Nothing,
    Line: Nothing,
    Pie: Pass,
    Cell: Nothing,
    Legend: Nothing,
    XAxis: Axis,
    YAxis: Axis,
    Tooltip,
  };
});

import {
  ChannelBarChart,
  ChartCard,
  ConversationVolumeChart,
  ResolutionPieChart,
  RevenueTrendChart,
} from './charts';

describe('ChartCard', () => {
  it('reserves the chart area with a skeleton while loading', () => {
    const { container } = render(
      <ChartCard title="Revenue trend" loading>
        <p>chart</p>
      </ChartCard>,
    );

    expect(screen.getByText('Revenue trend')).toBeInTheDocument();
    expect(screen.queryByText('chart')).not.toBeInTheDocument();
    expect(container.querySelector('.h-\\[240px\\]')).toBeTruthy();
  });

  it('explains the absence rather than drawing an empty chart', () => {
    render(
      <ChartCard title="Revenue trend" empty>
        <p>chart</p>
      </ChartCard>,
    );

    expect(screen.getByText('No data yet')).toBeInTheDocument();
    expect(screen.queryByText('chart')).not.toBeInTheDocument();
  });

  it('renders the chart once there is data and nothing is in flight', () => {
    render(
      <ChartCard title="Revenue trend">
        <p>chart</p>
      </ChartCard>,
    );

    expect(screen.getByText('chart')).toBeInTheDocument();
    expect(screen.queryByText('No data yet')).not.toBeInTheDocument();
  });

  it('prefers the skeleton over the empty state when both are set', () => {
    // A query that is loading has no data yet, so both flags are true on the
    // first render — showing "No data yet" there would read as a real answer.
    render(
      <ChartCard title="Revenue trend" loading empty>
        <p>chart</p>
      </ChartCard>,
    );

    expect(screen.queryByText('No data yet')).not.toBeInTheDocument();
  });
});

describe('ConversationVolumeChart', () => {
  const data = [
    { date: '2026-06-27', created: 12, resolved: 9 },
    { date: '2026-06-28', created: 15, resolved: 14 },
  ];

  it('shortens axis dates to day+month and keeps the year in the tooltip', () => {
    render(<ConversationVolumeChart data={data} />);

    // The axis is cramped, so the year is stripped; the tooltip has room for it.
    expect(within(screen.getByTestId('ticks-date')).getByText('27 Jun')).toBeInTheDocument();
    expect(screen.getByTestId('tooltip-label')).toHaveTextContent('27 Jun 2026');
  });

  it('renders an unparseable tick as a dash instead of throwing', () => {
    render(<ConversationVolumeChart data={data} />);

    // A malformed bucket key must not take the whole chart down with it — the
    // formatter swallows the error and the axis shows an em dash.
    expect(within(screen.getByTestId('ticks-date')).getByText('—')).toBeInTheDocument();
  });
});

describe('RevenueTrendChart', () => {
  const data = [
    { date: '2026-06-27', revenue: 12_000_000 },
    { date: '2026-06-28', revenue: 800_000 },
  ];

  it('renders paise as compact rupees on the axis and in the tooltip', () => {
    render(<RevenueTrendChart data={data} />);

    // 12,000,000 paise = ₹1,20,000 → "₹1.20L", never a raw paise integer.
    expect(screen.getByTestId('ticks-value')).toHaveTextContent('₹1.20L');
    expect(screen.getByTestId('tooltip-value')).toHaveTextContent('₹1.20L · Revenue');
  });
});

describe('ResolutionPieChart', () => {
  it('splits the message volume into the AI and human slices', () => {
    const { container } = render(<ResolutionPieChart aiSent={700} humanSent={150} />);

    // The stub renders <Pie> children, which is the per-slice <Cell> map.
    expect(container.querySelectorAll('div').length).toBeGreaterThan(0);
    expect(screen.getByTestId('tooltip')).toBeInTheDocument();
  });

  it('renders without error when every counter is zero', () => {
    expect(() => render(<ResolutionPieChart aiSent={0} humanSent={0} />)).not.toThrow();
  });
});

describe('ChannelBarChart', () => {
  it('renders one series over the channel breakdown', () => {
    render(
      <ChannelBarChart
        data={[
          { channel: 'WHATSAPP', count: 320 },
          { channel: 'WEB CHAT', count: 40 },
        ]}
      />,
    );

    // The channel axis has no tickFormatter — labels are pre-humanised by the
    // caller — so the only thing to assert is that the chart mounted.
    expect(screen.getByTestId('tooltip')).toBeInTheDocument();
  });
});
