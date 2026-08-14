/**
 * `use-bookings.ts` — the React Query surface for the bookings screens.
 *
 * Two things here are worth more than a URL check.
 *
 * **The slot lookup is double-gated.** `useSlots` fires only when its `enabled`
 * argument is true *and* a `catalogItemId` has been picked. Getting that wrong
 * in either direction is user-visible: fire too early and the operator sees
 * "no availability" for a service they have not chosen yet; fire too late and
 * the calendar stays empty after they have.
 *
 * **Availability settings are shared with Settings.** `useBusinessSettings` and
 * `useUpdateBusinessSettings` live in this file *and* in `use-settings.ts`,
 * reading and writing the same `/business/settings` resource under the same
 * `['business','settings']` key. That shared key is the only reason editing
 * office hours from the bookings page updates the settings page, so it is
 * asserted rather than assumed.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type MutationLike, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-bookings';

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

const BOOKING_ID = 'bk-1';
const RANGE = { from: '2026-08-14', to: '2026-08-21' };

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ id: BOOKING_ID });
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('booking query hooks request the documented endpoint', () => {
  it.each([
    { name: 'useBookings (no filters)', run: () => hooks.useBookings(), url: '/bookings' },
    {
      name: 'useBookings (filters)',
      run: () =>
        hooks.useBookings({
          status: 'CONFIRMED' as never,
          from: RANGE.from,
          to: RANGE.to,
          include: 'client',
          page: 2,
          limit: 50,
        }),
      url: '/bookings?status=CONFIRMED&from=2026-08-14&to=2026-08-21&include=client&page=2&limit=50',
    },
    { name: 'useBooking', run: () => hooks.useBooking(BOOKING_ID), url: `/bookings/${BOOKING_ID}` },
    {
      name: 'useCalendar',
      run: () => hooks.useCalendar(RANGE),
      url: '/bookings/calendar?from=2026-08-14&to=2026-08-21',
    },
    {
      name: 'useCalendar (one staff member)',
      run: () => hooks.useCalendar({ ...RANGE, staffMemberId: 'staff-1' }),
      url: '/bookings/calendar?from=2026-08-14&to=2026-08-21&staffMemberId=staff-1',
    },
    {
      name: 'useSlots',
      run: () => hooks.useSlots({ catalogItemId: 'ci-1', ...RANGE }),
      url: '/bookings/slots?catalogItemId=ci-1&from=2026-08-14&to=2026-08-21',
    },
    { name: 'useStaff', run: () => hooks.useStaff(), url: '/bookings/staff' },
    {
      name: 'useBusinessSettings',
      run: () => hooks.useBusinessSettings(),
      url: '/business/settings',
    },
  ])('$name → $url', async ({ run, url }) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
  });

  it.each([
    ['useBookings', () => hooks.useBookings()],
    ['useCalendar', () => hooks.useCalendar(RANGE)],
  ])('%s passes the abort signal, so leaving the page cancels the request', async (_n, run) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });
});

describe('useBooking stays idle until it has an id', () => {
  it.each([
    ['null', null],
    ['an empty string', ''],
  ])('does not fetch for %s', (_label, id) => {
    const { result } = renderHook(() => hooks.useBooking(id), { wrapper: h.wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('useSlots is gated on both the caller and the chosen service', () => {
  it('does not look up slots before a service is picked', () => {
    // Without a catalog item the API has no duration to slice the day into, so
    // the response would be an empty list the operator reads as "fully booked".
    const { result } = renderHook(() => hooks.useSlots({ ...RANGE }), { wrapper: h.wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('does not look up slots while the caller says not to', () => {
    // The booking form disables the lookup until the customer step is done.
    const { result } = renderHook(
      () => hooks.useSlots({ catalogItemId: 'ci-1', ...RANGE }, false),
      { wrapper: h.wrapper },
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('fires once both gates are open, and re-queries when the service changes', async () => {
    const { result, rerender } = renderHook(
      ({ catalogItemId }: { catalogItemId: string }) =>
        hooks.useSlots({ catalogItemId, ...RANGE }),
      { wrapper: h.wrapper, initialProps: { catalogItemId: 'ci-1' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ catalogItemId: 'ci-2' });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));

    expect(apiRequest.mock.calls[1]![0]).toBe(
      '/bookings/slots?catalogItemId=ci-2&from=2026-08-14&to=2026-08-21',
    );
  });

  it('narrows the lookup to one staff member when asked', async () => {
    const { result } = renderHook(
      () => hooks.useSlots({ catalogItemId: 'ci-1', staffMemberId: 'staff-9', ...RANGE }),
      { wrapper: h.wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe(
      '/bookings/slots?catalogItemId=ci-1&staffMemberId=staff-9&from=2026-08-14&to=2026-08-21',
    );
  });
});

describe('the calendar is keyed on its date range', () => {
  it('refetches when the operator pages to the next week', async () => {
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) => hooks.useCalendar({ from, to: '2026-08-31' }),
      { wrapper: h.wrapper, initialProps: { from: '2026-08-14' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ from: '2026-08-21' });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));

    expect(apiRequest.mock.calls[1]![0]).toBe(
      '/bookings/calendar?from=2026-08-21&to=2026-08-31',
    );
  });

  it('serves a week already visited from cache', async () => {
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) => hooks.useCalendar({ from, to: '2026-08-31' }),
      { wrapper: h.wrapper, initialProps: { from: '2026-08-14' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ from: '2026-08-14' });

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────

describe('booking mutation hooks call the documented endpoint', () => {
  it.each([
    {
      name: 'useCreateBooking',
      run: () => hooks.useCreateBooking(),
      vars: { catalogItemId: 'ci-1', clientId: 'cl-1', startTime: '2026-08-15T04:30:00.000Z' },
      url: '/bookings',
      method: 'POST',
      body: { catalogItemId: 'ci-1', clientId: 'cl-1', startTime: '2026-08-15T04:30:00.000Z' },
    },
    {
      name: 'useUpdateBooking',
      run: () => hooks.useUpdateBooking(),
      vars: { id: BOOKING_ID, body: { startTime: '2026-08-16T04:30:00.000Z' } },
      url: `/bookings/${BOOKING_ID}`,
      method: 'PATCH',
      body: { startTime: '2026-08-16T04:30:00.000Z' },
    },
    {
      name: 'useCancelBooking',
      run: () => hooks.useCancelBooking(),
      vars: { id: BOOKING_ID, reason: 'Customer unwell', notifyClient: true },
      url: `/bookings/${BOOKING_ID}/cancel`,
      method: 'POST',
      // The id is spread out of the body and into the path.
      body: { reason: 'Customer unwell', notifyClient: true },
    },
    {
      name: 'useCompleteBooking',
      run: () => hooks.useCompleteBooking(),
      vars: { id: BOOKING_ID, requestReview: true },
      url: `/bookings/${BOOKING_ID}/complete`,
      method: 'POST',
      body: { requestReview: true },
    },
    {
      name: 'useUpdateBusinessSettings',
      run: () => hooks.useUpdateBusinessSettings(),
      vars: { defaultSlotDurationMinutes: 45 },
      url: '/business/settings',
      method: 'PATCH',
      body: { defaultSlotDurationMinutes: 45 },
    },
  ])('$name → $method $url', async ({ run, vars, url, method, body }) => {
    const { result } = renderHook(run as () => MutationLike, { wrapper: h.wrapper });

    await result.current.mutateAsync(vars as never);

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
    expect(apiRequest.mock.calls[0]![1]).toMatchObject({ method, body });
  });

  it('useCompleteBooking sends an explicit undefined when no review was requested', async () => {
    // Chasing a customer for a review is opt-in; a missing flag must not become
    // a truthy default somewhere downstream.
    const { result } = renderHook(() => hooks.useCompleteBooking(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ id: BOOKING_ID } as never);

    expect(apiRequest.mock.calls[0]![1]).toMatchObject({ body: { requestReview: undefined } });
  });
});

describe('mutations refresh exactly the views their change affects', () => {
  it('useCreateBooking refreshes the list but no detail page', async () => {
    // The booking did not exist a moment ago, so there is no `['booking', id]`
    // in the cache to refresh.
    const { result } = renderHook(() => hooks.useCreateBooking(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ catalogItemId: 'ci-1' } as never);

    expect(h.invalidatedKeys()).toEqual([['bookings']]);
  });

  it.each([
    [
      'useUpdateBooking',
      () => hooks.useUpdateBooking(),
      { id: BOOKING_ID, body: { status: 'CONFIRMED' } },
    ],
    ['useCancelBooking', () => hooks.useCancelBooking(), { id: BOOKING_ID, reason: 'x' }],
    ['useCompleteBooking', () => hooks.useCompleteBooking(), { id: BOOKING_ID }],
  ])('%s refreshes the list and the booking it changed', async (_name, run, vars) => {
    const { result } = renderHook(run as () => MutationLike, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([['bookings'], ['booking', BOOKING_ID]]);
  });

  it('refreshes the calendar and slot lookups through the shared `bookings` prefix', async () => {
    // The calendar caches under `['bookings','calendar',range]` and slots under
    // `['bookings','slots',query]`. Rescheduling frees one time and takes
    // another, so both must redraw — and both do, without their own key.
    const calendar = renderHook(() => hooks.useCalendar(RANGE), { wrapper: h.wrapper });
    const slots = renderHook(() => hooks.useSlots({ catalogItemId: 'ci-1', ...RANGE }), {
      wrapper: h.wrapper,
    });
    await waitFor(() => expect(calendar.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(slots.result.current.isSuccess).toBe(true));

    const { result } = renderHook(() => hooks.useUpdateBooking(), { wrapper: h.wrapper });
    await result.current.mutateAsync({ id: BOOKING_ID, body: {} } as never);

    const matched = h.queryClient
      .getQueryCache()
      .findAll({ queryKey: ['bookings'] })
      .map((q) => q.queryKey);
    expect(matched).toContainEqual(['bookings', 'calendar', RANGE]);
    expect(matched).toContainEqual([
      'bookings',
      'slots',
      { catalogItemId: 'ci-1', ...RANGE },
    ]);
  });

  it('useUpdateBusinessSettings writes the response into the cache instead of refetching', async () => {
    // Office hours come back whole from the PATCH, so a refetch would be a
    // second round trip for data already in hand.
    const updated = { defaultSlotDurationMinutes: 45, timezone: 'Asia/Kolkata' };
    apiRequest.mockResolvedValueOnce(updated);
    const { result } = renderHook(() => hooks.useUpdateBusinessSettings(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ defaultSlotDurationMinutes: 45 } as never);

    expect(h.cacheWrites()).toEqual([[['business', 'settings'], updated]]);
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });

  it('shares the settings cache key with the Settings page', async () => {
    // Same key, same resource: editing availability here is immediately visible
    // on /settings, and vice versa. A private key would silently desynchronise.
    const read = renderHook(() => hooks.useBusinessSettings(), { wrapper: h.wrapper });
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));

    const updated = { defaultSlotDurationMinutes: 30 };
    apiRequest.mockResolvedValueOnce(updated);
    const { result } = renderHook(() => hooks.useUpdateBusinessSettings(), { wrapper: h.wrapper });
    await result.current.mutateAsync(updated as never);

    expect(h.queryClient.getQueryData(['business', 'settings'])).toEqual(updated);
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed query lands in the error state with the original error', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useBookings(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a double-booked slot rejects and invalidates nothing', async () => {
    // Refetching would clear the conflict message and redraw the calendar as if
    // the slot had been taken.
    apiRequest.mockRejectedValueOnce(new Error('409 Slot already booked'));
    const { result } = renderHook(() => hooks.useCreateBooking(), { wrapper: h.wrapper });

    await expect(result.current.mutateAsync({ catalogItemId: 'ci-1' } as never)).rejects.toThrow(
      '409 Slot already booked',
    );
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });

  it('a failed settings write leaves the cached settings untouched', async () => {
    apiRequest.mockRejectedValueOnce(new Error('403 Forbidden'));
    const { result } = renderHook(() => hooks.useUpdateBusinessSettings(), { wrapper: h.wrapper });

    await expect(
      result.current.mutateAsync({ defaultSlotDurationMinutes: 5 } as never),
    ).rejects.toThrow('403 Forbidden');
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
  });
});
