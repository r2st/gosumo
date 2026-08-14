/**
 * `use-onboarding.ts` — the setup wizard's data layer.
 *
 * Onboarding splits one resource across two queries on purpose: a cheap
 * `/onboarding/status` that every login hits to decide whether to show the
 * wizard at all, and the full `/onboarding/progress` that only the wizard
 * itself fetches. The tests below cover the three things that split depends on:
 *
 *  - **Status is cached for a minute.** It is fetched on every login and its
 *    answer barely changes; without `staleTime` the app re-asks on every
 *    remount of the shell.
 *  - **Both hooks take an `enabled` flag.** The wizard's queries must not fire
 *    before there is a session, or the operator sees a failed request behind
 *    the login screen.
 *  - **Every step write seeds progress and invalidates status.** The step
 *    response *is* the new progress, so refetching it would be a wasted round
 *    trip — but the derived "is onboarding done" flag lives in the other query
 *    and has to be re-asked.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-onboarding';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const PROGRESS_KEY = ['onboarding', 'progress'];
const STATUS_KEY = ['onboarding', 'status'];

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ completed: false, steps: [] });
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('onboarding query hooks request the documented endpoint', () => {
  it.each([
    {
      name: 'useOnboardingStatus',
      run: () => hooks.useOnboardingStatus(),
      url: '/onboarding/status',
    },
    {
      name: 'useOnboardingProgress',
      run: () => hooks.useOnboardingProgress(),
      url: '/onboarding/progress',
    },
  ])('$name → $url', async ({ run, url }) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
  });

  it('keeps the two queries on separate cache entries', async () => {
    // The wizard renders both at once. A shared key would hand the lightweight
    // status payload to the step list.
    const status = renderHook(() => hooks.useOnboardingStatus(), { wrapper: h.wrapper });
    const progress = renderHook(() => hooks.useOnboardingProgress(), { wrapper: h.wrapper });

    await waitFor(() => expect(status.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(progress.result.current.isSuccess).toBe(true));

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(h.queryClient.getQueryCache().findAll({ queryKey: ['onboarding'] })).toHaveLength(2);
  });
});

describe('both queries can be held back until there is a session', () => {
  it.each([
    ['useOnboardingStatus', () => hooks.useOnboardingStatus(false)],
    ['useOnboardingProgress', () => hooks.useOnboardingProgress(false)],
  ])('%s stays idle when disabled', (_name, run) => {
    // The shell renders before auth resolves. Firing here means a 401 behind
    // the login screen and a wizard that flashes for unauthenticated visitors.
    const { result } = renderHook(run as () => { fetchStatus: string }, { wrapper: h.wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('fires once the caller enables it', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => hooks.useOnboardingStatus(enabled),
      { wrapper: h.wrapper, initialProps: { enabled: false } },
    );
    expect(apiRequest).not.toHaveBeenCalled();

    rerender({ enabled: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});

describe('useOnboardingStatus', () => {
  it('holds its answer for a minute, because every login asks', async () => {
    // Without a staleTime the status refetches on every remount of the app
    // shell — a request per navigation for an answer that changes once.
    const { result } = renderHook(() => hooks.useOnboardingStatus(), { wrapper: h.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [query] = h.queryClient.getQueryCache().findAll({ queryKey: STATUS_KEY });
    expect(query?.options.staleTime).toBe(60_000);
  });

  it('serves a remount from cache while still fresh', async () => {
    const first = renderHook(() => hooks.useOnboardingStatus(), { wrapper: h.wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));

    renderHook(() => hooks.useOnboardingStatus(), { wrapper: h.wrapper });

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('does not cache the full progress, which the wizard needs current', async () => {
    // Progress changes with every step the operator completes, so it carries no
    // staleTime — a stale one would leave a finished step showing as pending.
    const { result } = renderHook(() => hooks.useOnboardingProgress(), { wrapper: h.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [query] = h.queryClient.getQueryCache().findAll({ queryKey: PROGRESS_KEY });
    expect(query?.options.staleTime).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────

describe('onboarding mutation hooks call the documented endpoint', () => {
  it('useUpdateOnboardingStep PUTs the step payload', async () => {
    const body = { stepId: 'CONNECT_CHANNEL', completed: true, data: { channel: 'WHATSAPP' } };
    const { result } = renderHook(() => hooks.useUpdateOnboardingStep(), { wrapper: h.wrapper });

    await result.current.mutateAsync(body as never);

    expect(apiRequest).toHaveBeenCalledWith('/onboarding/progress', { method: 'PUT', body });
  });

  it('useCompleteOnboarding posts an empty body rather than none', async () => {
    const { result } = renderHook(() => hooks.useCompleteOnboarding(), { wrapper: h.wrapper });

    await result.current.mutateAsync(undefined as never);

    expect(apiRequest).toHaveBeenCalledWith('/onboarding/complete', { method: 'POST', body: {} });
  });

  it('useOnboardingChat forwards the message, the step, and the history', async () => {
    // The assistant needs the step for context and the history for continuity;
    // dropping either turns a guided setup into a cold reply every turn.
    const body = {
      message: 'What is a WABA id?',
      step: 'CONNECT_CHANNEL' as never,
      history: [{ role: 'user' as const, content: 'hi' }],
    };
    const { result } = renderHook(() => hooks.useOnboardingChat(), { wrapper: h.wrapper });

    await result.current.mutateAsync(body as never);

    expect(apiRequest).toHaveBeenCalledWith('/onboarding/chat', { method: 'POST', body });
  });

  it('useOnboardingChat sends a bare message when there is no history yet', async () => {
    const { result } = renderHook(() => hooks.useOnboardingChat(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ message: 'hello' } as never);

    expect(apiRequest).toHaveBeenCalledWith('/onboarding/chat', {
      method: 'POST',
      body: { message: 'hello' },
    });
  });
});

describe('step writes seed progress and re-ask the derived status', () => {
  it.each([
    [
      'useUpdateOnboardingStep',
      () => hooks.useUpdateOnboardingStep(),
      { stepId: 'CONNECT_CHANNEL', completed: true },
    ],
    ['useCompleteOnboarding', () => hooks.useCompleteOnboarding(), undefined],
  ])('%s', async (_name, run, vars) => {
    // The response *is* the new progress, so refetching it would be a wasted
    // round trip. But "is onboarding finished" is derived server-side and lives
    // in the other query, which has to be re-asked — that flag is what decides
    // whether the wizard shows on the next navigation.
    const updated = { completed: true, steps: [{ id: 'CONNECT_CHANNEL', completed: true }] };
    apiRequest.mockResolvedValueOnce(updated);
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.cacheWrites()).toEqual([[PROGRESS_KEY, updated]]);
    expect(h.invalidatedKeys()).toEqual([STATUS_KEY]);
  });

  it('the seeded progress is readable without another request', async () => {
    const updated = { completed: false, steps: [{ id: 'PROFILE', completed: true }] };
    apiRequest.mockResolvedValueOnce(updated);
    const { result } = renderHook(() => hooks.useUpdateOnboardingStep(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ stepId: 'PROFILE', completed: true } as never);

    expect(h.queryClient.getQueryData(PROGRESS_KEY)).toEqual(updated);
  });

  it('useOnboardingChat touches no cache at all', async () => {
    // A question about setup is not a change to it. Invalidating here would
    // reset the wizard's step list mid-conversation.
    const { result } = renderHook(() => hooks.useOnboardingChat(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ message: 'hello' } as never);

    expect(h.invalidateSpy).not.toHaveBeenCalled();
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed status fetch lands in the error state', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useOnboardingStatus(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a rejected step write leaves the cached progress alone', async () => {
    // Seeding from a failure would tick the step off in the UI while the server
    // still considers it pending — and the wizard would let the operator move on.
    apiRequest.mockRejectedValueOnce(new Error('400 Step out of order'));
    const { result } = renderHook(() => hooks.useUpdateOnboardingStep(), { wrapper: h.wrapper });

    await expect(
      result.current.mutateAsync({ stepId: 'PROFILE', completed: true } as never),
    ).rejects.toThrow('400 Step out of order');
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });
});
