import { describe, expect, it } from 'vitest';
import {
  buildPreferenceCookie,
  PREFERENCE_COOKIE_MAX_AGE_SECONDS,
  shouldUseSecureCookies,
  writePreferenceCookie,
} from './preference-cookie';

/** Parse a serialised cookie into its lowercased attribute set. */
function attributes(cookie: string): string[] {
  return cookie
    .split('; ')
    .slice(1)
    .map((a) => a.toLowerCase());
}

describe('buildPreferenceCookie', () => {
  it('marks the cookie Secure over https', () => {
    expect(attributes(buildPreferenceCookie('gosumo-theme', 'dark', true))).toContain(
      'secure',
    );
  });

  it('omits Secure over http, where the browser would discard the cookie', () => {
    // A Secure cookie set over plain http is dropped silently — pinning it on
    // unconditionally breaks the preference for anyone running the dev server
    // on a LAN address, with nothing to see but a theme that will not stick.
    expect(attributes(buildPreferenceCookie('gosumo-theme', 'dark', false))).not.toContain(
      'secure',
    );
  });

  it('keeps SameSite=Lax, which is what an SSR pass needs', () => {
    // Strict withholds the cookie on the first top-level navigation in from an
    // external link — the one request that would otherwise flash the wrong
    // theme. Lax is the reason the cookie exists at all.
    expect(attributes(buildPreferenceCookie('gosumo-lang', 'hi'))).toContain(
      'samesite=lax',
    );
  });

  it('scopes the cookie to the whole app', () => {
    expect(attributes(buildPreferenceCookie('gosumo-lang', 'hi'))).toContain('path=/');
  });

  it('persists for a year', () => {
    expect(attributes(buildPreferenceCookie('gosumo-lang', 'hi'))).toContain(
      `max-age=${PREFERENCE_COOKIE_MAX_AGE_SECONDS}`,
    );
  });

  it('encodes the value so a stray ; cannot forge an attribute', () => {
    const cookie = buildPreferenceCookie('gosumo-theme', 'dark; domain=evil.test', false);

    expect(attributes(cookie)).not.toContain('domain=evil.test');
    expect(cookie.startsWith('gosumo-theme=dark%3B')).toBe(true);
  });

  it('puts the name=value pair first, as cookie syntax requires', () => {
    expect(buildPreferenceCookie('gosumo-theme', 'light').split('; ')[0]).toBe(
      'gosumo-theme=light',
    );
  });
});

describe('shouldUseSecureCookies', () => {
  it.each([
    ['https:', true],
    ['http:', false],
    [undefined, false],
  ])('returns %s → %s', (protocol, expected) => {
    expect(shouldUseSecureCookies(protocol)).toBe(expected);
  });
});

describe('writePreferenceCookie', () => {
  it('writes through to document.cookie', () => {
    writePreferenceCookie('gosumo-theme', 'dark');

    expect(document.cookie).toContain('gosumo-theme=dark');
  });

  it('is a no-op with no document, so SSR does not throw', () => {
    const original = globalThis.document;
    // @ts-expect-error — deliberately simulating the server environment.
    delete globalThis.document;

    try {
      expect(() => writePreferenceCookie('gosumo-lang', 'hi')).not.toThrow();
    } finally {
      globalThis.document = original;
    }
  });
});
