/**
 * `use-catalog.ts` — the React Query surface for the catalog screens.
 *
 * The hooks are thin, so the bugs they can carry are the ones a reviewer's eye
 * slides over: a wrong URL segment (a screen renders nothing), a detail hook
 * that fires with a null id (`/catalog/items/null`, a 404 on a page nobody
 * opened), and — the one that actually reaches users — a mutation that
 * invalidates the wrong key and leaves the grid showing the row the operator
 * just deleted.
 *
 * Two key facts drive the invalidation assertions below:
 *
 *  - React Query treats keys as prefixes, so `['catalog','items']` also covers
 *    `['catalog','items',filters]` — every filtered list refreshes from the one
 *    key.
 *  - It is *not* a prefix of `['catalog','item',id]`. `items` and `item` are
 *    different keys, so the detail view is a separate refresh that each
 *    mutation either does or does not perform. Which one it is, is asserted.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-catalog';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const ITEM_ID = 'item-1';
const CATEGORY_ID = 'cat-1';
const ITEMS_KEY = ['catalog', 'items'];
const CATEGORIES_KEY = ['catalog', 'categories'];

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ id: 'x' });
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('catalog query hooks request the documented endpoint', () => {
  it.each([
    {
      name: 'useCatalogItems (no filters)',
      run: () => hooks.useCatalogItems(),
      url: '/catalog/items',
    },
    {
      name: 'useCatalogItems (filters)',
      run: () => hooks.useCatalogItems({ q: 'dosa', type: 'PRODUCT', page: 2, limit: 20 }),
      url: '/catalog/items?q=dosa&type=PRODUCT&page=2&limit=20',
    },
    {
      name: 'useCatalogItem',
      run: () => hooks.useCatalogItem(ITEM_ID),
      url: `/catalog/items/${ITEM_ID}`,
    },
    { name: 'useCategories', run: () => hooks.useCategories(), url: '/catalog/categories' },
  ])('$name → $url', async ({ run, url }) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
  });

  it('passes the abort signal on the list, so leaving the page cancels the request', async () => {
    const { result } = renderHook(() => hooks.useCatalogItems(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it('omits filters that were not supplied instead of sending "undefined"', async () => {
    const { result } = renderHook(() => hooks.useCatalogItems({ q: undefined, type: 'SERVICE' }), {
      wrapper: h.wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/catalog/items?type=SERVICE');
  });

  it('drops an empty search box rather than filtering on ""', async () => {
    const { result } = renderHook(() => hooks.useCatalogItems({ q: '' }), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/catalog/items');
  });
});

describe('useCatalogItem stays idle until it has an id', () => {
  it.each([
    ['null', null],
    // An empty router param must not request `/catalog/items/`, which resolves
    // to the list endpoint and would render a list into a detail page.
    ['an empty string', ''],
  ])('does not fetch for %s', (_label, id) => {
    const { result } = renderHook(() => hooks.useCatalogItem(id), { wrapper: h.wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('the item list is keyed on its filters', () => {
  it('refetches when the filters change', async () => {
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => hooks.useCatalogItems({ q }),
      { wrapper: h.wrapper, initialProps: { q: 'dosa' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ q: 'idli' });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));

    expect(apiRequest.mock.calls[1]![0]).toBe('/catalog/items?q=idli');
  });

  it('serves the same filters from cache instead of refetching', async () => {
    const { result, rerender } = renderHook(
      ({ q }: { q: string }) => hooks.useCatalogItems({ q }),
      { wrapper: h.wrapper, initialProps: { q: 'dosa' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ q: 'dosa' });

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────

interface MutationCase {
  name: string;
  run: () => { mutateAsync: (vars: never) => Promise<unknown> };
  vars: unknown;
  url: string;
  method: string;
  body?: unknown;
}

const MUTATION_CASES: MutationCase[] = [
  {
    name: 'useCreateCatalogItem',
    run: () => hooks.useCreateCatalogItem(),
    vars: { name: 'Masala Dosa', type: 'PRODUCT', priceInPaise: 12000 },
    url: '/catalog/items',
    method: 'POST',
    body: { name: 'Masala Dosa', type: 'PRODUCT', priceInPaise: 12000 },
  },
  {
    name: 'useUpdateCatalogItem',
    run: () => hooks.useUpdateCatalogItem(),
    vars: { id: ITEM_ID, body: { priceInPaise: 13000 } },
    url: `/catalog/items/${ITEM_ID}`,
    method: 'PATCH',
    body: { priceInPaise: 13000 },
  },
  {
    name: 'useDeleteCatalogItem',
    run: () => hooks.useDeleteCatalogItem(),
    vars: ITEM_ID,
    url: `/catalog/items/${ITEM_ID}`,
    method: 'DELETE',
  },
  {
    name: 'useSetAvailability',
    run: () => hooks.useSetAvailability(),
    vars: { id: ITEM_ID, isAvailable: false },
    url: '/catalog/items/bulk-availability',
    method: 'PATCH',
    body: { updates: [{ itemId: ITEM_ID, isAvailable: false }] },
  },
  {
    name: 'useCreateCategory',
    run: () => hooks.useCreateCategory(),
    vars: { name: 'Breakfast' },
    url: '/catalog/categories',
    method: 'POST',
    body: { name: 'Breakfast' },
  },
  {
    name: 'useUpdateCategory',
    run: () => hooks.useUpdateCategory(),
    vars: { id: CATEGORY_ID, body: { name: 'All-day breakfast' } },
    url: `/catalog/categories/${CATEGORY_ID}`,
    method: 'PATCH',
    body: { name: 'All-day breakfast' },
  },
  {
    name: 'useDeleteCategory',
    run: () => hooks.useDeleteCategory(),
    vars: CATEGORY_ID,
    url: `/catalog/categories/${CATEGORY_ID}`,
    method: 'DELETE',
  },
];

describe('catalog mutation hooks call the documented endpoint', () => {
  it.each(MUTATION_CASES)('$name → $method $url', async ({ run, vars, url, method, body }) => {
    const { result } = renderHook(run, { wrapper: h.wrapper });

    await result.current.mutateAsync(vars as never);

    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = apiRequest.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect((options as { method: string }).method).toBe(method);
    if (body !== undefined) expect((options as { body: unknown }).body).toEqual(body);
  });
});

describe('mutations refresh exactly the views their change affects', () => {
  it.each([
    ['useCreateCatalogItem', () => hooks.useCreateCatalogItem(), { name: 'Idli' }],
    ['useSetAvailability', () => hooks.useSetAvailability(), { id: ITEM_ID, isAvailable: true }],
  ])('%s refreshes the item list only', async (_name, run, vars) => {
    // Neither changes which categories exist or how many items each holds.
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([ITEMS_KEY]);
  });

  it.each([
    [
      'useUpdateCatalogItem',
      () => hooks.useUpdateCatalogItem(),
      { id: ITEM_ID, body: { categoryId: CATEGORY_ID } },
    ],
    ['useDeleteCatalogItem', () => hooks.useDeleteCatalogItem(), ITEM_ID],
  ])('%s also refreshes categories, whose item counts moved', async (_name, run, vars) => {
    // An edit can reassign an item's category and a delete removes it from one,
    // so the category list's per-category counts are stale either way.
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([ITEMS_KEY, CATEGORIES_KEY]);
  });

  it.each([
    ['useCreateCategory', () => hooks.useCreateCategory(), { name: 'Drinks' }],
    [
      'useUpdateCategory',
      () => hooks.useUpdateCategory(),
      { id: CATEGORY_ID, body: { name: 'Cold drinks' } },
    ],
    ['useDeleteCategory', () => hooks.useDeleteCategory(), CATEGORY_ID],
  ])('%s refreshes the category list only', async (_name, run, vars) => {
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([CATEGORIES_KEY]);
  });

  it('invalidates the list prefix, so every filtered grid refreshes at once', async () => {
    // The screens hold several cached lists — one per filter combination. A key
    // of `['catalog','items',filters]` would refresh only the tab in view and
    // leave the others showing the pre-edit rows.
    const filtered = renderHook(() => hooks.useCatalogItems({ type: 'PRODUCT' }), {
      wrapper: h.wrapper,
    });
    await waitFor(() => expect(filtered.result.current.isSuccess).toBe(true));

    const { result } = renderHook(() => hooks.useCreateCatalogItem(), { wrapper: h.wrapper });
    await result.current.mutateAsync({ name: 'Vada' } as never);

    const [key] = h.invalidatedKeys();
    expect(
      h.queryClient.getQueryCache().findAll({ queryKey: key as unknown[] }).map((q) => q.queryKey),
    ).toContainEqual(['catalog', 'items', { type: 'PRODUCT' }]);
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed query lands in the error state with the original error', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useCatalogItems(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a failed delete rejects and invalidates nothing', async () => {
    // Invalidating on failure would refetch, hide the error behind a spinner,
    // and redraw the unchanged row as though the delete had gone through.
    apiRequest.mockRejectedValueOnce(new Error('409 Conflict'));
    const { result } = renderHook(() => hooks.useDeleteCatalogItem(), { wrapper: h.wrapper });

    await expect(result.current.mutateAsync(ITEM_ID as never)).rejects.toThrow('409 Conflict');
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });
});
