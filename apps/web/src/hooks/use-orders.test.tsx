/**
 * `use-orders.ts` — the React Query surface for the orders screens.
 *
 * Orders are the one place in the dashboard where a stale cache costs money:
 * every mutation here is a lifecycle transition an operator performs once and
 * expects to see reflected. If `useConfirmOrder` refreshed the list but not the
 * open detail, the operator would confirm an order and still be looking at a
 * "Confirm" button — and would click it again.
 *
 * So each mutation is asserted twice: the exact request it sends, and the exact
 * pair of keys it refreshes. The pair matters because `['orders']` is a prefix
 * of `['orders', filters]` and `['orders','stats']` but *not* of
 * `['order', id]` — the detail view is a separate key that has to be named
 * explicitly, and `invalidateOrder` is the one helper that does it.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type MutationLike, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-orders';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const ORDER_ID = 'order-1';

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ id: ORDER_ID });
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('order query hooks request the documented endpoint', () => {
  it.each([
    { name: 'useOrders (no filters)', run: () => hooks.useOrders(), url: '/orders' },
    {
      name: 'useOrders (filters)',
      run: () => hooks.useOrders({ status: 'PENDING' as never, q: 'asha', page: 3, limit: 25 }),
      url: '/orders?status=PENDING&q=asha&page=3&limit=25',
    },
    { name: 'useOrder', run: () => hooks.useOrder(ORDER_ID), url: `/orders/${ORDER_ID}` },
    { name: 'useOrderStats (no range)', run: () => hooks.useOrderStats(), url: '/orders/stats' },
    {
      name: 'useOrderStats (range)',
      run: () => hooks.useOrderStats({ from: '2026-08-01', to: '2026-08-14' }),
      url: '/orders/stats?from=2026-08-01&to=2026-08-14',
    },
  ])('$name → $url', async ({ run, url }) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
  });

  it('passes the abort signal on the list, so leaving the page cancels the request', async () => {
    const { result } = renderHook(() => hooks.useOrders(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it('drops an empty search box rather than filtering on ""', async () => {
    const { result } = renderHook(() => hooks.useOrders({ q: '' }), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/orders');
  });
});

describe('useOrder stays idle until it has an id', () => {
  it.each([
    ['null', null],
    // An empty router param must not request `/orders/`, which is the list.
    ['an empty string', ''],
  ])('does not fetch for %s', (_label, id) => {
    const { result } = renderHook(() => hooks.useOrder(id), { wrapper: h.wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('the order list is keyed on its filters', () => {
  it('refetches when the status tab changes', async () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) => hooks.useOrders({ status: status as never }),
      { wrapper: h.wrapper, initialProps: { status: 'PENDING' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ status: 'DELIVERED' });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));

    expect(apiRequest.mock.calls[1]![0]).toBe('/orders?status=DELIVERED');
  });

  it('serves the same tab from cache instead of refetching', async () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) => hooks.useOrders({ status: status as never }),
      { wrapper: h.wrapper, initialProps: { status: 'PENDING' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ status: 'PENDING' });

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
  body: unknown;
}

/**
 * Every lifecycle transition, with the body the API expects.
 *
 * The `notify`-style flags all default to `true` in the hook rather than being
 * left undefined, because "confirm without telling the customer" has to be a
 * choice the operator makes, not something a missing property decides.
 */
const MUTATION_CASES: MutationCase[] = [
  {
    name: 'useConfirmOrder (default notifies)',
    run: () => hooks.useConfirmOrder(),
    vars: { id: ORDER_ID },
    url: `/orders/${ORDER_ID}/confirm`,
    body: { sendConfirmation: true },
  },
  {
    name: 'useConfirmOrder (opt out)',
    run: () => hooks.useConfirmOrder(),
    vars: { id: ORDER_ID, sendConfirmation: false },
    url: `/orders/${ORDER_ID}/confirm`,
    body: { sendConfirmation: false },
  },
  {
    name: 'useFulfillOrder (default notifies)',
    run: () => hooks.useFulfillOrder(),
    vars: { id: ORDER_ID },
    url: `/orders/${ORDER_ID}/fulfill`,
    body: { notifyClient: true },
  },
  {
    name: 'useFulfillOrder (opt out)',
    run: () => hooks.useFulfillOrder(),
    vars: { id: ORDER_ID, notifyClient: false },
    url: `/orders/${ORDER_ID}/fulfill`,
    body: { notifyClient: false },
  },
  {
    name: 'useCancelOrder',
    run: () => hooks.useCancelOrder(),
    vars: { id: ORDER_ID, reason: 'Out of stock', refundPayment: true },
    url: `/orders/${ORDER_ID}/cancel`,
    body: { reason: 'Out of stock', refundPayment: true, notifyClient: true },
  },
  {
    name: 'useUpdateOrderStatus',
    run: () => hooks.useUpdateOrderStatus(),
    vars: { id: ORDER_ID, status: 'SHIPPED', trackingNumber: 'BLR-9912' },
    url: `/orders/${ORDER_ID}/status`,
    body: { status: 'SHIPPED', trackingNumber: 'BLR-9912' },
  },
];

describe('order mutation hooks call the documented endpoint', () => {
  it.each(MUTATION_CASES)('$name → POST $url', async ({ run, vars, url, body }) => {
    const { result } = renderHook(run, { wrapper: h.wrapper });

    await result.current.mutateAsync(vars as never);

    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = apiRequest.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(options).toMatchObject({ method: 'POST', body });
  });

  it('sends a cancellation refund flag only when the operator set one', async () => {
    // `refundPayment` is deliberately not defaulted: refunding money is not a
    // decision an omitted property gets to make.
    const { result } = renderHook(() => hooks.useCancelOrder(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: ORDER_ID, reason: 'Duplicate' } as never);

    expect(apiRequest.mock.calls[0]![1]).toMatchObject({
      body: { reason: 'Duplicate', refundPayment: undefined, notifyClient: true },
    });
  });
});

describe('every transition refreshes both the list and the open order', () => {
  // The operator is usually looking at the detail page when they act. Refreshing
  // only `['orders']` would leave that page showing the pre-transition status
  // and its now-invalid action buttons.
  it.each([
    ['useConfirmOrder', () => hooks.useConfirmOrder(), { id: ORDER_ID }],
    ['useFulfillOrder', () => hooks.useFulfillOrder(), { id: ORDER_ID }],
    ['useCancelOrder', () => hooks.useCancelOrder(), { id: ORDER_ID, reason: 'x' }],
    [
      'useUpdateOrderStatus',
      () => hooks.useUpdateOrderStatus(),
      { id: ORDER_ID, status: 'DELIVERED' },
    ],
  ])('%s', async (_name, run, vars) => {
    const { result } = renderHook(run as () => MutationLike, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([['orders'], ['order', ORDER_ID]]);
  });

  it('keys the detail refresh off the id the operator acted on', async () => {
    // `invalidateOrder` reads the id from the mutation variables, not the
    // response. A response-derived id would refresh the wrong page whenever the
    // API echoes back something else.
    apiRequest.mockResolvedValueOnce({ id: 'some-other-id' });
    const { result } = renderHook(() => hooks.useConfirmOrder(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: ORDER_ID } as never);

    expect(h.invalidatedKeys()).toContainEqual(['order', ORDER_ID]);
  });

  it('refreshes the stats tiles too, via the shared `orders` prefix', async () => {
    // Revenue and order-count tiles cache under `['orders','stats',params]`.
    // They are covered by the same `['orders']` invalidation, so confirming an
    // order updates the tiles without a second explicit key.
    const stats = renderHook(() => hooks.useOrderStats({ from: '2026-08-01' }), {
      wrapper: h.wrapper,
    });
    await waitFor(() => expect(stats.result.current.isSuccess).toBe(true));

    const { result } = renderHook(() => hooks.useConfirmOrder(), { wrapper: h.wrapper });
    await result.current.mutateAsync({ id: ORDER_ID } as never);

    const matched = h.queryClient
      .getQueryCache()
      .findAll({ queryKey: ['orders'] })
      .map((q) => q.queryKey);
    expect(matched).toContainEqual(['orders', 'stats', { from: '2026-08-01' }]);
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed query lands in the error state with the original error', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useOrders(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a rejected transition invalidates nothing', async () => {
    // A refetch here would replace the error with a spinner and then redraw the
    // unchanged order, reading as though the transition had succeeded.
    apiRequest.mockRejectedValueOnce(new Error('409 Order already cancelled'));
    const { result } = renderHook(() => hooks.useFulfillOrder(), { wrapper: h.wrapper });

    await expect(result.current.mutateAsync({ id: ORDER_ID } as never)).rejects.toThrow(
      '409 Order already cancelled',
    );
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });
});
