/**
 * `use-notifications.ts` — the bell in the header.
 *
 * The only real logic in the file is the unread-count fallback:
 *
 *     const unreadCount = res.unreadCount ?? res.data.filter((n) => !n.read).length;
 *
 * That `??` is load-bearing and easy to get wrong as `||`. A server that
 * correctly reports `unreadCount: 0` would, under `||`, fall through to
 * counting the page — and the page holds only the latest 20, so the badge would
 * show a stale non-zero number on an inbox the operator had just cleared.
 *
 * The other thing worth pinning is that the count is computed from the fetched
 * page when the server omits it. That makes it a floor, not a total: 25 unread
 * notifications read as 20. Tested here so the limit and the fallback stay
 * visibly coupled.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type MutationLike, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-notifications';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const KEY = ['notifications'];
const NOTIF_ID = 'notif-1';

/** `n` notifications, the first `unread` of them unread. */
function page(n: number, unread = 0) {
  return {
    data: Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      read: i >= unread,
      title: `Notification ${i}`,
    })),
  };
}

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue(page(0));
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// The feed
// ─────────────────────────────────────────────

describe('useNotifications', () => {
  it('requests the latest twenty', async () => {
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledWith('/notifications?limit=20');
  });

  it('polls every minute, because a notification nobody sees is not a notification', async () => {
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(h.observerOptions(KEY)?.refetchInterval).toBe(60_000);
  });

  it('narrows the response to the two fields the bell renders', async () => {
    apiRequest.mockResolvedValueOnce({ ...page(3, 2), meta: { total: 99 }, unreadCount: 2 });
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(Object.keys(result.current.data!).sort()).toEqual(['data', 'unreadCount']);
  });
});

describe('the unread badge', () => {
  it('trusts the server’s count when it sends one', async () => {
    // The server counts across every notification, not just this page, so its
    // number is the right one whenever it exists.
    apiRequest.mockResolvedValueOnce({ ...page(20, 3), unreadCount: 47 });
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.unreadCount).toBe(47);
  });

  it('honours a server-reported zero instead of recounting the page', async () => {
    // This is the `??` versus `||` case. Under `||`, a truthful `unreadCount: 0`
    // is falsy and falls through to counting the cached page — so an operator
    // who has just cleared the inbox keeps seeing a badge.
    apiRequest.mockResolvedValueOnce({ ...page(5, 5), unreadCount: 0 });
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.unreadCount).toBe(0);
  });

  it('falls back to counting the page when the server omits the field', async () => {
    apiRequest.mockResolvedValueOnce(page(6, 4));
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.unreadCount).toBe(4);
  });

  it('treats an explicit null the same as a missing count', async () => {
    // `??` catches null as well as undefined, so an API that nulls the field
    // rather than omitting it still gets the fallback rather than a null badge.
    apiRequest.mockResolvedValueOnce({ ...page(4, 2), unreadCount: null });
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.unreadCount).toBe(2);
  });

  it('reads zero for an empty feed', async () => {
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ data: [], unreadCount: 0 });
  });

  it('caps the fallback at the page size, so the badge is a floor not a total', async () => {
    // The fallback can only count what was fetched — 20 rows. With 25 unread
    // and no server count the badge reads 20. Pinned so the `limit` and the
    // fallback cannot drift apart unnoticed.
    apiRequest.mockResolvedValueOnce(page(20, 20));
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.unreadCount).toBe(20);
  });
});

// ─────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────

describe('marking notifications read', () => {
  it.each([
    ['read', true],
    ['unread', false],
  ])('useMarkNotificationRead marks one as %s', async (_label, read) => {
    // Both directions are supported — the row can be un-read again, so the flag
    // is always sent rather than assumed true.
    const { result } = renderHook(() => hooks.useMarkNotificationRead(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: NOTIF_ID, read } as never);

    expect(apiRequest).toHaveBeenCalledWith(`/notifications/${NOTIF_ID}`, {
      method: 'PATCH',
      body: { read },
    });
  });

  it('useMarkAllNotificationsRead posts an empty body rather than none', async () => {
    const { result } = renderHook(() => hooks.useMarkAllNotificationsRead(), {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(undefined as never);

    expect(apiRequest).toHaveBeenCalledWith('/notifications/read-all', {
      method: 'POST',
      body: {},
    });
  });

  it.each([
    [
      'useMarkNotificationRead',
      () => hooks.useMarkNotificationRead(),
      { id: NOTIF_ID, read: true },
    ],
    ['useMarkAllNotificationsRead', () => hooks.useMarkAllNotificationsRead(), undefined],
  ])('%s refetches the feed rather than patching the cache', async (_name, run, vars) => {
    // The badge count is server-derived and can exceed the fetched page, so it
    // cannot be recomputed locally from one row's new state. A refetch is the
    // only way to get a count that is right.
    const { result } = renderHook(run as () => MutationLike, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([KEY]);
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed feed fetch lands in the error state', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a malformed page errors rather than crashing the header', async () => {
    // The fallback reads `res.data.filter(...)`. A response without `data`
    // throws inside the query function, which puts the bell in an error state
    // instead of taking down the shell it renders in.
    apiRequest.mockResolvedValueOnce({});
    const { result } = renderHook(() => hooks.useNotifications(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('a rejected mark-read does not refetch the feed', async () => {
    apiRequest.mockRejectedValueOnce(new Error('404 Not Found'));
    const { result } = renderHook(() => hooks.useMarkNotificationRead(), { wrapper: h.wrapper });

    await expect(
      result.current.mutateAsync({ id: NOTIF_ID, read: true } as never),
    ).rejects.toThrow('404 Not Found');
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });
});
