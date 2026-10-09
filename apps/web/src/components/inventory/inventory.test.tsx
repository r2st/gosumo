/**
 * The five inventory components of the broker console.
 *
 * Two of them carry rules that matter beyond the pixels. The units table sorts
 * by the broker's working order — available first, sold last, cheapest first
 * within a band — and flags any unit whose verified-at falls outside the 24h
 * freshness window the AI relies on, because quoting a stale unit means
 * promising a buyer a flat that is already gone. And the commission panel is
 * broker-only: it renders free-form JSON generically, so the tests pin the
 * paise-vs-percent formatting that decides whether "2" reads as ₹0.02 or 2%.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CommissionTerms,
  RealtyAsset,
  RealtyAssetType,
  RealtyProject,
  RealtyUnit,
} from '@/lib/realty-types';
import type { Role } from '@/lib/feature-types';

const NOW = new Date('2026-08-14T06:00:00.000Z');

function makeProject(overrides: Partial<RealtyProject> = {}): RealtyProject {
  return {
    id: 'p1',
    businessId: 'b1',
    name: 'Prestige Lakeside',
    developer: 'Prestige Group',
    locality: 'Whitefield',
    reraNumber: 'PRM/KA/RERA/1251',
    possessionDate: null,
    status: 'UNDER_CONSTRUCTION',
    amenities: [],
    priceBandMinPaise: 8_50_00_000,
    priceBandMaxPaise: 1_20_00_00_000,
    factSheetDocId: null,
    commissionTerms: {},
    networkVisibility: 'PRIVATE',
    isActive: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-14T05:00:00.000Z',
    ...overrides,
  };
}

function makeUnit(overrides: Partial<RealtyUnit> = {}): RealtyUnit {
  return {
    id: 'u1',
    businessId: 'b1',
    projectId: 'p1',
    config: '3BHK',
    carpetSqft: 1250,
    builtupSqft: 1680,
    floor: 12,
    facing: 'East',
    basePricePaise: 1_00_00_00_000,
    allInPricePaise: 1_15_00_00_000,
    availability: 'AVAILABLE',
    verifiedAt: '2026-08-14T05:00:00.000Z',
    isFresh: true,
    networkVisibility: 'PRIVATE',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-08-14T05:00:00.000Z',
    ...overrides,
  };
}

function makeAsset(overrides: Partial<RealtyAsset> = {}): RealtyAsset {
  return {
    id: 'a1',
    projectId: 'p1',
    type: 'BROCHURE',
    url: 'https://cdn/brochure.pdf',
    waMediaId: null,
    title: null,
    version: 1,
    isCurrent: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

const state = {
  units: { data: [makeUnit()] as RealtyUnit[] | undefined, isLoading: false },
};
const mutations = { updateProject: vi.fn() };
const flags = { updatePending: false };
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
let role: Role = 'STAFF';

vi.mock('@/hooks/use-realty', () => ({
  useProjectUnits: () => state.units,
  useUpdateProject: () => ({ mutate: mutations.updateProject, isPending: flags.updatePending }),
}));

vi.mock('@/providers/toast-provider', () => ({ useToast: () => toast }));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

import { InventoryCard } from './inventory-card';
import { InventoryUnitsTable } from './inventory-units-table';
import { InventoryAssets } from './inventory-assets';
import { InventoryCommission } from './inventory-commission';
import { InventoryVisibilityToggle } from './inventory-visibility-toggle';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  state.units = { data: [makeUnit()], isLoading: false };
  flags.updatePending = false;
  role = 'STAFF';
  vi.clearAllMocks();
});

// The freshness pills are computed against "now", so the clock is pinned for
// the whole file — put it back afterwards rather than leaving it frozen.
afterEach(() => {
  vi.useRealTimers();
});

// ── InventoryCard ────────────────────────────────────────────────────────────

describe('InventoryCard', () => {
  it('links to the project and names it with its developer and locality', () => {
    render(<InventoryCard project={makeProject()} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/inventory/p1');
    expect(screen.getByText('Prestige Lakeside')).toBeInTheDocument();
    expect(screen.getByText('Prestige Group')).toBeInTheDocument();
    expect(screen.getByText('Whitefield')).toBeInTheDocument();
  });

  it('omits the developer line for a project recorded without one', () => {
    render(<InventoryCard project={makeProject({ developer: null })} />);
    expect(screen.queryByText('Prestige Group')).not.toBeInTheDocument();
  });

  it('counts only the available units', () => {
    state.units = {
      data: [
        makeUnit({ id: 'u1', availability: 'AVAILABLE' }),
        makeUnit({ id: 'u2', availability: 'SOLD' }),
        makeUnit({ id: 'u3', availability: 'AVAILABLE' }),
      ],
      isLoading: false,
    };
    render(<InventoryCard project={makeProject()} />);
    expect(screen.getByText('2 available')).toBeInTheDocument();
  });

  it('holds the count back with an ellipsis while the units load', () => {
    state.units = { data: undefined, isLoading: true };
    render(<InventoryCard project={makeProject()} />);
    expect(screen.getByText('…')).toBeInTheDocument();
  });

  it('shows the RERA number, and flags a project that has none', () => {
    render(<InventoryCard project={makeProject()} />);
    expect(screen.getByText(/RERA PRM\/KA\/RERA\/1251/)).toBeInTheDocument();

    render(<InventoryCard project={makeProject({ reraNumber: null })} />);
    expect(screen.getByText('RERA pending')).toBeInTheDocument();
  });

  it('badges a project that is listed on the exchange', () => {
    render(<InventoryCard project={makeProject()} />);
    expect(screen.queryByText('Exchange')).not.toBeInTheDocument();

    render(<InventoryCard project={makeProject({ networkVisibility: 'EXCHANGE' })} />);
    expect(screen.getByText('Exchange')).toBeInTheDocument();
  });

  it('reads freshness from the most recently verified unit', () => {
    state.units = {
      data: [makeUnit({ verifiedAt: '2026-08-14T05:30:00.000Z' })],
      isLoading: false,
    };
    const { container } = render(<InventoryCard project={makeProject()} />);
    // Within the 24h window, so the pill reads fresh rather than stale.
    expect(container.querySelector('.bg-rose-500\\/15')).toBeNull();
    expect(container.querySelector('.bg-sky-500\\/15')).not.toBeNull();
  });

  it('falls back to the project timestamp when no unit was ever verified', () => {
    state.units = { data: [makeUnit({ verifiedAt: null })], isLoading: false };
    const { container } = render(
      <InventoryCard project={makeProject({ updatedAt: '2026-08-10T05:00:00.000Z' })} />,
    );
    expect(container.querySelector('.bg-rose-500\\/15')).not.toBeNull();
  });
});

// ── InventoryUnitsTable ──────────────────────────────────────────────────────

describe('InventoryUnitsTable', () => {
  const configColumn = () =>
    screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);

  it('invites the broker to add units when there are none', () => {
    render(<InventoryUnitsTable units={[]} />);
    expect(screen.getByText('No units yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a unit across all eight columns', () => {
    render(<InventoryUnitsTable units={[makeUnit()]} />);
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('3BHK');
    expect(cells[1]).toHaveTextContent('1250 / 1680');
    expect(cells[2]).toHaveTextContent('12');
    expect(cells[3]).toHaveTextContent('East');
    expect(cells[5]).toHaveTextContent('₹1,15,00,000.00');
  });

  it('sorts available units first and sold ones last', () => {
    render(
      <InventoryUnitsTable
        units={[
          makeUnit({ id: 'u1', config: 'SOLD-UNIT', availability: 'SOLD' }),
          makeUnit({ id: 'u2', config: 'UNVERIFIED-UNIT', availability: 'UNVERIFIED' }),
          makeUnit({ id: 'u3', config: 'AVAILABLE-UNIT', availability: 'AVAILABLE' }),
          makeUnit({ id: 'u4', config: 'HELD-UNIT', availability: 'HELD' }),
        ]}
      />,
    );
    expect(configColumn()).toEqual([
      'AVAILABLE-UNIT',
      'HELD-UNIT',
      'UNVERIFIED-UNIT',
      'SOLD-UNIT',
    ]);
  });

  it('breaks a tie within one availability band by price, cheapest first', () => {
    render(
      <InventoryUnitsTable
        units={[
          makeUnit({ id: 'u1', config: 'DEARER', allInPricePaise: 2_00_00_00_000 }),
          makeUnit({ id: 'u2', config: 'CHEAPER', allInPricePaise: 1_00_00_00_000 }),
        ]}
      />,
    );
    expect(configColumn()).toEqual(['CHEAPER', 'DEARER']);
  });

  it('dashes the numeric cells a unit has no figures for', () => {
    render(
      <InventoryUnitsTable
        units={[
          makeUnit({
            carpetSqft: null,
            builtupSqft: null,
            floor: null,
            facing: null,
            basePricePaise: null,
          }),
        ]}
      />,
    );
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('—');
    expect(cells[2]).toHaveTextContent('—');
    expect(cells[3]).toHaveTextContent('—');
    expect(cells[4]).toHaveTextContent('—');
  });

  it('shows a half-known area as a figure over a dash', () => {
    render(<InventoryUnitsTable units={[makeUnit({ builtupSqft: null })]} />);
    expect(screen.getByText(/1250/)).toBeInTheDocument();
    expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[1]).toHaveTextContent(
      '1250 / —',
    );
  });

  it('flags a unit last verified outside the 24-hour window', () => {
    render(<InventoryUnitsTable units={[makeUnit({ verifiedAt: '2026-08-12T05:00:00.000Z' })]} />);
    const verified = within(screen.getAllByRole('row')[1]).getAllByRole('cell')[7];
    expect(verified.querySelector('.text-rose-400')).not.toBeNull();
  });

  it('leaves a unit verified inside the window unflagged', () => {
    render(<InventoryUnitsTable units={[makeUnit({ verifiedAt: '2026-08-14T04:00:00.000Z' })]} />);
    const verified = within(screen.getAllByRole('row')[1]).getAllByRole('cell')[7];
    expect(verified.querySelector('.text-rose-400')).toBeNull();
    expect(verified.querySelector('.text-sky-400')).not.toBeNull();
  });

  it('says so when a unit has never been verified at all', () => {
    render(<InventoryUnitsTable units={[makeUnit({ verifiedAt: null })]} />);
    expect(screen.getByText('Never verified')).toBeInTheDocument();
  });
});

// ── InventoryAssets ──────────────────────────────────────────────────────────

describe('InventoryAssets', () => {
  it('invites an upload when there is nothing published', () => {
    render(<InventoryAssets assets={[]} />);
    expect(screen.getByText('No assets uploaded')).toBeInTheDocument();
  });

  it('titles an untitled asset by its type', () => {
    render(<InventoryAssets assets={[makeAsset()]} />);
    expect(screen.getAllByText('Brochure')[0]).toBeInTheDocument();
  });

  it('prefers the asset’s own title when it has one', () => {
    render(<InventoryAssets assets={[makeAsset({ title: 'Tower B floor plate' })]} />);
    expect(screen.getByText('Tower B floor plate')).toBeInTheDocument();
  });

  it('shows the version and marks superseded ones', () => {
    render(<InventoryAssets assets={[makeAsset({ version: 3, isCurrent: false })]} />);
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('Superseded')).toBeInTheDocument();
  });

  it('puts current versions above superseded ones, newest first within each', () => {
    render(
      <InventoryAssets
        assets={[
          makeAsset({ id: 'a1', title: 'old-superseded', isCurrent: false, createdAt: '2026-07-01T00:00:00.000Z' }),
          makeAsset({ id: 'a2', title: 'new-superseded', isCurrent: false, createdAt: '2026-08-01T00:00:00.000Z' }),
          makeAsset({ id: 'a3', title: 'current', isCurrent: true, createdAt: '2026-06-01T00:00:00.000Z' }),
        ]}
      />,
    );
    const titles = screen.getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent);
    expect(titles).toEqual(['current', 'new-superseded', 'old-superseded']);
  });

  it('opens an asset in a new tab, and offers no link when there is no URL', () => {
    render(<InventoryAssets assets={[makeAsset()]} />);
    const link = screen.getByRole('link', { name: /open/i });
    expect(link).toHaveAttribute('href', 'https://cdn/brochure.pdf');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    render(<InventoryAssets assets={[makeAsset({ url: null })]} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it.each(['BROCHURE', 'FLOORPLAN', 'PRICESHEET', 'VIDEO', 'PIN'] as RealtyAssetType[])(
    'renders a %s asset with its own icon',
    (type) => {
      const { container } = render(<InventoryAssets assets={[makeAsset({ type })]} />);
      expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
    },
  );
});

// ── InventoryCommission ──────────────────────────────────────────────────────

describe('InventoryCommission', () => {
  it('says nothing is recorded for an empty terms object', () => {
    render(<InventoryCommission terms={{}} />);
    expect(screen.getByText(/no commission terms recorded/i)).toBeInTheDocument();
  });

  it('survives terms that are missing entirely', () => {
    render(<InventoryCommission terms={undefined as unknown as CommissionTerms} />);
    expect(screen.getByText(/no commission terms recorded/i)).toBeInTheDocument();
  });

  it('renders a percentage key as a percentage', () => {
    render(<InventoryCommission terms={{ pct: 2 }} />);
    expect(screen.getByText('Pct')).toBeInTheDocument();
    expect(screen.getByText('2%')).toBeInTheDocument();
  });

  it('renders a paise key as rupees and drops the suffix from its label', () => {
    render(<InventoryCommission terms={{ flatPaise: 2_50_00_000 }} />);
    expect(screen.getByText('Flat')).toBeInTheDocument();
    expect(screen.getByText('₹2,50,000.00')).toBeInTheDocument();
  });

  it('leaves a plain number alone', () => {
    render(<InventoryCommission terms={{ slabMonths: 6 } as unknown as CommissionTerms} />);
    expect(screen.getByText('Slab Months')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('titles a snake_case key', () => {
    render(<InventoryCommission terms={{ payout_terms: 'On booking' } as unknown as CommissionTerms} />);
    expect(screen.getByText('Payout terms')).toBeInTheDocument();
  });

  it('renders booleans as Yes and No', () => {
    render(
      <InventoryCommission
        terms={{ gstIncluded: true, tdsDeducted: false } as unknown as CommissionTerms}
      />,
    );
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('joins a list of scalars and stringifies anything richer', () => {
    render(
      <InventoryCommission
        terms={{
          milestones: ['Booking', 'Registration'],
          schedule: [{ at: 'booking', pct: 50 }],
        } as unknown as CommissionTerms}
      />,
    );
    expect(screen.getByText('Booking, Registration')).toBeInTheDocument();
    expect(screen.getByText('[{"at":"booking","pct":50}]')).toBeInTheDocument();
  });

  it('drops keys that were recorded blank rather than printing an empty row', () => {
    render(
      <InventoryCommission
        terms={{ pct: 2, payoutTerms: '', notes: null } as unknown as CommissionTerms}
      />,
    );
    expect(screen.getAllByRole('term')).toHaveLength(1);
  });

  it('always carries the broker-only warning', () => {
    render(<InventoryCommission terms={{ pct: 2 }} />);
    expect(screen.getByText(/never shown to buyers or quoted by the AI/i)).toBeInTheDocument();
  });
});

// ── InventoryVisibilityToggle ────────────────────────────────────────────────

describe('InventoryVisibilityToggle', () => {
  it('describes a private project', () => {
    render(<InventoryVisibilityToggle project={makeProject()} />);
    expect(screen.getByText('Private')).toBeInTheDocument();
    expect(screen.getByText(/only your team can see and quote/i)).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('describes a project already on the exchange', () => {
    render(<InventoryVisibilityToggle project={makeProject({ networkVisibility: 'EXCHANGE' })} />);
    expect(screen.getByText('On the exchange')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('lists a private project on the exchange and says so', () => {
    render(<InventoryVisibilityToggle project={makeProject()} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(mutations.updateProject.mock.calls[0][0]).toEqual({
      id: 'p1',
      networkVisibility: 'EXCHANGE',
    });

    mutations.updateProject.mock.calls[0][1].onSuccess();
    expect(toast.success).toHaveBeenCalledWith('Now visible on the co-broking exchange.', {
      title: 'Visibility updated',
    });
  });

  it('pulls a listed project back to private and says so', () => {
    render(<InventoryVisibilityToggle project={makeProject({ networkVisibility: 'EXCHANGE' })} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(mutations.updateProject.mock.calls[0][0]).toEqual({
      id: 'p1',
      networkVisibility: 'PRIVATE',
    });

    mutations.updateProject.mock.calls[0][1].onSuccess();
    expect(toast.success).toHaveBeenCalledWith('Now private to your brokerage.', {
      title: 'Visibility updated',
    });
  });

  it('warns rather than leaving the switch lying about the state', () => {
    render(<InventoryVisibilityToggle project={makeProject()} />);
    fireEvent.click(screen.getByRole('switch'));
    mutations.updateProject.mock.calls[0][1].onError();
    expect(toast.error).toHaveBeenCalledWith('Could not change visibility. Please try again.');
  });

  it('goes inert while the change is in flight', () => {
    flags.updatePending = true;
    render(<InventoryVisibilityToggle project={makeProject()} />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('shows a VIEWER the state without the control', () => {
    role = 'VIEWER';
    render(<InventoryVisibilityToggle project={makeProject({ networkVisibility: 'EXCHANGE' })} />);
    expect(screen.getByText('On the exchange')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
