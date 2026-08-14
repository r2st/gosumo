/**
 * `use-payments.ts` — the React Query surface for the payments screens.
 *
 * Payments carry the same staleness risk as orders, with one extra edge: a
 * refund is the one action here that moves real money, and `useRefundPayment`
 * spreads `{ id, ...body }` so the id reaching the URL and the id reaching the
 * body come from the same object. A test that only checked the URL would miss
 * an `id` leaking into the request body.
 *
 * As with orders, `['payments']` is a prefix of `['payments', filters]` and
 * `['payments','stats',params]` but not of `['payment', id]`, so the open
 * detail is a second key each mutation has to name for itself.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type MutationLike, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-payments';

// One spy behind both entry points: these tests assert *which URL* a hook
// requests, and that is the same question whether it goes through
// `apiRequest` or the paginated wrapper. Which of the two a list hook must
// use is asserted separately, in src/hooks/paginated-hooks.test.ts.
vi.mock('@/lib/api-client', () => {
  const spy = vi.fn();
  return { apiRequest: spy, apiPaginated: spy };
});

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const PAYMENT_ID = 'pay-1';

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ id: PAYMENT_ID });
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('payment query hooks request the documented endpoint', () => {
  it.each([
    { name: 'usePayments (no filters)', run: () => hooks.usePayments(), url: '/payments' },
    {
      name: 'usePayments (filters)',
      run: () => hooks.usePayments({ status: 'CAPTURED' as never, method: 'UPI', page: 2 }),
      url: '/payments?status=CAPTURED&method=UPI&page=2',
    },
    { name: 'usePayment', run: () => hooks.usePayment(PAYMENT_ID), url: `/payments/${PAYMENT_ID}` },
    {
      name: 'usePaymentStats (no range)',
      run: () => hooks.usePaymentStats(),
      url: '/payments/stats',
    },
    {
      name: 'usePaymentStats (range)',
      run: () => hooks.usePaymentStats({ from: '2026-08-01', to: '2026-08-14' }),
      url: '/payments/stats?from=2026-08-01&to=2026-08-14',
    },
  ])('$name → $url', async ({ run, url }) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
  });

  it('passes the abort signal on the list, so leaving the page cancels the request', async () => {
    const { result } = renderHook(() => hooks.usePayments(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });
});

describe('usePayment stays idle until it has an id', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('does not fetch for %s', (_label, id) => {
    const { result } = renderHook(() => hooks.usePayment(id), { wrapper: h.wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('the payment list is keyed on its filters', () => {
  it('refetches when the method filter changes', async () => {
    const { result, rerender } = renderHook(
      ({ method }: { method: 'UPI' | 'CARD' }) => hooks.usePayments({ method }),
      { wrapper: h.wrapper, initialProps: { method: 'UPI' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ method: 'CARD' });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));

    expect(apiRequest.mock.calls[1]![0]).toBe('/payments?method=CARD');
  });
});

// ─────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────

describe('payment mutation hooks call the documented endpoint', () => {
  it('useCreatePaymentLink posts the link request whole', async () => {
    const body = { orderId: 'order-1', amountInPaise: 250000, expiryHours: 24 };
    const { result } = renderHook(() => hooks.useCreatePaymentLink(), { wrapper: h.wrapper });

    await result.current.mutateAsync(body as never);

    expect(apiRequest).toHaveBeenCalledWith('/payments/link', { method: 'POST', body });
  });

  it('useRefundPayment puts the id in the path and keeps it out of the body', async () => {
    // The hook destructures `{ id, ...body }`. If the rest-spread were ever
    // replaced with the whole variables object, the gateway would receive an
    // unexpected `id` field alongside the refund amount.
    const { result } = renderHook(() => hooks.useRefundPayment(), { wrapper: h.wrapper });

    await result.current.mutateAsync({
      id: PAYMENT_ID,
      amountInPaise: 50000,
      reason: 'Partial cancellation',
    } as never);

    expect(apiRequest).toHaveBeenCalledWith(`/payments/${PAYMENT_ID}/refund`, {
      method: 'POST',
      body: { amountInPaise: 50000, reason: 'Partial cancellation' },
    });
  });

  it('useCapturePayment sends an undefined amount for a full capture', async () => {
    // Omitting `amount` is how the caller says "capture the authorised total".
    // Substituting 0 would capture nothing while reporting success.
    const { result } = renderHook(() => hooks.useCapturePayment(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: PAYMENT_ID } as never);

    expect(apiRequest).toHaveBeenCalledWith(`/payments/${PAYMENT_ID}/capture`, {
      method: 'POST',
      body: { amount: undefined },
    });
  });

  it('useCapturePayment passes a partial amount through untouched', async () => {
    const { result } = renderHook(() => hooks.useCapturePayment(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: PAYMENT_ID, amount: 120000 } as never);

    expect(apiRequest.mock.calls[0]![1]).toMatchObject({ body: { amount: 120000 } });
  });
});

describe('mutations refresh exactly the views their change affects', () => {
  it('useCreatePaymentLink refreshes the list but no detail page', async () => {
    // A link is created before any payment exists, so there is no `['payment',
    // id]` to refresh — naming one would invalidate a key nothing is watching.
    const { result } = renderHook(() => hooks.useCreatePaymentLink(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ orderId: 'order-1', amountInPaise: 1000 } as never);

    expect(h.invalidatedKeys()).toEqual([['payments']]);
  });

  it.each([
    ['useRefundPayment', () => hooks.useRefundPayment(), { id: PAYMENT_ID, amountInPaise: 500 }],
    ['useCapturePayment', () => hooks.useCapturePayment(), { id: PAYMENT_ID }],
  ])('%s refreshes the list and the payment it changed', async (_name, run, vars) => {
    const { result } = renderHook(run as () => MutationLike, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([['payments'], ['payment', PAYMENT_ID]]);
  });

  it('refreshes the stats tiles too, via the shared `payments` prefix', async () => {
    // Captured/refunded totals cache under `['payments','stats',params]` and
    // are exactly what a refund changes.
    const stats = renderHook(() => hooks.usePaymentStats({ from: '2026-08-01' }), {
      wrapper: h.wrapper,
    });
    await waitFor(() => expect(stats.result.current.isSuccess).toBe(true));

    const { result } = renderHook(() => hooks.useRefundPayment(), { wrapper: h.wrapper });
    await result.current.mutateAsync({ id: PAYMENT_ID, amountInPaise: 500 } as never);

    const matched = h.queryClient
      .getQueryCache()
      .findAll({ queryKey: ['payments'] })
      .map((q) => q.queryKey);
    expect(matched).toContainEqual(['payments', 'stats', { from: '2026-08-01' }]);
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed query lands in the error state with the original error', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.usePayments(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a rejected refund invalidates nothing', async () => {
    // Refetching after a failed refund would redraw the payment as it was and
    // let the operator believe the money went back.
    apiRequest.mockRejectedValueOnce(new Error('422 Refund window closed'));
    const { result } = renderHook(() => hooks.useRefundPayment(), { wrapper: h.wrapper });

    await expect(
      result.current.mutateAsync({ id: PAYMENT_ID, amountInPaise: 500 } as never),
    ).rejects.toThrow('422 Refund window closed');
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });
});
