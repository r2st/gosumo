/**
 * `use-voice.ts` — the broker voice-command history feed.
 *
 * One hook, but it sits at the end of a chain the operator cannot otherwise
 * inspect: they dictate "pause follow-ups for Rahul", the command is
 * transcribed, parsed, and either executed or not — and this feed is the only
 * place the outcome is shown. So the two things that matter are that it polls
 * (a command whose result never arrives on screen leaves the broker unsure
 * whether it ran) and that `limit` reaches the query string, since the feed is
 * newest-first and a dropped limit changes what "recent" means.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-voice';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const COMMANDS_KEY = ['realty', 'voice', 'commands'];

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue([]);
  h = createQueryHarness();
});

describe('useVoiceCommands', () => {
  it('requests the documented endpoint with the default limit', async () => {
    const { result } = renderHook(() => hooks.useVoiceCommands(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe('/realty/voice/broker-commands?limit=20');
  });

  it('passes a caller-supplied limit through to the query string', async () => {
    const { result } = renderHook(() => hooks.useVoiceCommands(5), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/realty/voice/broker-commands?limit=5');
  });

  it('passes an abort signal, so leaving the page cancels the request', async () => {
    const { result } = renderHook(() => hooks.useVoiceCommands(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it('polls every minute, so a command’s outcome arrives without a reload', async () => {
    // Transcription and execution are asynchronous. Without the poll the broker
    // dictates an instruction and the feed stays empty, with no way to tell
    // "still processing" from "never ran".
    const { result } = renderHook(() => hooks.useVoiceCommands(), { wrapper: h.wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(h.observerOptions(COMMANDS_KEY)?.refetchInterval).toBe(60_000);
  });

  it('keys the cache on the limit, not just the endpoint', async () => {
    // A compact widget asks for 5 and the full history page for 50, and both
    // are on screen together. A shared key would show the widget's five rows on
    // the history page — so the two must coexist as separate cache entries.
    const widget = renderHook(() => hooks.useVoiceCommands(5), { wrapper: h.wrapper });
    const history = renderHook(() => hooks.useVoiceCommands(50), { wrapper: h.wrapper });

    await waitFor(() => expect(widget.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(history.result.current.isSuccess).toBe(true));

    expect(apiRequest.mock.calls.map((c) => c[0]).sort()).toEqual([
      '/realty/voice/broker-commands?limit=5',
      '/realty/voice/broker-commands?limit=50',
    ]);
    expect(
      h.queryClient
        .getQueryCache()
        .findAll({ queryKey: COMMANDS_KEY })
        .map((q) => q.queryKey),
    ).toEqual([
      [...COMMANDS_KEY, { limit: 5 }],
      [...COMMANDS_KEY, { limit: 50 }],
    ]);
  });

  it('serves a repeat of the same limit from cache', async () => {
    const { result, rerender } = renderHook(
      ({ limit }: { limit: number }) => hooks.useVoiceCommands(limit),
      { wrapper: h.wrapper, initialProps: { limit: 20 } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ limit: 20 });

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('returns the history rows as the API sent them', async () => {
    // The feed is an array, not a paginated envelope — the hook does no
    // unwrapping, so a response shape change would surface here.
    const rows = [
      {
        id: 'vc-1',
        transcription: 'pause follow-ups for Rahul',
        kind: 'PAUSE_CADENCE',
        status: 'executed' as const,
        detail: 'Paused 1 cadence',
        createdAt: '2026-08-14T05:30:00.000Z',
      },
      {
        id: 'vc-2',
        transcription: 'serene heights 2bhk now 94 lakh',
        kind: 'UPDATE_PRICE',
        status: 'unresolved' as const,
        detail: 'No unit matched "2bhk"',
        createdAt: '2026-08-14T05:12:00.000Z',
      },
    ];
    apiRequest.mockResolvedValueOnce(rows);
    const { result } = renderHook(() => hooks.useVoiceCommands(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
  });

  it('renders an empty history without erroring', async () => {
    // A broker who has never dictated anything gets `[]`, which is a legitimate
    // empty state rather than a failure.
    const { result } = renderHook(() => hooks.useVoiceCommands(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('surfaces a failure instead of showing an empty history', async () => {
    // An error rendered as "no commands yet" would tell the broker their
    // instruction never ran, when in fact nobody knows.
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useVoiceCommands(), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
    expect(result.current.data).toBeUndefined();
  });
});
