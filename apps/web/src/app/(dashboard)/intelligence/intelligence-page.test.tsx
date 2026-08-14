/**
 * Micro-Market Intelligence — the cross-tenant analytics page.
 *
 * Two things here are worth locking down. The first is consent: the page reads
 * pooled data from every opted-in brokerage, so the opt-in switch must reflect
 * the stored state and must not be offered to a role that cannot write it. The
 * second is that every panel below the fold is conditional on a metric being
 * present in the priors — a corridor with only cadence data must render the
 * cadence card and silently omit price, objections and seasonality rather than
 * crashing on a missing payload.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CorridorPriorsResponse, IntelligenceAggregate } from '@/lib/intelligence-types';
import type { Role } from '@/lib/feature-types';
import { LanguageProvider } from '@/providers/language-provider';

// Recharts measures its container, which jsdom reports as 0×0 — the real chart
// would render nothing. The page's job is to hand it the right series, so the
// series are asserted through a stub instead.
vi.mock('recharts', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass,
    ComposedChart: ({ data, children }: { data: unknown[]; children?: React.ReactNode }) => (
      <div data-testid="composed-chart" data-points={JSON.stringify(data)}>
        {children}
      </div>
    ),
    Bar: ({ name }: { name: string }) => <div data-testid="bar">{name}</div>,
    Line: ({ name }: { name: string }) => <div data-testid="line">{name}</div>,
    CartesianGrid: () => null,
    XAxis: () => null,
    YAxis: () => null,
    Tooltip: () => null,
    Legend: () => null,
  };
});

function agg(
  metricType: IntelligenceAggregate['metricType'],
  metricValue: unknown,
  corridor = 'Whitefield',
): IntelligenceAggregate {
  return {
    id: `${corridor}-${metricType}`,
    corridor,
    metricType,
    metricValue,
    sampleSize: 120,
    minNThreshold: 30,
    periodStart: '2026-01-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

const CADENCE = {
  total: 200,
  converted: 60,
  conversionRate: 0.3,
  medianDaysToConvert: 14,
  buckets: [
    { label: 'SAME_DAY', converted: 20, share: 0.33 },
    { label: 'WEEK_1', converted: 40, share: 0.67 },
  ],
};

const PRICE = {
  withBudget: 88,
  budgetMinPaise: null,
  budgetMaxPaise: { p25: 6_500_000_00, p50: 8_000_000_00, p75: 1_100_000_000 },
  recommendedBandPaise: { low: 7_000_000_00, high: 9_500_000_00 },
};

const OBJECTIONS = {
  totalObjections: 40,
  topObjections: [
    { label: 'PRICE_TOO_HIGH', count: 25, share: 0.625 },
    { label: 'POSSESSION_DELAY', count: 15, share: 0.375 },
  ],
  byConfig: [{ config: '3BHK', topObjection: 'LOAN_FINANCE', count: 9 }],
};

const SEASONAL = {
  months: [
    { month: '2026-06', leads: 40, converted: 10, conversionRate: 0.25 },
    { month: '2026-07', leads: 55, converted: 18, conversionRate: 0.33 },
  ],
};

const state = {
  corridors: {
    data: { corridors: ['Whitefield', 'Sarjapur'] } as { corridors: string[] } | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  aggregates: {
    data: [
      agg('CADENCE_CONVERSION', CADENCE, 'Whitefield'),
      agg('PRICE_ELASTICITY', PRICE, 'Whitefield'),
      agg('CADENCE_CONVERSION', { ...CADENCE, conversionRate: 0.05 }, 'Sarjapur'),
    ] as IntelligenceAggregate[] | undefined,
    isLoading: false,
  },
  priors: {
    data: {
      corridor: 'Whitefield',
      priors: [
        agg('CADENCE_CONVERSION', CADENCE),
        agg('PRICE_ELASTICITY', PRICE),
        agg('OBJECTION_FREQUENCY', OBJECTIONS),
        agg('SEASONAL_VELOCITY', SEASONAL),
      ],
      promptContext:
        '<micro_market_intelligence>\n- Buyers here convert in about two weeks.\n- Price sensitivity is high above ₹95L.\n</micro_market_intelligence>',
    } as CorridorPriorsResponse | undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  sourceQuality: {
    data: {
      businessId: 'b1',
      totalLeads: 300,
      generatedAt: '2026-08-01T00:00:00.000Z',
      sources: [{ source: 'PORTAL', leads: 180, qualifiedRate: 0.4, visitRate: 0.2, avgQualScore: 62 }],
    } as unknown,
    isLoading: false,
  },
  optIn: { data: { optIn: true }, isLoading: false },
};

/** The corridor the detail panel most recently asked priors for. */
let requestedCorridor: string | null = null;

const setOptIn = vi.fn();
let role: Role = 'MANAGER';

vi.mock('@/hooks/use-realty', () => ({
  useIntelligenceCorridors: () => state.corridors,
  useIntelligenceAggregates: () => state.aggregates,
  useCorridorPriors: (corridor: string) => {
    requestedCorridor = corridor;
    return state.priors;
  },
  useSourceQuality: () => state.sourceQuality,
  useIntelligenceOptIn: () => state.optIn,
  useSetIntelligenceOptIn: () => ({ mutate: setOptIn, isPending: false }),
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

import IntelligencePage from './page';

function renderPage() {
  return render(
    <LanguageProvider>
      <IntelligencePage />
    </LanguageProvider>,
  );
}

const DEFAULT_PRIORS = () => ({
  data: {
    corridor: 'Whitefield',
    priors: [
      agg('CADENCE_CONVERSION', CADENCE),
      agg('PRICE_ELASTICITY', PRICE),
      agg('OBJECTION_FREQUENCY', OBJECTIONS),
      agg('SEASONAL_VELOCITY', SEASONAL),
    ],
    promptContext:
      '<micro_market_intelligence>\n- Buyers here convert in about two weeks.\n- Price sensitivity is high above ₹95L.\n</micro_market_intelligence>',
  } as CorridorPriorsResponse | undefined,
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

beforeEach(() => {
  state.corridors = {
    data: { corridors: ['Whitefield', 'Sarjapur'] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  state.aggregates = {
    data: [
      agg('CADENCE_CONVERSION', CADENCE, 'Whitefield'),
      agg('PRICE_ELASTICITY', PRICE, 'Whitefield'),
      agg('CADENCE_CONVERSION', { ...CADENCE, conversionRate: 0.05 }, 'Sarjapur'),
    ],
    isLoading: false,
  };
  state.priors = DEFAULT_PRIORS();
  state.optIn = { data: { optIn: true }, isLoading: false };
  requestedCorridor = null;
  role = 'MANAGER';
  vi.clearAllMocks();
});

describe('IntelligencePage consent card', () => {
  it('renders the opted-in badge and revokes on toggle', () => {
    renderPage();
    expect(screen.getByText('Contributing anonymized patterns')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    expect(setOptIn).toHaveBeenCalledWith(false);
  });

  it('renders the opted-out badge and grants on toggle', () => {
    state.optIn = { data: { optIn: false }, isLoading: false };
    renderPage();
    expect(screen.getByText('Not contributing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    expect(setOptIn).toHaveBeenCalledWith(true);
  });

  it('offers a VIEWER no switch at all', () => {
    role = 'VIEWER';
    renderPage();
    expect(screen.queryByRole('switch')).toBeNull();
    // The status itself stays visible — read-only, not hidden.
    expect(screen.getByText('Contributing anonymized patterns')).toBeInTheDocument();
  });

  it('disables the switch while the opt-in state loads', () => {
    state.optIn = { data: undefined as unknown as { optIn: boolean }, isLoading: true };
    renderPage();
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});

describe('IntelligencePage top-level states', () => {
  it('shows a loading state while either query is in flight', () => {
    state.aggregates = { data: undefined, isLoading: true };
    renderPage();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('retries the corridor list on error', () => {
    const refetch = vi.fn();
    state.corridors = { data: undefined, isLoading: false, isError: true, refetch };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('explains the empty network when no corridor has cleared the threshold', () => {
    state.corridors = { data: { corridors: [] }, isLoading: false, isError: false, refetch: vi.fn() };
    renderPage();
    expect(screen.getByText('No corridor intelligence yet')).toBeInTheDocument();
  });
});

describe('IntelligencePage corridor selection', () => {
  it('defaults the detail view to the first corridor', () => {
    renderPage();
    expect(requestedCorridor).toBe('Whitefield');
  });

  it('switches corridors from a heatmap card', () => {
    renderPage();
    fireEvent.click(screen.getAllByText('Sarjapur')[0].closest('button') as HTMLElement);
    expect(requestedCorridor).toBe('Sarjapur');
  });

  it('switches corridors from the dropdown', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Select a corridor'), { target: { value: 'Sarjapur' } });
    expect(requestedCorridor).toBe('Sarjapur');
  });

  it('renders a card per corridor with its conversion rate and sample size', () => {
    renderPage();
    const card = screen.getAllByText('Sarjapur')[0].closest('button') as HTMLElement;
    expect(within(card).getByText('5%')).toBeInTheDocument();
    expect(within(card).getByText(/120/)).toBeInTheDocument();
  });

  it('shows a price band on a card only when the corridor has one', () => {
    renderPage();
    const whitefield = screen.getAllByText('Whitefield')[0].closest('button') as HTMLElement;
    const sarjapur = screen.getAllByText('Sarjapur')[0].closest('button') as HTMLElement;
    expect(within(whitefield).getByText('Price band')).toBeInTheDocument();
    expect(within(sarjapur).queryByText('Price band')).toBeNull();
  });
});

describe('IntelligencePage corridor detail', () => {
  it('shows the loading and error states of the priors query', () => {
    state.priors = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    const { unmount } = renderPage();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    unmount();

    const refetch = vi.fn();
    state.priors = { data: undefined, isLoading: false, isError: true, refetch };
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders the KPI row from the cadence and price priors', () => {
    renderPage();
    expect(screen.getAllByText('30%').length).toBeGreaterThan(0);
    expect(screen.getByText('14')).toBeInTheDocument();
  });

  it('falls back to an em dash when a corridor has no cadence or price priors', () => {
    state.priors.data = { corridor: 'Whitefield', priors: [], promptContext: null };
    renderPage();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('extracts the bullet lines out of the prompt context', () => {
    renderPage();
    expect(screen.getByText('Buyers here convert in about two weeks.')).toBeInTheDocument();
    expect(screen.getByText('Price sensitivity is high above ₹95L.')).toBeInTheDocument();
    // The XML wrapper lines are not bullets and must not be displayed.
    expect(screen.queryByText(/micro_market_intelligence/)).toBeNull();
  });

  it('omits the narrative card when the backend sent no prompt context', () => {
    state.priors.data = { ...state.priors.data!, promptContext: null };
    renderPage();
    expect(screen.queryByText('What this means')).toBeNull();
  });

  it('charts the seasonal months as leads bars and a conversions line', () => {
    renderPage();
    const chart = screen.getByTestId('composed-chart');
    const points = JSON.parse(chart.getAttribute('data-points')!);
    expect(points).toHaveLength(2);
    expect(points[0].leads).toBe(40);
    expect(points[1].converted).toBe(18);
    expect(screen.getByTestId('bar')).toHaveTextContent('Lead inflow');
    expect(screen.getByTestId('line')).toHaveTextContent('Conversions');
  });

  it('omits the trend chart when the corridor has no seasonal prior', () => {
    state.priors.data = {
      corridor: 'Whitefield',
      priors: [agg('CADENCE_CONVERSION', CADENCE)],
      promptContext: null,
    };
    renderPage();
    expect(screen.queryByTestId('composed-chart')).toBeNull();
  });

  it('renders the recommended band and the budget quantiles', () => {
    renderPage();
    expect(screen.getByText('Recommended anchor band')).toBeInTheDocument();
    expect(screen.getByText('P25')).toBeInTheDocument();
    expect(screen.getByText('P75')).toBeInTheDocument();
  });

  it('lists the top objections and the popular configurations', () => {
    renderPage();
    expect(screen.getByText('Price too high')).toBeInTheDocument();
    expect(screen.getByText('3BHK')).toBeInTheDocument();
    expect(screen.getByText(/Loan \/ finance · 9/)).toBeInTheDocument();
  });

  it('renders the cadence buckets with their human labels', () => {
    renderPage();
    expect(screen.getByText('Same day')).toBeInTheDocument();
    expect(screen.getByText('Week 1')).toBeInTheDocument();
  });

  it('omits the cadence card when nothing has converted yet', () => {
    state.priors.data = {
      corridor: 'Whitefield',
      priors: [agg('CADENCE_CONVERSION', { ...CADENCE, converted: 0 })],
      promptContext: null,
    };
    renderPage();
    expect(screen.queryByText('Same day')).toBeNull();
  });
});

describe('IntelligencePage source quality', () => {
  it('renders the tenant’s own per-source table', () => {
    renderPage();
    expect(screen.getByText('Portal')).toBeInTheDocument();
    expect(screen.getByText('180')).toBeInTheDocument();
    expect(screen.getByText('62')).toBeInTheDocument();
  });

  it('renders nothing while loading or when the tenant has no sources', () => {
    state.sourceQuality = { data: undefined, isLoading: true };
    const { unmount } = renderPage();
    expect(screen.queryByText('Portal')).toBeNull();
    unmount();

    state.sourceQuality = {
      data: { businessId: 'b1', totalLeads: 0, generatedAt: '', sources: [] },
      isLoading: false,
    };
    renderPage();
    expect(screen.queryByText('Portal')).toBeNull();
  });
});
