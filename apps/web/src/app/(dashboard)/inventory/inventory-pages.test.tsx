/**
 * The inventory list and the project detail screen behind it.
 *
 * Inventory is the only source the AI is allowed to quote from, so the detail
 * header is doing real work rather than decoration: the price range is derived
 * from the units when there are any and only falls back to the project's price
 * band when there are none, availability is a count of AVAILABLE units against
 * the total, and a project without a RERA number has to say so out loud instead
 * of silently omitting the badge. The other thing worth pinning is that each
 * panel — units, assets — fails independently, so a broken assets request still
 * leaves the units table on screen.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtyAsset, RealtyProject, RealtyUnit } from '@/lib/realty-types';

const push = vi.fn();
let routeParams: { projectId?: string } | null = { projectId: 'p1' };

vi.mock('next/navigation', () => ({
  useParams: () => routeParams,
  useRouter: () => ({ push, replace: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

interface QueryStub<T> {
  data?: T;
  isLoading: boolean;
  isError: boolean;
  error?: Error;
}
const idle = <T,>(data: T): QueryStub<T> => ({ data, isLoading: false, isError: false });
const loading = <T,>(): QueryStub<T> => ({ data: undefined, isLoading: true, isError: false });
const failed = <T,>(): QueryStub<T> => ({
  data: undefined,
  isLoading: false,
  isError: true,
  error: new Error('boom'),
});

let projectsQ: QueryStub<RealtyProject[]>;
let projectQ: QueryStub<RealtyProject | null>;
let unitsQ: QueryStub<RealtyUnit[]>;
let assetsQ: QueryStub<RealtyAsset[]>;

const refetchProjects = vi.fn();
const refetchProject = vi.fn();
const refetchUnits = vi.fn();
const refetchAssets = vi.fn();
const projectIdsRequested: Array<string | null> = [];

vi.mock('@/hooks/use-realty', () => ({
  useProjects: () => ({ ...projectsQ, refetch: refetchProjects }),
  useProject: (id: string | null) => {
    projectIdsRequested.push(id);
    return { ...projectQ, refetch: refetchProject };
  },
  useProjectUnits: () => ({ ...unitsQ, refetch: refetchUnits }),
  useProjectAssets: () => ({ ...assetsQ, refetch: refetchAssets }),
}));

vi.mock('@/components/inventory/inventory-card', () => ({
  InventoryCard: ({ project }: { project: RealtyProject }) => (
    <div data-testid="inventory-card">{project.name}</div>
  ),
}));
vi.mock('@/components/inventory/inventory-units-table', () => ({
  InventoryUnitsTable: ({ units }: { units: RealtyUnit[] }) => (
    <div data-testid="units-table">{units.length} units</div>
  ),
}));
vi.mock('@/components/inventory/inventory-assets', () => ({
  InventoryAssets: ({ assets }: { assets: RealtyAsset[] }) => (
    <div data-testid="assets">{assets.length} assets</div>
  ),
}));
vi.mock('@/components/inventory/inventory-visibility-toggle', () => ({
  InventoryVisibilityToggle: () => <div data-testid="visibility-toggle" />,
}));
vi.mock('@/components/inventory/inventory-commission', () => ({
  InventoryCommission: () => <div data-testid="commission" />,
}));

import InventoryPage from './page';
import InventoryDetailPage from './[projectId]/page';

function makeProject(overrides: Partial<RealtyProject> = {}): RealtyProject {
  return {
    id: 'p1',
    businessId: 'b1',
    name: 'Prestige Lakeside Habitat',
    developer: 'Prestige Group',
    locality: 'Whitefield',
    reraNumber: 'PRM/KA/RERA/1251/446',
    possessionDate: '2027-12-01T00:00:00.000Z',
    status: 'UC',
    amenities: [],
    priceBandMinPaise: 9_500_000_00,
    priceBandMaxPaise: 1_450_000_000,
    factSheetDocId: null,
    commissionTerms: {} as RealtyProject['commissionTerms'],
    networkVisibility: 'PRIVATE',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeUnit(overrides: Partial<RealtyUnit> = {}): RealtyUnit {
  return {
    id: 'u1',
    projectId: 'p1',
    availability: 'AVAILABLE',
    allInPricePaise: 12_000_000_00,
    ...overrides,
  } as RealtyUnit;
}

beforeEach(() => {
  vi.clearAllMocks();
  routeParams = { projectId: 'p1' };
  projectsQ = idle([makeProject()]);
  projectQ = idle(makeProject());
  unitsQ = idle([makeUnit()]);
  assetsQ = idle([]);
  projectIdsRequested.length = 0;
});

// ── List ────────────────────────────────────────────────────────────────────

describe('InventoryPage', () => {
  it('renders one card per project', () => {
    projectsQ = idle([makeProject(), makeProject({ id: 'p2', name: 'Sobha Dream Acres' })]);
    render(<InventoryPage />);

    expect(screen.getAllByTestId('inventory-card')).toHaveLength(2);
    expect(screen.getByText('Sobha Dream Acres')).toBeInTheDocument();
  });

  it('explains what a first project needs rather than showing a blank grid', () => {
    projectsQ = idle([]);
    render(<InventoryPage />);

    expect(screen.getByText('No projects yet')).toBeInTheDocument();
    expect(screen.getByText(/RERA number and fact sheet/)).toBeInTheDocument();
  });

  it('treats a missing payload as no projects', () => {
    projectsQ = { data: undefined, isLoading: false, isError: false };
    render(<InventoryPage />);

    expect(screen.getByText('No projects yet')).toBeInTheDocument();
  });

  it('shows the loading state while projects are in flight', () => {
    projectsQ = loading();
    render(<InventoryPage />);

    expect(screen.getByText('Loading inventory…')).toBeInTheDocument();
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
  });

  it('offers a retry when projects fail to load', () => {
    projectsQ = failed();
    render(<InventoryPage />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchProjects).toHaveBeenCalledTimes(1);
  });
});

// ── Detail ──────────────────────────────────────────────────────────────────

describe('InventoryDetailPage shell', () => {
  it('names the project in the breadcrumb once it has loaded', () => {
    render(<InventoryDetailPage />);

    const crumb = screen.getByLabelText('Breadcrumb');
    expect(within(crumb).getByRole('link', { name: 'Inventory' })).toHaveAttribute(
      'href',
      '/inventory',
    );
    expect(within(crumb).getByText('Prestige Lakeside Habitat')).toBeInTheDocument();
  });

  it('holds the breadcrumb open with a placeholder while loading', () => {
    projectQ = loading();
    render(<InventoryDetailPage />);

    expect(within(screen.getByLabelText('Breadcrumb')).getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByText('Loading project…')).toBeInTheDocument();
  });

  it('falls back to a neutral crumb when the project is gone', () => {
    projectQ = idle(null);
    render(<InventoryDetailPage />);

    expect(within(screen.getByLabelText('Breadcrumb')).getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('Project not found')).toBeInTheDocument();
  });

  it('routes back to the list from the not-found state', () => {
    projectQ = idle(null);
    render(<InventoryDetailPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Back to inventory' }));
    expect(push).toHaveBeenCalledWith('/inventory');
  });

  it('passes a null id through rather than requesting "undefined"', () => {
    // The params hook can return null on the very first client render.
    routeParams = null;
    projectQ = loading();
    render(<InventoryDetailPage />);

    expect(projectIdsRequested).toContain(null);
  });

  it('offers a retry when the project request failed', () => {
    projectQ = failed();
    render(<InventoryDetailPage />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchProject).toHaveBeenCalledTimes(1);
  });
});

describe('InventoryDetailPage header', () => {
  it('derives the price range from the units, not the project band', () => {
    unitsQ = idle([
      makeUnit({ allInPricePaise: 12_000_000_00 }),
      makeUnit({ id: 'u2', allInPricePaise: 18_500_000_00 }),
    ]);
    render(<InventoryDetailPage />);

    // ₹1.20Cr–₹1.85Cr, computed from the two units on the ground.
    expect(screen.getByText('₹1.20Cr–₹1.85Cr')).toBeInTheDocument();
  });

  it('falls back to the project price band when no unit is priced', () => {
    unitsQ = idle([]);
    render(<InventoryDetailPage />);

    // No units, so the header shows the band the project was created with.
    expect(screen.getByText('Price range')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('shows a dash when there is neither a unit price nor a band', () => {
    unitsQ = idle([]);
    projectQ = idle(makeProject({ priceBandMinPaise: null, priceBandMaxPaise: null }));
    render(<InventoryDetailPage />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('counts availability against the full unit list', () => {
    unitsQ = idle([
      makeUnit({ availability: 'AVAILABLE' }),
      makeUnit({ id: 'u2', availability: 'SOLD' }),
      makeUnit({ id: 'u3', availability: 'HELD' }),
    ]);
    render(<InventoryDetailPage />);

    expect(screen.getByText('1 / 3 available')).toBeInTheDocument();
    expect(screen.getByText('1 available · 3 total')).toBeInTheDocument();
  });

  it('surfaces the RERA number as a verified badge', () => {
    render(<InventoryDetailPage />);

    expect(screen.getByText(/RERA PRM\/KA\/RERA\/1251\/446/)).toBeInTheDocument();
  });

  it('says RERA is pending rather than omitting the badge', () => {
    projectQ = idle(makeProject({ reraNumber: null }));
    render(<InventoryDetailPage />);

    // An unregistered project must be visibly unregistered — silence here would
    // read as "verified" next to the other badges.
    expect(screen.getByText('RERA pending')).toBeInTheDocument();
  });

  it('distinguishes a private project from one listed on the exchange', () => {
    render(<InventoryDetailPage />);
    expect(screen.getByText('Private')).toBeInTheDocument();

    projectQ = idle(makeProject({ networkVisibility: 'EXCHANGE' }));
    render(<InventoryDetailPage />);
    expect(screen.getByText('On exchange')).toBeInTheDocument();
  });

  it('renders the possession date in IST and omits the developer when unknown', () => {
    projectQ = idle(makeProject({ developer: null }));
    render(<InventoryDetailPage />);

    expect(screen.getByText('1 Dec 2027')).toBeInTheDocument();
    expect(screen.queryByText('Prestige Group')).not.toBeInTheDocument();
  });

  it('shows a dash for a project with no announced possession date', () => {
    projectQ = idle(makeProject({ possessionDate: null }));
    render(<InventoryDetailPage />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('InventoryDetailPage panels', () => {
  it('renders the units table, assets and both broker controls', () => {
    assetsQ = idle([{ id: 'a1' } as RealtyAsset]);
    render(<InventoryDetailPage />);

    expect(screen.getByTestId('units-table')).toHaveTextContent('1 units');
    expect(screen.getByTestId('assets')).toHaveTextContent('1 assets');
    expect(screen.getByTestId('visibility-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('commission')).toBeInTheDocument();
  });

  it('fails the units panel without taking the assets panel down', () => {
    unitsQ = failed();
    render(<InventoryDetailPage />);

    // Each panel owns its own query, so only the units card degrades.
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByTestId('units-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('assets')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchUnits).toHaveBeenCalledTimes(1);
  });

  it('fails the assets panel without taking the units table down', () => {
    assetsQ = failed();
    render(<InventoryDetailPage />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByTestId('assets')).not.toBeInTheDocument();
    expect(screen.getByTestId('units-table')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetchAssets).toHaveBeenCalledTimes(1);
  });

  it('shows a per-panel loading label while each list is in flight', () => {
    unitsQ = loading();
    assetsQ = loading();
    render(<InventoryDetailPage />);

    expect(screen.getByText('Loading units…')).toBeInTheDocument();
    expect(screen.getByText('Loading assets…')).toBeInTheDocument();
  });

  it('treats a missing assets payload as an empty list', () => {
    assetsQ = { data: undefined, isLoading: false, isError: false };
    render(<InventoryDetailPage />);

    expect(screen.getByTestId('assets')).toHaveTextContent('0 assets');
  });
});
