/**
 * `apiPaginated` — the flat-vs-nested pagination bridge.
 *
 * This exists because of a bug that shipped: the backend answers list routes
 * with flat fields (`{ data, total, page, limit, totalPages }`) while the
 * frontend's `PaginatedResponse<T>` nests them under `pagination`. Seven hooks
 * asked `apiRequest<PaginatedResponse<T>>` for that shape — and `apiRequest`
 * *casts*, it does not convert. So `data.pagination` was `undefined` at
 * runtime while TypeScript insisted it was there, and
 * `app/(dashboard)/orders/page.tsx` read `data.pagination.total` straight into
 * a TypeError on any business with at least one order.
 *
 * Every page-level test missed it because the mocks all supplied the nested
 * shape the *type* promised rather than the flat one the *server* sends. So
 * the tests below deliberately feed the server's real shape, and the
 * "already nested" cases guard the other direction: a route that has been
 * migrated must not be double-wrapped into `pagination.pagination`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answer the next request with `body`, as the API would. */
function respondWith(body: unknown) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
}

async function apiPaginated<T>(path: string) {
  const mod = await import('./api-client');
  return mod.apiPaginated<T>(path);
}

describe('apiPaginated', () => {
  it('lifts the backend’s flat page fields into a pagination envelope', async () => {
    // Exactly what `GET /orders` returns — see OrderService.listOrders.
    respondWith({
      data: [{ id: 'order-1' }],
      total: 340,
      page: 2,
      limit: 20,
      totalPages: 17,
    });

    const res = await apiPaginated<{ id: string }>('/orders');

    expect(res.pagination).toEqual({
      total: 340,
      page: 2,
      limit: 20,
      totalPages: 17,
      hasMore: true,
    });
    expect(res.data).toEqual([{ id: 'order-1' }]);
  });

  it('derives hasMore from the page position rather than trusting the server', async () => {
    respondWith({ data: [], total: 40, page: 2, limit: 20, totalPages: 2 });

    await expect(apiPaginated('/orders')).resolves.toMatchObject({
      pagination: expect.objectContaining({ hasMore: false }),
    });
  });

  it('passes an already-nested response through without wrapping it twice', async () => {
    // `GET /payments` is one of the routes that already answers nested.
    const nested = {
      data: [{ id: 'pay-1' }],
      pagination: { total: 1, page: 1, limit: 20, totalPages: 1, hasMore: false },
    };
    respondWith(nested);

    const res = await apiPaginated<{ id: string }>('/payments');

    expect(res).toEqual(nested);
    expect(res.pagination).not.toHaveProperty('pagination');
  });

  it('gives an empty page rather than an undefined one when the body is bare', async () => {
    // A 200 with `{}` must not produce `data: undefined`, or every consumer's
    // `data.data.map(…)` throws.
    respondWith({});

    const res = await apiPaginated('/catalog/items');

    expect(res.data).toEqual([]);
    expect(res.pagination.total).toBe(0);
    expect(res.pagination.page).toBe(1);
  });

  it('always produces a readable total, which is what the crash was about', async () => {
    // The regression itself: `Showing N of {data.pagination.total}` must not
    // throw, for either server shape.
    respondWith({ data: [{ id: 'a' }], total: 7, page: 1, limit: 20, totalPages: 1 });

    const res = await apiPaginated<{ id: string }>('/bookings');

    expect(() => String(res.pagination.total)).not.toThrow();
    expect(res.pagination.total).toBe(7);
  });
});
