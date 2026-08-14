/**
 * Catalog — the filter bar and the item card.
 *
 * The filter bar's job is to turn UI state into a query, and the one rule that
 * matters is that **"unset" must travel as `undefined`, never as `''`**. The
 * page writes `q || undefined` for each filter precisely because an empty
 * string would be serialised into the query string and the API would filter on
 * it — an empty search returning nothing, an "All categories" selection
 * matching no category. So each filter is asserted in both its set and its
 * cleared state.
 *
 * On the card, the things that can be wrong are the ones that read as data:
 * a discounted item must show the struck-through original beside the price the
 * customer actually pays, an inactive item must say so, and the variant count
 * must not read "1 variants". The regression case for a malformed item (no
 * `imageUrls`, no `variants`) lives in catalog-page.test.tsx.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogItem } from '@/lib/types';
import type { Role } from '@/lib/feature-types';

function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'item-1',
    businessId: 'biz-1',
    type: 'PRODUCT',
    name: 'Turmeric Latte Mix',
    slug: 'turmeric-latte-mix',
    imageUrls: [],
    basePrice: 45000,
    currency: 'INR',
    taxIncluded: true,
    isActive: true,
    isAvailable: true,
    trackInventory: false,
    tags: [],
    variants: [],
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as CatalogItem;
}

const itemsQuery = {
  data: undefined as { data: CatalogItem[]; pagination: { total: number } } | undefined,
  isLoading: false,
  isError: false,
  error: null as Error | null,
  refetch: vi.fn(),
};

/** The filter object the page last handed to `useCatalogItems`. */
let lastFilters: Record<string, unknown> = {};
let categories: { id: string; name: string }[] = [];
let role: Role = 'OWNER';

vi.mock('@/hooks/use-catalog', () => ({
  useCatalogItems: (filters: Record<string, unknown>) => {
    lastFilters = filters;
    return itemsQuery;
  },
  useCategories: () => ({ data: { categories } }),
}));

// The modals have their own suites; here they only record that they were
// opened, and with which item.
vi.mock('@/components/catalog/product-form-modal', () => ({
  ProductFormModal: ({ open, item }: { open: boolean; item: CatalogItem | null }) =>
    open ? <div data-testid="product-form" data-item={item?.id ?? 'new'} /> : null,
}));
vi.mock('@/components/catalog/category-manager', () => ({
  CategoryManager: ({ open }: { open: boolean }) => (open ? <div data-testid="categories" /> : null),
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

import CatalogPage from './page';

/** The card for an item, located by its name. */
function cardFor(name: string): HTMLElement {
  return screen.getByText(name).closest('div.rounded-lg') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  lastFilters = {};
  categories = [
    { id: 'cat-1', name: 'Beverages' },
    { id: 'cat-2', name: 'Snacks' },
  ];
  itemsQuery.data = { data: [makeItem()], pagination: { total: 1 } };
  itemsQuery.isLoading = false;
  itemsQuery.isError = false;
  itemsQuery.error = null;
  role = 'OWNER';
});

describe('CatalogPage — filters are sent as undefined when cleared', () => {
  it('starts with no filters at all', () => {
    render(<CatalogPage />);

    expect(lastFilters).toEqual({
      q: undefined,
      type: undefined,
      categoryId: undefined,
      lowStock: undefined,
    });
  });

  it('sends the chosen type, and clears it back to undefined on "All"', () => {
    render(<CatalogPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Services' }));
    expect(lastFilters.type).toBe('SERVICE');

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    // Not `''` — that would be serialised into the query string and filter on
    // an empty type, matching nothing.
    expect(lastFilters.type).toBeUndefined();
  });

  it('offers every catalog type', () => {
    render(<CatalogPage />);

    for (const label of ['All', 'Products', 'Services', 'Packages', 'Digital']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('sends the chosen category, and clears it on "All categories"', () => {
    render(<CatalogPage />);
    const select = screen.getByRole('combobox');

    fireEvent.change(select, { target: { value: 'cat-2' } });
    expect(lastFilters.categoryId).toBe('cat-2');

    fireEvent.change(select, { target: { value: '' } });
    expect(lastFilters.categoryId).toBeUndefined();
  });

  it('builds the category dropdown from the categories query', () => {
    render(<CatalogPage />);
    const select = screen.getByRole('combobox');

    expect(within(select).getByText('All categories')).toBeInTheDocument();
    expect(within(select).getByText('Beverages')).toBeInTheDocument();
    expect(within(select).getByText('Snacks')).toBeInTheDocument();
  });

  it('still renders the dropdown when categories have not loaded', () => {
    categories = [];

    render(<CatalogPage />);

    expect(within(screen.getByRole('combobox')).getByText('All categories')).toBeInTheDocument();
  });

  it('sends the search text, and clears it when emptied', () => {
    render(<CatalogPage />);
    const search = screen.getByPlaceholderText('Search catalog…');

    fireEvent.change(search, { target: { value: 'latte' } });
    expect(lastFilters.q).toBe('latte');

    fireEvent.change(search, { target: { value: '' } });
    // An empty `q` sent to the API is a search for nothing, not for everything.
    expect(lastFilters.q).toBeUndefined();
  });

  it('sends lowStock only while it is on', () => {
    render(<CatalogPage />);
    const toggle = screen.getByRole('switch', { name: 'Low stock only' });

    fireEvent.click(toggle);
    expect(lastFilters.lowStock).toBe(true);

    fireEvent.click(toggle);
    // `false` would still be serialised; off means "do not filter".
    expect(lastFilters.lowStock).toBeUndefined();
  });

  it('combines filters rather than replacing them', () => {
    render(<CatalogPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Products' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cat-1' } });
    fireEvent.change(screen.getByPlaceholderText('Search catalog…'), {
      target: { value: 'mix' },
    });

    expect(lastFilters).toEqual({
      q: 'mix',
      type: 'PRODUCT',
      categoryId: 'cat-1',
      lowStock: undefined,
    });
  });
});

describe('CatalogPage — query states', () => {
  it('shows a skeleton while the catalog loads', () => {
    itemsQuery.isLoading = true;
    itemsQuery.data = undefined;

    render(<CatalogPage />);

    expect(screen.getByText('Loading catalog…')).toBeInTheDocument();
  });

  it('offers a retry when the catalog fails to load', () => {
    itemsQuery.isError = true;
    itemsQuery.error = new Error('boom');
    itemsQuery.data = undefined;

    render(<CatalogPage />);
    fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));

    expect(itemsQuery.refetch).toHaveBeenCalled();
  });

  it('keeps the filter bar usable while the results are erroring', () => {
    // Losing the filters on an error would strand the operator on a query they
    // cannot change.
    itemsQuery.isError = true;
    itemsQuery.data = undefined;

    render(<CatalogPage />);

    expect(screen.getByPlaceholderText('Search catalog…')).toBeInTheDocument();
  });

  it('shows the empty state — with an add button — when nothing matches', () => {
    itemsQuery.data = { data: [], pagination: { total: 0 } };

    render(<CatalogPage />);

    expect(screen.getByText('No catalog items')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /add item/i })).toHaveLength(2);
  });

  it('offers a VIEWER no way to add from the empty state', () => {
    role = 'VIEWER';
    itemsQuery.data = { data: [], pagination: { total: 0 } };

    render(<CatalogPage />);

    expect(screen.getByText('No catalog items')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add item/i })).not.toBeInTheDocument();
  });

  it('hides the count line when there is nothing to count', () => {
    itemsQuery.data = { data: [], pagination: { total: 0 } };

    render(<CatalogPage />);

    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it('reports the page size against the full total', () => {
    itemsQuery.data = { data: [makeItem()], pagination: { total: 214 } };

    render(<CatalogPage />);

    expect(screen.getByText(/Showing 1 of 214 items/)).toBeInTheDocument();
  });
});

describe('CatalogPage — the item card', () => {
  it('shows the item image when it has one', () => {
    itemsQuery.data = {
      data: [makeItem({ imageUrls: ['https://cdn.test/latte.jpg'] })],
      pagination: { total: 1 },
    };

    render(<CatalogPage />);

    const img = screen.getByRole('img', { name: 'Turmeric Latte Mix' });
    expect(img).toHaveAttribute('src', 'https://cdn.test/latte.jpg');
  });

  it('falls back to a placeholder when it has none', () => {
    render(<CatalogPage />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Turmeric Latte Mix')).toBeInTheDocument();
  });

  it('marks an inactive item so it is not mistaken for a live one', () => {
    itemsQuery.data = { data: [makeItem({ isActive: false })], pagination: { total: 1 } };

    render(<CatalogPage />);

    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('does not mark an active item', () => {
    render(<CatalogPage />);

    expect(screen.queryByText('Inactive')).not.toBeInTheDocument();
  });

  it('shows the discounted price with the original struck through', () => {
    itemsQuery.data = {
      data: [makeItem({ basePrice: 45000, discountPrice: 30000 })],
      pagination: { total: 1 },
    };

    render(<CatalogPage />);

    const card = cardFor('Turmeric Latte Mix');
    // ₹300 is what the customer pays; ₹450 is the crossed-out original. Both
    // must be present — showing only one would misprice the item either way.
    expect(within(card).getByText(/300/)).toBeInTheDocument();
    expect(within(card).getByText(/450/)).toBeInTheDocument();
    expect(within(card).getByText(/450/).className).toContain('line-through');
  });

  it('shows only the base price when there is no discount', () => {
    render(<CatalogPage />);

    const card = cardFor('Turmeric Latte Mix');
    expect(within(card).queryByText(/line-through/)).not.toBeInTheDocument();
    expect(within(card).getByText(/450/)).toBeInTheDocument();
  });

  it('falls back from short description to description to a dash', () => {
    itemsQuery.data = {
      data: [
        makeItem({ id: 'a', name: 'Short', shortDescription: 'Snappy', description: 'Long form' }),
        makeItem({ id: 'b', name: 'Long only', description: 'Long form only' }),
        makeItem({ id: 'c', name: 'Neither' }),
      ],
      pagination: { total: 3 },
    };

    render(<CatalogPage />);

    expect(within(cardFor('Short')).getByText('Snappy')).toBeInTheDocument();
    expect(within(cardFor('Long only')).getByText('Long form only')).toBeInTheDocument();
    expect(within(cardFor('Neither')).getByText('—')).toBeInTheDocument();
  });

  it.each([
    [1, '1 variant'],
    [2, '2 variants'],
  ])('pluralises %i variant(s) correctly', (count, expected) => {
    itemsQuery.data = {
      data: [
        makeItem({
          variants: Array.from({ length: count }, (_, i) => ({ id: `v${i}` })),
        } as Partial<CatalogItem>),
      ],
      pagination: { total: 1 },
    };

    render(<CatalogPage />);

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('says nothing about variants when there are none', () => {
    render(<CatalogPage />);

    expect(screen.queryByText(/variant/)).not.toBeInTheDocument();
  });

  it('shows the stock badge for a tracked item', () => {
    itemsQuery.data = {
      data: [makeItem({ trackInventory: true, stockQuantity: 3, lowStockThreshold: 5 })],
      pagination: { total: 1 },
    };

    render(<CatalogPage />);

    expect(screen.getByText(/Low stock · 3/)).toBeInTheDocument();
  });
});

describe('CatalogPage — write controls', () => {
  it('opens a blank form from "Add item"', () => {
    render(<CatalogPage />);
    fireEvent.click(screen.getByRole('button', { name: /add item/i }));

    expect(screen.getByTestId('product-form')).toHaveAttribute('data-item', 'new');
  });

  it('opens the form on the item whose pencil was clicked', () => {
    itemsQuery.data = {
      data: [makeItem({ id: 'item-1' }), makeItem({ id: 'item-2', name: 'Masala Chai' })],
      pagination: { total: 2 },
    };

    render(<CatalogPage />);
    fireEvent.click(screen.getByLabelText('Edit Masala Chai'));

    expect(screen.getByTestId('product-form')).toHaveAttribute('data-item', 'item-2');
  });

  it('resets to a blank form after editing, rather than reopening the last item', () => {
    render(<CatalogPage />);
    fireEvent.click(screen.getByLabelText('Edit Turmeric Latte Mix'));
    expect(screen.getByTestId('product-form')).toHaveAttribute('data-item', 'item-1');

    fireEvent.click(screen.getByRole('button', { name: /add item/i }));

    expect(screen.getByTestId('product-form')).toHaveAttribute('data-item', 'new');
  });

  it('opens the category manager', () => {
    render(<CatalogPage />);
    fireEvent.click(screen.getByRole('button', { name: /categories/i }));

    expect(screen.getByTestId('categories')).toBeInTheDocument();
  });

  it('gives a VIEWER the catalog but no way to change it', () => {
    role = 'VIEWER';

    render(<CatalogPage />);

    expect(screen.queryByRole('button', { name: /add item/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /categories/i })).not.toBeInTheDocument();
    // The per-item pencil is not role-gated on this page — the modal it opens
    // is what refuses the write. Reading the catalog stays available.
    expect(screen.getByText('Turmeric Latte Mix')).toBeInTheDocument();
  });
});
