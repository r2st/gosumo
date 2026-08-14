/**
 * `use-channels.ts` — the three channel actions that are not plain CRUD.
 *
 * Connect and disconnect live in `use-settings.ts`; what is left here is the
 * odd trio, and each is odd in its own way:
 *
 *  - `useTestChannel` and `useWebChatEmbed` are *reads* modelled as mutations,
 *    because both are user-initiated one-shots. Nothing should be cached: the
 *    latency figure is only meaningful at the moment the button was pressed,
 *    and the embed snippet is generated on demand.
 *  - `useWebChatEmbed` is the only mutation in the codebase that sends no
 *    options object at all — a bare GET behind `useMutation`. That is easy to
 *    "tidy" into a POST, which would fail.
 *  - `useToggleChannel` is the only one of the three that changes anything, so
 *    it is the only one that invalidates.
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-channels';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const CHANNEL_ID = 'channel-1';

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ success: true });
  h = createQueryHarness();
});

describe('useTestChannel', () => {
  it('posts to the channel’s test endpoint', async () => {
    const { result } = renderHook(() => hooks.useTestChannel(), { wrapper: h.wrapper });

    await result.current.mutateAsync(CHANNEL_ID as never);

    expect(apiRequest).toHaveBeenCalledWith(`/channels/${CHANNEL_ID}/test`, { method: 'POST' });
  });

  it('hands the result back to the caller rather than caching it', async () => {
    // The latency number is only true at the instant the operator pressed the
    // button. Cached, it would be read as the channel's current health.
    apiRequest.mockResolvedValueOnce({ success: true, message: 'Connected', latencyMs: 212 });
    const { result } = renderHook(() => hooks.useTestChannel(), { wrapper: h.wrapper });

    const res = await result.current.mutateAsync(CHANNEL_ID as never);

    expect(res).toEqual({ success: true, message: 'Connected', latencyMs: 212 });
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });

  it('resolves rather than throws when the channel reports itself unhealthy', async () => {
    // A reachable-but-misconfigured channel answers 200 with success:false. If
    // that were treated as a rejection the operator would see a generic network
    // error instead of the specific reason the channel gave.
    apiRequest.mockResolvedValueOnce({
      success: false,
      message: 'Token expired',
      latencyMs: 88,
    });
    const { result } = renderHook(() => hooks.useTestChannel(), { wrapper: h.wrapper });

    const res = await result.current.mutateAsync(CHANNEL_ID as never);

    expect(res).toMatchObject({ success: false, message: 'Token expired' });
  });

  it('surfaces a transport failure as a rejection', async () => {
    apiRequest.mockRejectedValueOnce(new Error('504 Gateway Timeout'));
    const { result } = renderHook(() => hooks.useTestChannel(), { wrapper: h.wrapper });

    await expect(result.current.mutateAsync(CHANNEL_ID as never)).rejects.toThrow(
      '504 Gateway Timeout',
    );
  });
});

describe('useWebChatEmbed', () => {
  it('GETs the embed endpoint with no options object', async () => {
    // A bare `apiRequest(path)` — the request defaults to GET. Adding a method
    // or an empty body here would send a POST the route does not serve.
    const { result } = renderHook(() => hooks.useWebChatEmbed(), { wrapper: h.wrapper });

    await result.current.mutateAsync(CHANNEL_ID as never);

    expect(apiRequest).toHaveBeenCalledWith(`/channels/webchat/embed/${CHANNEL_ID}`);
    expect(apiRequest.mock.calls[0]).toHaveLength(1);
  });

  it('returns the snippet for the operator to copy', async () => {
    const embed = {
      snippet: '<script src="https://cdn.gosumo.in/widget.js" data-id="w1"></script>',
      widgetId: 'w1',
      config: { theme: 'light' },
    };
    apiRequest.mockResolvedValueOnce(embed);
    const { result } = renderHook(() => hooks.useWebChatEmbed(), { wrapper: h.wrapper });

    expect(await result.current.mutateAsync(CHANNEL_ID as never)).toEqual(embed);
  });

  it('caches nothing, because the snippet is generated on demand', async () => {
    const { result } = renderHook(() => hooks.useWebChatEmbed(), { wrapper: h.wrapper });

    await result.current.mutateAsync(CHANNEL_ID as never);

    expect(h.invalidateSpy).not.toHaveBeenCalled();
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
  });
});

describe('useToggleChannel', () => {
  it.each([
    ['enabling', true],
    ['disabling', false],
  ])('%s PATCHes the flag explicitly', async (_label, enabled) => {
    // Both directions send a boolean. A toggle that only ever sent `true`, or
    // omitted the field when false, would be a one-way switch.
    const { result } = renderHook(() => hooks.useToggleChannel(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ channelId: CHANNEL_ID, enabled } as never);

    expect(apiRequest).toHaveBeenCalledWith(`/channels/${CHANNEL_ID}/toggle`, {
      method: 'PATCH',
      body: { enabled },
    });
  });

  it('refreshes the channel list, which renders the switch', async () => {
    // The list is the only thing showing the on/off state, and it is fetched by
    // `useChannels` in use-settings.ts under this exact key.
    const { result } = renderHook(() => hooks.useToggleChannel(), { wrapper: h.wrapper });

    await result.current.mutateAsync({ channelId: CHANNEL_ID, enabled: false } as never);

    expect(h.invalidatedKeys()).toEqual([['channels']]);
  });

  it('leaves the switch alone when the toggle is refused', async () => {
    // Refetching after a 403 would redraw the row from the server's unchanged
    // state — correct, but it would also clear the error the operator needs to
    // see. Not invalidating keeps the failure visible.
    apiRequest.mockRejectedValueOnce(new Error('403 Manager only'));
    const { result } = renderHook(() => hooks.useToggleChannel(), { wrapper: h.wrapper });

    await expect(
      result.current.mutateAsync({ channelId: CHANNEL_ID, enabled: false } as never),
    ).rejects.toThrow('403 Manager only');
    expect(h.invalidateSpy).not.toHaveBeenCalled();
  });
});
