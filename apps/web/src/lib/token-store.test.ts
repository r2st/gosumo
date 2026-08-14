/**
 * Token store.
 *
 * The security property this module exists to hold is that the **access token
 * never touches localStorage** — it lives in a module-scoped variable so an XSS
 * payload cannot read it back out of persistent storage. That is invisible in
 * review and easy to undo, so it is asserted directly here.
 *
 * The refresh token is deliberately persisted (mirroring the HttpOnly cookie in
 * production) so a reload can bootstrap a session in local development.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { tokenStore } from './token-store';

const REFRESH_KEY = 'gosumo.refreshToken';

/** jsdom runs on an opaque origin, so `localStorage` is missing entirely. */
function installLocalStorage(): Map<string, string> {
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
  return store;
}

let backing: Map<string, string>;

beforeEach(() => {
  backing = installLocalStorage();
  tokenStore.clear();
});

describe('access token', () => {
  it('starts empty', () => {
    expect(tokenStore.getAccessToken()).toBeNull();
  });

  it('round-trips in memory', () => {
    tokenStore.setAccessToken('access-1');

    expect(tokenStore.getAccessToken()).toBe('access-1');
  });

  it('is never written to localStorage', () => {
    tokenStore.setAccessToken('access-1');

    // The whole point of the in-memory store: nothing persistent holds it.
    expect([...backing.values()]).not.toContain('access-1');
    expect(backing.size).toBe(0);
  });

  it('can be cleared on its own', () => {
    tokenStore.setAccessToken('access-1');
    tokenStore.setAccessToken(null);

    expect(tokenStore.getAccessToken()).toBeNull();
  });

  it('overwrites rather than accumulating', () => {
    tokenStore.setAccessToken('access-1');
    tokenStore.setAccessToken('access-2');

    expect(tokenStore.getAccessToken()).toBe('access-2');
  });
});

describe('refresh token', () => {
  it('starts empty', () => {
    expect(tokenStore.getRefreshToken()).toBeNull();
  });

  it('persists under the namespaced key so a reload can bootstrap', () => {
    tokenStore.setRefreshToken('refresh-1');

    expect(tokenStore.getRefreshToken()).toBe('refresh-1');
    expect(backing.get(REFRESH_KEY)).toBe('refresh-1');
  });

  it('removes the key entirely when set to null, rather than storing "null"', () => {
    tokenStore.setRefreshToken('refresh-1');
    tokenStore.setRefreshToken(null);

    expect(tokenStore.getRefreshToken()).toBeNull();
    expect(backing.has(REFRESH_KEY)).toBe(false);
  });

  it('treats an empty-string token as a removal', () => {
    tokenStore.setRefreshToken('refresh-1');
    tokenStore.setRefreshToken('');

    expect(tokenStore.getRefreshToken()).toBeNull();
  });
});

describe('clear', () => {
  it('drops both tokens', () => {
    tokenStore.setAccessToken('access-1');
    tokenStore.setRefreshToken('refresh-1');

    tokenStore.clear();

    expect(tokenStore.getAccessToken()).toBeNull();
    expect(tokenStore.getRefreshToken()).toBeNull();
    expect(backing.has(REFRESH_KEY)).toBe(false);
  });

  it('is safe to call when nothing is stored', () => {
    expect(() => tokenStore.clear()).not.toThrow();
  });
});

describe('server-side rendering', () => {
  /**
   * Next.js renders these modules on the server, where there is no `window`.
   * The refresh-token accessors must no-op instead of throwing, or the whole
   * page fails to render.
   */
  it('reads null and swallows writes when window is undefined', () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error — deliberately simulating the server environment.
    delete globalThis.window;

    try {
      expect(tokenStore.getRefreshToken()).toBeNull();
      expect(() => tokenStore.setRefreshToken('refresh-1')).not.toThrow();
      expect(() => tokenStore.clear()).not.toThrow();
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it('still keeps the access token in memory on the server', () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error — deliberately simulating the server environment.
    delete globalThis.window;

    try {
      tokenStore.setAccessToken('access-1');
      expect(tokenStore.getAccessToken()).toBe('access-1');
    } finally {
      globalThis.window = originalWindow;
    }
  });
});
