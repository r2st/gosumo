/**
 * `use-queries.ts` — the original hook surface: conversations, the HITL review
 * queue, clients, and the dashboard tiles.
 *
 * This file is the one hook module that goes through the structured `api`
 * object rather than raw `apiRequest`, so the assertions here are about
 * *arguments* — `api.conversations.get(id, include)` — where the other modules
 * assert URLs. The URL construction itself is `api-client`'s job and is tested
 * in `src/lib/api-client.test.ts`.
 *
 * Three behaviours carry real weight:
 *
 *  - **The polls.** Messages refresh every 15s and the HITL queue every 20s.
 *    An inbox that only updates on navigation is an inbox the operator misses
 *    a customer in, so the intervals are asserted, not assumed.
 *  - **`['messages']` as a bare prefix.** Approving a HITL draft posts a reply
 *    into some thread, and the mutation does not know which. Invalidating the
 *    bare prefix refreshes every cached thread — deliberately broader than the
 *    usual one-key invalidation.
 *  - **`include` in the cache key.** `useConversation(id)` and
 *    `useConversation(id, ['messages'])` return differently shaped payloads.
 *    Sharing one key would serve the thinner one to a page expecting the
 *    fuller one.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type MutationLike, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-queries';

vi.mock('@/lib/api-client', () => ({
  api: {
    analytics: {
      dashboard: vi.fn(),
      conversations: vi.fn(),
      revenue: vi.fn(),
    },
    conversations: {
      list: vi.fn(),
      get: vi.fn(),
      messages: vi.fn(),
      sendMessage: vi.fn(),
      resolve: vi.fn(),
      escalate: vi.fn(),
      update: vi.fn(),
    },
    hitl: { list: vi.fn(), approve: vi.fn(), reject: vi.fn() },
    clients: { list: vi.fn(), get: vi.fn(), timeline: vi.fn(), segments: vi.fn() },
    catalog: { items: vi.fn() },
    orders: { list: vi.fn() },
    bookings: { list: vi.fn() },
    payments: { list: vi.fn() },
  },
}));

const { api } = (await import('@/lib/api-client')) as unknown as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: Record<string, Record<string, ReturnType<typeof vi.fn>>>;
};

/** Every mocked endpoint, so one loop can reset and stub them all. */
function allEndpoints(): ReturnType<typeof vi.fn>[] {
  return Object.values(api).flatMap((group) => Object.values(group));
}

const CONV_ID = 'conv-1';
const CLIENT_ID = 'client-1';
const TASK_ID = 'task-1';

let h: QueryHarness;

beforeEach(() => {
  for (const fn of allEndpoints()) {
    fn.mockReset();
    fn.mockResolvedValue({ data: [], id: 'x' });
  }
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('query hooks call the right endpoint with the caller’s filters', () => {
  it.each([
    {
      name: 'useDashboardMetrics',
      run: () => hooks.useDashboardMetrics({ from: '2026-08-01', to: '2026-08-14' }),
      fn: () => api.analytics.dashboard,
      args: [{ from: '2026-08-01', to: '2026-08-14' }],
    },
    {
      name: 'useConversationReport',
      run: () => hooks.useConversationReport({ granularity: 'day' }),
      fn: () => api.analytics.conversations,
      args: [{ granularity: 'day' }],
    },
    {
      name: 'useRevenueReport',
      run: () => hooks.useRevenueReport({ granularity: 'week' }),
      fn: () => api.analytics.revenue,
      args: [{ granularity: 'week' }],
    },
    {
      name: 'useConversation',
      run: () => hooks.useConversation(CONV_ID, ['messages']),
      fn: () => api.conversations.get,
      args: [CONV_ID, ['messages']],
    },
    {
      name: 'useMessages',
      run: () => hooks.useMessages(CONV_ID),
      fn: () => api.conversations.messages,
      args: [CONV_ID],
    },
    {
      name: 'useClient',
      run: () => hooks.useClient(CLIENT_ID, ['orders']),
      fn: () => api.clients.get,
      args: [CLIENT_ID, ['orders']],
    },
    {
      name: 'useClientTimeline',
      run: () => hooks.useClientTimeline(CLIENT_ID),
      fn: () => api.clients.timeline,
      args: [CLIENT_ID],
    },
    {
      name: 'useClientSegments',
      run: () => hooks.useClientSegments(),
      fn: () => api.clients.segments,
      args: [],
    },
  ])('$name', async ({ run, fn, args }) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fn()).toHaveBeenCalledTimes(1);
    expect(fn()).toHaveBeenCalledWith(...args);
  });

  it('defaults the analytics hooks to an empty range rather than sending undefined', async () => {
    // `useDashboardMetrics()` with no argument must still be a valid call — the
    // dashboard renders before the operator picks a date range.
    const { result } = renderHook(() => hooks.useDashboardMetrics(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.analytics.dashboard).toHaveBeenCalledWith({});
  });
});

describe('list hooks pass an abort signal, so leaving the page cancels the request', () => {
  it.each([
    ['useConversations', () => hooks.useConversations({ status: 'OPEN' as never }), 'conversations', 'list', { status: 'OPEN' }],
    ['useHitlTasks', () => hooks.useHitlTasks({ status: 'PENDING' as never }), 'hitl', 'list', { status: 'PENDING' }],
    ['useClients', () => hooks.useClients({ q: 'asha' }), 'clients', 'list', { q: 'asha' }],
    ['useCatalogItems', () => hooks.useCatalogItems({ type: 'PRODUCT' }), 'catalog', 'items', { type: 'PRODUCT' }],
    ['useOrders', () => hooks.useOrders({ status: 'PENDING' as never }), 'orders', 'list', { status: 'PENDING' }],
    ['useBookings', () => hooks.useBookings({ limit: 10 }), 'bookings', 'list', { limit: 10 }],
    ['usePayments', () => hooks.usePayments({ method: 'UPI' }), 'payments', 'list', { method: 'UPI' }],
  ])('%s forwards its filters and the signal', async (_name, run, group, method, filters) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api[group as string]![method as string]).toHaveBeenCalledWith(
      filters,
      expect.any(AbortSignal),
    );
  });
});

describe('detail hooks stay idle until they have an id', () => {
  it.each([
    ['useConversation', (id: string | null) => hooks.useConversation(id)],
    ['useMessages', (id: string | null) => hooks.useMessages(id)],
    ['useClient', (id: string | null) => hooks.useClient(id)],
    ['useClientTimeline', (id: string | null) => hooks.useClientTimeline(id)],
  ])('%s does not fetch with a null id', (_name, run) => {
    const { result } = renderHook(() => run(null), { wrapper: h.wrapper });

    expect((result.current as { fetchStatus: string }).fetchStatus).toBe('idle');
    expect(allEndpoints().some((fn) => fn.mock.calls.length > 0)).toBe(false);
  });

  it.each([
    ['useConversation', (id: string | null) => hooks.useConversation(id)],
    ['useMessages', (id: string | null) => hooks.useMessages(id)],
    ['useClient', (id: string | null) => hooks.useClient(id)],
  ])('%s treats an empty router param as absent, not as a real id', (_name, run) => {
    const { result } = renderHook(() => run(''), { wrapper: h.wrapper });

    expect((result.current as { fetchStatus: string }).fetchStatus).toBe('idle');
    expect(allEndpoints().some((fn) => fn.mock.calls.length > 0)).toBe(false);
  });
});

describe('the live views poll, because an update nobody refreshes into view is not an update', () => {
  it('refreshes an open thread every 15 seconds', async () => {
    const { result } = renderHook(() => hooks.useMessages(CONV_ID), { wrapper: h.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(h.observerOptions(['messages', CONV_ID])?.refetchInterval).toBe(15_000);
  });

  it('refreshes the review queue every 20 seconds', async () => {
    const { result } = renderHook(() => hooks.useHitlTasks(), { wrapper: h.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(h.observerOptions(['hitl', 'tasks'])?.refetchInterval).toBe(20_000);
  });
});

describe('the `include` argument is part of the cache identity', () => {
  it('does not serve a thin conversation to a caller that asked for more', async () => {
    // `include: ['messages']` returns a differently shaped payload. Sharing the
    // key with the bare fetch would hand a detail page a summary object.
    const bare = renderHook(() => hooks.useConversation(CONV_ID), { wrapper: h.wrapper });
    await waitFor(() => expect(bare.result.current.isSuccess).toBe(true));

    const full = renderHook(() => hooks.useConversation(CONV_ID, ['messages']), {
      wrapper: h.wrapper,
    });
    await waitFor(() => expect(full.result.current.isSuccess).toBe(true));

    expect(api.conversations.get).toHaveBeenCalledTimes(2);
  });

  it('hashes the include array by value, so a fresh literal each render is not a new query', async () => {
    // `include` is passed as an array literal at every call site, so it is a
    // new reference on every render. React Query hashes keys structurally
    // rather than by identity — if it did not, each render would miss the
    // cache and the detail page would refetch in a loop.
    const { result, rerender } = renderHook(
      () => hooks.useConversation(CONV_ID, ['messages']),
      { wrapper: h.wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender();
    rerender();

    expect(api.conversations.get).toHaveBeenCalledTimes(1);
    expect(h.queryClient.getQueryCache().findAll({ queryKey: ['conversation', CONV_ID] })).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────

describe('mutation hooks call the right endpoint with the caller’s arguments', () => {
  it('useSendMessage sends to the conversation the hook was built for', async () => {
    // The id is bound at hook-construction time, not passed per call — the
    // variables argument is the message text alone.
    const { result } = renderHook(() => hooks.useSendMessage(CONV_ID), { wrapper: h.wrapper });

    await result.current.mutateAsync('Namaste, your order is out for delivery');

    expect(api.conversations.sendMessage).toHaveBeenCalledWith(
      CONV_ID,
      'Namaste, your order is out for delivery',
    );
  });

  it.each([
    {
      name: 'useResolveConversation',
      run: () => hooks.useResolveConversation(),
      vars: { id: CONV_ID, resolution: 'Answered' },
      fn: () => api.conversations.resolve,
      args: [CONV_ID, 'Answered'],
    },
    {
      name: 'useResolveConversation (no note)',
      run: () => hooks.useResolveConversation(),
      vars: { id: CONV_ID },
      fn: () => api.conversations.resolve,
      args: [CONV_ID, undefined],
    },
    {
      name: 'useEscalateConversation',
      run: () => hooks.useEscalateConversation(),
      vars: { id: CONV_ID, reason: 'Refund dispute', priority: 'HIGH' },
      fn: () => api.conversations.escalate,
      args: [CONV_ID, 'Refund dispute', 'HIGH'],
    },
    {
      name: 'useApproveTask',
      run: () => hooks.useApproveTask(),
      vars: { id: TASK_ID, editedResponse: 'Reworded reply' },
      fn: () => api.hitl.approve,
      args: [TASK_ID, 'Reworded reply'],
    },
    {
      name: 'useApproveTask (unedited)',
      run: () => hooks.useApproveTask(),
      vars: { id: TASK_ID },
      fn: () => api.hitl.approve,
      args: [TASK_ID, undefined],
    },
    {
      name: 'useRejectTask',
      run: () => hooks.useRejectTask(),
      vars: { id: TASK_ID, reason: 'Wrong price quoted' },
      fn: () => api.hitl.reject,
      args: [TASK_ID, 'Wrong price quoted'],
    },
  ])('$name', async ({ run, vars, fn, args }) => {
    const { result } = renderHook(run as () => MutationLike, { wrapper: h.wrapper });

    await result.current.mutateAsync(vars as never);

    expect(fn()).toHaveBeenCalledWith(...args);
  });

  it('useUpdateConversation keeps the id in the path and out of the patch body', async () => {
    // The hook destructures `{ id, ...body }`. Passing the whole variables
    // object would send an `id` field the API would reject or, worse, apply.
    const { result } = renderHook(() => hooks.useUpdateConversation(), { wrapper: h.wrapper });

    await result.current.mutateAsync({
      id: CONV_ID,
      status: 'OPEN' as never,
      assignedTo: 'user-2',
      tags: ['vip'],
    } as never);

    expect(api.conversations.update).toHaveBeenCalledWith(CONV_ID, {
      status: 'OPEN',
      assignedTo: 'user-2',
      tags: ['vip'],
    });
  });

  it('useUpdateConversation can unassign by sending an explicit null', async () => {
    // `assignedTo: null` and a missing `assignedTo` mean different things —
    // "nobody owns this" versus "leave the owner alone".
    const { result } = renderHook(() => hooks.useUpdateConversation(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: CONV_ID, assignedTo: null } as never);

    expect(api.conversations.update).toHaveBeenCalledWith(CONV_ID, { assignedTo: null });
  });
});

describe('mutations refresh exactly the views their change affects', () => {
  it('useSendMessage refreshes the thread it wrote into and the inbox list', async () => {
    const { result } = renderHook(() => hooks.useSendMessage(CONV_ID), { wrapper: h.wrapper });

    await result.current.mutateAsync('hello');

    expect(h.invalidatedKeys()).toEqual([['messages', CONV_ID], ['conversations']]);
  });

  it.each([
    ['useResolveConversation', () => hooks.useResolveConversation(), { id: CONV_ID }],
    ['useUpdateConversation', () => hooks.useUpdateConversation(), { id: CONV_ID, tags: [] }],
  ])('%s refreshes the inbox and the open conversation', async (_name, run, vars) => {
    const { result } = renderHook(run as () => MutationLike, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([['conversations'], ['conversation', CONV_ID]]);
  });

  it('useEscalateConversation also refreshes the HITL queue it just added to', async () => {
    // Escalation creates a review task. Without the `['hitl']` key the operator
    // switches to the queue and does not see the task they just filed.
    const { result } = renderHook(() => hooks.useEscalateConversation(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: CONV_ID, reason: 'Refund' } as never);

    expect(h.invalidatedKeys()).toEqual([
      ['conversations'],
      ['conversation', CONV_ID],
      ['hitl'],
    ]);
  });

  it('useApproveTask refreshes every cached thread, since it does not know which one it replied into', async () => {
    // Approving posts the AI draft as a real message. The task carries the
    // conversation id but the mutation variables do not, so the bare
    // `['messages']` prefix is the deliberate broad refresh.
    const { result } = renderHook(() => hooks.useApproveTask(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: TASK_ID } as never);

    expect(h.invalidatedKeys()).toEqual([['hitl'], ['conversations'], ['messages']]);
  });

  it('the bare `messages` prefix really does reach an open thread', async () => {
    // Asserting the key alone would not catch a key of `['messages', undefined]`,
    // which looks similar and matches nothing.
    const thread = renderHook(() => hooks.useMessages(CONV_ID), { wrapper: h.wrapper });
    await waitFor(() => expect(thread.result.current.isSuccess).toBe(true));

    const { result } = renderHook(() => hooks.useApproveTask(), { wrapper: h.wrapper });
    await result.current.mutateAsync({ id: TASK_ID } as never);

    const matched = h.queryClient
      .getQueryCache()
      .findAll({ queryKey: ['messages'] })
      .map((q) => q.queryKey);
    expect(matched).toContainEqual(['messages', CONV_ID]);
  });

  it('useRejectTask leaves the threads alone, because rejecting posts nothing', async () => {
    const { result } = renderHook(() => hooks.useRejectTask(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: TASK_ID } as never);

    expect(h.invalidatedKeys()).toEqual([['hitl'], ['conversations']]);
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed query lands in the error state with the original error', async () => {
    api.conversations.list.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useConversations(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a message that failed to send invalidates nothing', async () => {
    // Refetching would clear the failed bubble from the composer and leave the
    // operator believing the customer received a reply that never left.
    api.conversations.sendMessage.mockRejectedValueOnce(new Error('502 Channel unavailable'));
    const { result } = renderHook(() => hooks.useSendMessage(CONV_ID), { wrapper: h.wrapper });

    await expect(result.current.mutateAsync('hello')).rejects.toThrow('502 Channel unavailable');
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });

  it('a task another operator already claimed rejects without refreshing', async () => {
    api.hitl.approve.mockRejectedValueOnce(new Error('409 Task already resolved'));
    const { result } = renderHook(() => hooks.useApproveTask(), { wrapper: h.wrapper });

    await expect(result.current.mutateAsync({ id: TASK_ID } as never)).rejects.toThrow(
      '409 Task already resolved',
    );
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });
});
