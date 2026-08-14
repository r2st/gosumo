/**
 * Contract tests for the dashboard's API client.
 *
 * This module is the single seam between every screen and the backend, and the
 * parts most worth pinning down are the ones no screen exercises directly: the
 * silent 401 refresh (including its de-duplication and its recursion guard),
 * the error envelope that every `catch` in the app reads, and the pagination
 * shim that bridges the backend's flat page fields to the nested envelope the
 * components expect.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, API_BASE, api, apiRequest, setOnAuthFailure } from './api-client';
import { tokenStore } from './token-store';

/** jsdom runs on an opaque origin, so `localStorage` is missing entirely. */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

/** A minimal `Response` stand-in — only the fields `request()` actually reads. */
function reply(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const fetchMock = vi.fn<typeof fetch>();

/** The options object handed to the Nth `fetch` call. */
function callOptions(n: number): RequestInit {
  return fetchMock.mock.calls[n]?.[1] as RequestInit;
}

function headersOf(n: number): Record<string, string> {
  return (callOptions(n)?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  installLocalStorage();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  tokenStore.clear();
  setOnAuthFailure(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API_BASE', () => {
  it('carries the /v1 version prefix the backend mounts everything under', () => {
    expect(API_BASE).toMatch(/\/v1$/);
  });
});

describe('request headers', () => {
  it('attaches the bearer token when one is stored', async () => {
    tokenStore.setAccessToken('tok-123');
    fetchMock.mockResolvedValueOnce(reply(200, { id: 'b1' }));

    await api.business.me();

    expect(headersOf(0).Authorization).toBe('Bearer tok-123');
  });

  it('omits the bearer header on public endpoints even when a token exists', async () => {
    tokenStore.setAccessToken('tok-123');
    fetchMock.mockResolvedValueOnce(reply(200, { requiresMfa: false }));

    await api.auth.login('a@b.com', 'pw');

    expect(headersOf(0).Authorization).toBeUndefined();
  });

  it('omits the bearer header when authenticated but no token is held yet', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {}));

    await api.business.me();

    expect(headersOf(0).Authorization).toBeUndefined();
  });

  it('sets Content-Type only when there is a body to type', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await api.business.me();
    expect(headersOf(0)['Content-Type']).toBeUndefined();
    expect(callOptions(0).body).toBeUndefined();

    fetchMock.mockResolvedValueOnce(reply(200, {}));
    await api.conversations.reopen('c1');
    expect(headersOf(1)['Content-Type']).toBe('application/json');
  });
});

describe('response handling', () => {
  it('returns undefined for a 204 without trying to parse a body', async () => {
    tokenStore.setAccessToken('tok');
    fetchMock.mockResolvedValueOnce(reply(204));

    await expect(api.auth.logout('refresh')).resolves.toBeUndefined();
  });

  it('returns undefined for a 200 with an empty body', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, ''));

    await expect(apiRequest('/anything')).resolves.toBeUndefined();
  });

  it('passes a non-JSON success body through as raw text', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, 'plain text'));

    await expect(apiRequest('/anything')).resolves.toBe('plain text');
  });

  it('raises the error envelope as an ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(422, { error: 'VALIDATION_ERROR', message: 'name is required' }),
    );

    const err = await apiRequest('/anything').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'name is required',
      name: 'ApiError',
    });
    expect((err as ApiError).body).toEqual({
      error: 'VALIDATION_ERROR',
      message: 'name is required',
    });
  });

  it('falls back to a generic code and message when the body is not an envelope', async () => {
    fetchMock.mockResolvedValueOnce(reply(500, '<html>gateway</html>'));

    const err = (await apiRequest('/anything').catch((e: unknown) => e)) as ApiError;

    expect(err.code).toBe('ERROR');
    expect(err.message).toBe('Request failed with status 500');
  });

  it('falls back on an error response with no body at all', async () => {
    fetchMock.mockResolvedValueOnce(reply(502));

    const err = (await apiRequest('/anything').catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(502);
    expect(err.code).toBe('ERROR');
  });

  it('reports an unreachable API as a NETWORK_ERROR rather than leaking the fetch failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const err = (await apiRequest('/anything').catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('NETWORK_ERROR');
  });

  it('rethrows an abort untouched, so React Query can tell it from a real failure', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abort);

    const err = await apiRequest('/anything').catch((e: unknown) => e);

    expect(err).toBe(abort);
    expect(err).not.toBeInstanceOf(ApiError);
  });
});

describe('401 refresh', () => {
  it('refreshes once and replays the original request with the new token', async () => {
    tokenStore.setAccessToken('stale');
    tokenStore.setRefreshToken('refresh-1');

    fetchMock
      .mockResolvedValueOnce(reply(401, { error: 'UNAUTHORIZED', message: 'expired' }))
      .mockResolvedValueOnce(reply(200, { accessToken: 'fresh', refreshToken: 'refresh-2' }))
      .mockResolvedValueOnce(reply(200, { id: 'b1' }));

    await expect(api.business.me()).resolves.toEqual({ id: 'b1' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${API_BASE}/auth/refresh`);
    expect(headersOf(2).Authorization).toBe('Bearer fresh');
    expect(tokenStore.getRefreshToken()).toBe('refresh-2');
  });

  it('keeps the existing refresh token when the refresh response rotates only the access token', async () => {
    tokenStore.setAccessToken('stale');
    tokenStore.setRefreshToken('refresh-1');

    fetchMock
      .mockResolvedValueOnce(reply(401, {}))
      .mockResolvedValueOnce(reply(200, { accessToken: 'fresh' }))
      .mockResolvedValueOnce(reply(200, { id: 'b1' }));

    await api.business.me();

    expect(tokenStore.getRefreshToken()).toBe('refresh-1');
    expect(tokenStore.getAccessToken()).toBe('fresh');
  });

  it('retries at most once — a second 401 surfaces instead of looping', async () => {
    tokenStore.setAccessToken('stale');
    tokenStore.setRefreshToken('refresh-1');
    const onFailure = vi.fn();
    setOnAuthFailure(onFailure);

    fetchMock
      .mockResolvedValueOnce(reply(401, {}))
      .mockResolvedValueOnce(reply(200, { accessToken: 'fresh' }))
      .mockResolvedValueOnce(reply(401, { error: 'UNAUTHORIZED', message: 'still no' }));

    const err = (await api.business.me().catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The replay is the terminal attempt; it must not trigger another refresh.
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('signals auth failure without calling refresh when no refresh token is stored', async () => {
    tokenStore.setAccessToken('stale');
    const onFailure = vi.fn();
    setOnAuthFailure(onFailure);

    fetchMock.mockResolvedValueOnce(reply(401, { error: 'UNAUTHORIZED', message: 'nope' }));

    await expect(api.business.me()).rejects.toBeInstanceOf(ApiError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('clears the session and signals failure when the refresh itself is rejected', async () => {
    tokenStore.setAccessToken('stale');
    tokenStore.setRefreshToken('revoked');
    const onFailure = vi.fn();
    setOnAuthFailure(onFailure);

    fetchMock.mockResolvedValueOnce(reply(401, {})).mockResolvedValueOnce(reply(401, {}));

    await expect(api.business.me()).rejects.toBeInstanceOf(ApiError);

    expect(tokenStore.getAccessToken()).toBeNull();
    expect(tokenStore.getRefreshToken()).toBeNull();
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('signals failure when the refresh call cannot reach the network', async () => {
    tokenStore.setAccessToken('stale');
    tokenStore.setRefreshToken('refresh-1');
    const onFailure = vi.fn();
    setOnAuthFailure(onFailure);

    fetchMock
      .mockResolvedValueOnce(reply(401, {}))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(api.business.me()).rejects.toBeInstanceOf(ApiError);

    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('de-dupes concurrent refreshes into a single /auth/refresh call', async () => {
    tokenStore.setAccessToken('stale');
    tokenStore.setRefreshToken('refresh-1');

    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        await refreshGate;
        return reply(200, { accessToken: 'fresh' });
      }
      // Every protected call 401s until the access token has been rotated.
      return tokenStore.getAccessToken() === 'fresh' ? reply(200, { ok: true }) : reply(401, {});
    });

    const inflight = Promise.all([apiRequest('/a'), apiRequest('/b'), apiRequest('/c')]);
    // Let all three reach their 401 and queue behind the same refresh.
    await Promise.resolve();
    releaseRefresh?.();

    await expect(inflight).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }]);

    const refreshCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });

  it('does not attempt a refresh for a 401 on a public endpoint', async () => {
    tokenStore.setRefreshToken('refresh-1');
    const onFailure = vi.fn();
    setOnAuthFailure(onFailure);

    fetchMock.mockResolvedValueOnce(
      reply(401, { error: 'INVALID_CREDENTIALS', message: 'Wrong password' }),
    );

    const err = (await api.auth.login('a@b.com', 'wrong').catch((e: unknown) => e)) as ApiError;

    expect(err.code).toBe('INVALID_CREDENTIALS');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('pagination bridging', () => {
  it('wraps the backend flat page fields into the nested envelope the UI reads', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { data: [{ id: 'c1' }], total: 42, page: 1, limit: 20, totalPages: 3 }),
    );

    const res = await api.clients.list();

    expect(res.data).toEqual([{ id: 'c1' }]);
    expect(res.pagination).toEqual({
      total: 42,
      limit: 20,
      page: 1,
      totalPages: 3,
      hasMore: true,
    });
  });

  it('reports hasMore false on the last page', async () => {
    fetchMock.mockResolvedValueOnce(
      reply(200, { data: [], total: 2, page: 3, limit: 20, totalPages: 3 }),
    );

    const res = await api.clients.list();

    expect(res.pagination.hasMore).toBe(false);
  });

  it('defaults every page field when the backend sends only rows', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {}));

    const res = await api.clients.list();

    expect(res.data).toEqual([]);
    expect(res.pagination).toEqual({
      total: 0,
      limit: 20,
      page: 1,
      totalPages: 1,
      hasMore: false,
    });
  });

  it('passes an already-nested envelope through untouched', async () => {
    const envelope = {
      data: [{ id: 'c1' }],
      pagination: { total: 1, limit: 20, page: 1, totalPages: 1, hasMore: false },
    };
    fetchMock.mockResolvedValueOnce(reply(200, envelope));

    await expect(api.clients.list()).resolves.toEqual(envelope);
  });
});

describe('endpoint construction', () => {
  it('serializes filters into the query string and drops empty ones', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { data: [], pagination: {} }));

    await api.conversations.list({ status: 'OPEN', q: '', page: 2 });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${API_BASE}/conversations?status=OPEN&page=2`,
    );
  });

  it('joins array filters with commas', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {}));

    await api.conversations.get('c1', ['messages', 'client']);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${API_BASE}/conversations/c1?include=messages%2Cclient`,
    );
  });

  it('sends an outbound message in the normalized TEXT content shape', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: 'm1' }));

    await api.conversations.sendMessage('c1', 'hello');

    expect(callOptions(0).method).toBe('POST');
    expect(JSON.parse(callOptions(0).body as string)).toEqual({
      content: { type: 'TEXT', text: 'hello' },
    });
  });

  it('points the Google OAuth redirect at the versioned API root', () => {
    expect(api.auth.googleUrl()).toBe(`${API_BASE}/auth/google`);
  });
});
