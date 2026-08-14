/**
 * `use-settings.ts` — business profile, team, channels, AI thresholds, billing
 * and the Google Calendar link.
 *
 * The distinctive thing about this file is that most writes return the updated
 * resource whole, so they call `setQueryData` instead of invalidating. That is
 * the right trade — a PATCH that already answered with the new settings should
 * not be followed by a GET — but it means a bug here shows up as the *old*
 * values reappearing after a save, not as a spinner. Each write is asserted on
 * whether it seeds the cache or refetches, and never both.
 *
 * Two cross-surface effects are easy to drop and are pinned here:
 *
 *  - Renaming the business also invalidates `['auth','me']`, because the header
 *    renders the name from the session, not from `['business','me']`.
 *  - `useConnectChannel` takes the endpoint path as a *parameter* — each
 *    provider has its own connect route — so the test covers a real one rather
 *    than a constant baked into the hook.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-settings';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const MEMBER_ID = 'member-1';
const CHANNEL_ID = 'channel-1';

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ id: 'x', data: [] });
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('settings query hooks request the documented endpoint', () => {
  it.each([
    { name: 'useBusinessProfile', run: () => hooks.useBusinessProfile(), url: '/business/me' },
    {
      name: 'useBusinessSettings',
      run: () => hooks.useBusinessSettings(),
      url: '/business/settings',
    },
    // The team and channel lists are short and unpaginated in the UI, so both
    // ask for a page big enough that "load more" never has to exist.
    { name: 'useTeam', run: () => hooks.useTeam(), url: '/auth/team?limit=100' },
    { name: 'useChannels', run: () => hooks.useChannels(), url: '/channels?limit=100' },
    {
      name: 'useConfidenceThresholds',
      run: () => hooks.useConfidenceThresholds(),
      url: '/ai/confidence/thresholds',
    },
    {
      name: 'useSubscription',
      run: () => hooks.useSubscription(),
      url: '/business/subscription',
    },
    {
      name: 'useCalendarIntegration',
      run: () => hooks.useCalendarIntegration(),
      url: '/integrations/google-calendar',
    },
  ])('$name → $url', async ({ run, url }) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
  });
});

describe('the settings queries use distinct cache keys', () => {
  it('does not let the profile and the settings share an entry', async () => {
    // Both live under a `['business', …]` namespace and both are fetched on the
    // same page. Colliding keys would serve one endpoint's payload to the form
    // bound to the other.
    const profile = renderHook(() => hooks.useBusinessProfile(), { wrapper: h.wrapper });
    const settings = renderHook(() => hooks.useBusinessSettings(), { wrapper: h.wrapper });

    await waitFor(() => expect(profile.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(settings.result.current.isSuccess).toBe(true));

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(h.queryClient.getQueryCache().findAll({ queryKey: ['business'] })).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────
// Mutations — requests
// ─────────────────────────────────────────────

describe('settings mutation hooks call the documented endpoint', () => {
  it.each([
    {
      name: 'useUpdateBusinessProfile',
      run: () => hooks.useUpdateBusinessProfile(),
      vars: { name: 'Sharma Sweets' },
      url: '/business/me',
      options: { method: 'PATCH', body: { name: 'Sharma Sweets' } },
    },
    {
      name: 'useUpdateBusinessSettings',
      run: () => hooks.useUpdateBusinessSettings(),
      vars: { timezone: 'Asia/Kolkata' },
      url: '/business/settings',
      options: { method: 'PATCH', body: { timezone: 'Asia/Kolkata' } },
    },
    {
      name: 'useInviteMember',
      run: () => hooks.useInviteMember(),
      vars: { email: 'ravi@example.com', role: 'STAFF' },
      url: '/auth/team/invite',
      options: { method: 'POST', body: { email: 'ravi@example.com', role: 'STAFF' } },
    },
    {
      name: 'useUpdateMemberRole',
      run: () => hooks.useUpdateMemberRole(),
      vars: { memberId: MEMBER_ID, role: 'MANAGER' },
      url: `/auth/team/${MEMBER_ID}/role`,
      options: { method: 'PATCH', body: { role: 'MANAGER' } },
    },
    {
      name: 'useRemoveMember',
      run: () => hooks.useRemoveMember(),
      vars: MEMBER_ID,
      url: `/auth/team/${MEMBER_ID}`,
      options: { method: 'DELETE' },
    },
    {
      name: 'useDisconnectChannel',
      run: () => hooks.useDisconnectChannel(),
      vars: CHANNEL_ID,
      url: `/channels/${CHANNEL_ID}`,
      options: { method: 'DELETE' },
    },
    {
      name: 'useUpdateThresholds',
      run: () => hooks.useUpdateThresholds(),
      vars: { autoExecuteAbove: 92 },
      url: '/ai/confidence/thresholds',
      options: { method: 'PATCH', body: { autoExecuteAbove: 92 } },
    },
    {
      name: 'useUpgradePlan',
      run: () => hooks.useUpgradePlan(),
      vars: 'GROWTH',
      url: '/business/subscription/upgrade',
      options: { method: 'POST', body: { plan: 'GROWTH' } },
    },
    {
      name: 'useConnectCalendar',
      run: () => hooks.useConnectCalendar(),
      vars: undefined,
      url: '/integrations/google-calendar/connect',
      options: { method: 'POST' },
    },
    {
      name: 'useDisconnectCalendar',
      run: () => hooks.useDisconnectCalendar(),
      vars: undefined,
      url: '/integrations/google-calendar',
      options: { method: 'DELETE' },
    },
    {
      name: 'useSyncCalendar',
      run: () => hooks.useSyncCalendar(),
      vars: undefined,
      url: '/bookings/calendar/sync',
      options: { method: 'POST', body: {} },
    },
  ])('$name → $url', async ({ run, vars, url, options }) => {
    const { result } = renderHook(run, { wrapper: h.wrapper });

    await result.current.mutateAsync(vars as never);

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
    expect(apiRequest.mock.calls[0]![1]).toMatchObject(options);
  });

  it('useConnectChannel posts to the path the caller supplies', async () => {
    // Each provider has its own connect route — /channels/whatsapp/connect,
    // /channels/instagram/connect — so the endpoint is a parameter, not a
    // constant. A hard-coded path here would connect the wrong channel.
    const { result } = renderHook(() => hooks.useConnectChannel(), { wrapper: h.wrapper });

    await result.current.mutateAsync({
      path: '/channels/whatsapp/connect',
      body: { phoneNumberId: '9198…', wabaId: 'waba-1' },
    } as never);

    expect(apiRequest).toHaveBeenCalledWith('/channels/whatsapp/connect', {
      method: 'POST',
      body: { phoneNumberId: '9198…', wabaId: 'waba-1' },
    });
  });
});

// ─────────────────────────────────────────────
// Mutations — cache effects
// ─────────────────────────────────────────────

describe('writes that answer with the new resource seed the cache instead of refetching', () => {
  it('useUpdateBusinessSettings writes the response straight in', async () => {
    const updated = { timezone: 'Asia/Kolkata', officeHours: [] };
    apiRequest.mockResolvedValueOnce(updated);
    const { result } = renderHook(() => hooks.useUpdateBusinessSettings(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ timezone: 'Asia/Kolkata' } as never);

    expect(h.cacheWrites()).toEqual([[['business', 'settings'], updated]]);
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });

  it('useUpdateThresholds writes the response straight in', async () => {
    // The three confidence bands are the whole resource, and the API returns
    // all of them. A refetch would be a round trip for data already in hand.
    const updated = { autoExecuteAbove: 92, reviewAbove: 70 };
    apiRequest.mockResolvedValueOnce(updated);
    const { result } = renderHook(() => hooks.useUpdateThresholds(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ autoExecuteAbove: 92 } as never);

    expect(h.cacheWrites()).toEqual([[['ai', 'thresholds'], updated]]);
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });

  it('useUpdateBusinessProfile seeds the profile and refreshes the session', async () => {
    // The header renders the business name from `['auth','me']`, not from the
    // profile query — so renaming the business has to touch both or the old
    // name stays in the chrome until the next full reload.
    const updated = { id: 'b1', name: 'Sharma Sweets' };
    apiRequest.mockResolvedValueOnce(updated);
    const { result } = renderHook(() => hooks.useUpdateBusinessProfile(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ name: 'Sharma Sweets' } as never);

    expect(h.cacheWrites()).toEqual([[['business', 'me'], updated]]);
    expect(h.invalidatedKeys()).toEqual([['auth', 'me']]);
  });
});

describe('team and channel writes refetch, because their responses are partial', () => {
  it.each([
    ['useInviteMember', () => hooks.useInviteMember(), { email: 'a@b.c', role: 'STAFF' }],
    [
      'useUpdateMemberRole',
      () => hooks.useUpdateMemberRole(),
      { memberId: MEMBER_ID, role: 'MANAGER' },
    ],
    ['useRemoveMember', () => hooks.useRemoveMember(), MEMBER_ID],
  ])('%s refreshes the team list', async (_name, run, vars) => {
    // An invite returns the invitation, a removal returns nothing — neither is
    // the list, so the list has to be refetched.
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([['team']]);
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'useConnectChannel',
      () => hooks.useConnectChannel(),
      { path: '/channels/whatsapp/connect', body: {} },
    ],
    ['useDisconnectChannel', () => hooks.useDisconnectChannel(), CHANNEL_ID],
  ])('%s refreshes the channel list', async (_name, run, vars) => {
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidatedKeys()).toEqual([['channels']]);
  });
});

describe('calendar and billing writes touch only what they change', () => {
  it.each([
    ['useDisconnectCalendar', () => hooks.useDisconnectCalendar()],
    ['useSyncCalendar', () => hooks.useSyncCalendar()],
  ])('%s refreshes the integration status', async (_name, run) => {
    // Both change the "connected / last synced" card, which is the whole
    // integration resource.
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(undefined as never);

    expect(h.invalidatedKeys()).toEqual([['integrations', 'google-calendar']]);
  });

  it.each([
    ['useConnectCalendar', () => hooks.useConnectCalendar(), undefined],
    ['useUpgradePlan', () => hooks.useUpgradePlan(), 'GROWTH'],
  ])('%s invalidates nothing, because the flow finishes off-site', async (_name, run, vars) => {
    // Both hand back a URL and the browser leaves for Google or the payment
    // gateway. Nothing has changed yet — the state flips on the callback, and
    // refreshing here would just show the same pre-flow status.
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper: h.wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(h.invalidateSpy).not.toHaveBeenCalled();
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed query lands in the error state with the original error', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useBusinessSettings(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a rejected settings write leaves the cached settings alone', async () => {
    // Seeding the cache from a failed write would paint the rejected values
    // into the form and make the save look like it landed.
    apiRequest.mockRejectedValueOnce(new Error('403 Forbidden'));
    const { result } = renderHook(() => hooks.useUpdateBusinessSettings(), { wrapper: h.wrapper });

    await expect(result.current.mutateAsync({ timezone: 'UTC' } as never)).rejects.toThrow(
      '403 Forbidden',
    );
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
  });

  it('a rejected role change does not refresh the team list', async () => {
    // The API refuses a VIEWER-initiated role change. Refetching would redraw
    // the unchanged row and read as though it had been applied.
    apiRequest.mockRejectedValueOnce(new Error('403 Owner only'));
    const { result } = renderHook(() => hooks.useUpdateMemberRole(), { wrapper: h.wrapper });

    await expect(
      result.current.mutateAsync({ memberId: MEMBER_ID, role: 'OWNER' } as never),
    ).rejects.toThrow('403 Owner only');
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });
});
