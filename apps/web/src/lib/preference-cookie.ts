/**
 * The one place a cookie is written from this app.
 *
 * Only two exist — the theme and the UI language — and both were being written
 * inline with `path`, `max-age` and `samesite=lax` but no `Secure`. On
 * https://gosumo.aiknol.com that is the difference between a cookie that stays
 * on TLS and one a browser will also send in cleartext: a single downgraded
 * request (a plain-http link to the host, a captive portal, a stripped
 * redirect) is enough to put it on the wire, and the same request tells a
 * network observer that this browser has a GoSumo session to go looking for.
 * The value itself is `light`/`dark` — worthless — but the transmission is not,
 * and there is no reason for either cookie to leave TLS.
 *
 * `HttpOnly` is deliberately absent and cannot be added: these are written by
 * `document.cookie` from a client component, and a `HttpOnly` cookie is one
 * the browser refuses to let script write. The protection it buys — keeping a
 * cookie away from XSS — is not applicable to a preference the page already
 * holds in `localStorage` beside it. Session tokens are the case where it
 * matters, and those are not cookies here at all: the access token lives in
 * memory and the refresh token in `token-store.ts`.
 *
 * `SameSite=Lax` rather than `Strict` for the reason the cookie exists. It
 * mirrors `localStorage` so a server pass can read the preference and render
 * the right theme; `Strict` withholds the cookie on exactly the request that
 * needs it — the first top-level navigation in from an external link, which is
 * the one that would flash the wrong theme.
 */

/** A year. Long enough that a preference outlives a browser cleanup cycle. */
export const PREFERENCE_COOKIE_MAX_AGE_SECONDS = 31_536_000;

/**
 * Whether `Secure` may be set on this page's cookies.
 *
 * A `Secure` cookie set over plain http is discarded by the browser, silently
 * — so pinning it on unconditionally would break the preference for anyone
 * running `next dev` on `http://localhost:3001` and leave nothing to see but a
 * theme that will not stick. Browsers exempt `localhost` from that rule in
 * practice, but not `http://192.168.x.x` or a bare LAN hostname, which is how
 * this actually gets tested on a phone. Keying off the live protocol handles
 * every case without a build-time flag.
 */
export function shouldUseSecureCookies(
  protocol: string | undefined = typeof window === 'undefined'
    ? undefined
    : window.location.protocol,
): boolean {
  return protocol === 'https:';
}

/**
 * Serialise a preference cookie. Exported separately from the write so the
 * attribute set is assertable without a DOM.
 */
export function buildPreferenceCookie(
  name: string,
  value: string,
  secure: boolean = shouldUseSecureCookies(),
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'path=/',
    `max-age=${PREFERENCE_COOKIE_MAX_AGE_SECONDS}`,
    'samesite=lax',
  ];
  if (secure) attributes.push('secure');
  return attributes.join('; ');
}

/** Write a preference cookie. No-op during SSR, where there is no document. */
export function writePreferenceCookie(name: string, value: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = buildPreferenceCookie(name, value);
}
