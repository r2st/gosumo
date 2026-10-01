/**
 * Security response headers for the dashboard.
 *
 * The API has had these since the `securityHeaders()` middleware landed; the
 * Next app had none of its own. What it did have was Caddy's site block, which
 * sets `nosniff`, `X-Frame-Options` and HSTS — so the three headers everybody
 * checks for were present and the audit looked clean. The ones that were
 * missing are the ones that matter more here, because unlike the API this
 * origin genuinely serves HTML and runs script: no CSP at all, no
 * `Referrer-Policy` (so dashboard URLs — which carry lead and conversation ids
 * in the path — rode along to every external host a page linked to), and no
 * `Permissions-Policy`.
 *
 * Keeping them here rather than in the Caddyfile is deliberate. Caddy's config
 * lives on the server, outside this repository and outside CI; a header set
 * there is invisible to every test and to anyone reading the app. These are
 * defined in the app, shipped with the build, and asserted in
 * `security-headers.test.ts`. Caddy still sets its three — for those, whichever
 * layer answers last wins and both send the same value, so the overlap is
 * harmless.
 *
 * Written as `.mjs` so `next.config.mjs` can import it directly: Next 14 has no
 * TypeScript config support, and a header list that only exists inside the
 * config object is a header list nothing can test.
 */

/**
 * Browser features the dashboard never asks for.
 *
 * An empty allow-list — `camera=()` — is the deny form. Only listed features
 * are governed, so anything omitted keeps the browser default; there is no
 * wildcard.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

/** One year — the minimum HSTS preload accepts. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * Build the CSP for one environment.
 *
 * **`script-src` keeps `'unsafe-inline'`, and that is a known limit, not an
 * oversight.** `layout.tsx` inlines `themeInitScript` and `langInitScript` in
 * `<head>` to apply the saved theme before first paint, and Next's own
 * hydration bootstrap is inline too. Removing `'unsafe-inline'` means a
 * per-request nonce, which means a `middleware.ts` generating one and a layout
 * reading it — and a nonce forces every page onto dynamic rendering, which is
 * a real change to how this app is served. That is its own piece of work. What
 * this policy does buy, today and without it:
 *
 *  - `object-src 'none'` and `base-uri 'self'` — the two injection primitives
 *    that `'unsafe-inline'` does *not* cover. A `<base>` tag rewrites where
 *    every relative script on the page loads from.
 *  - `frame-ancestors 'none'` — clickjacking, and the modern half of it;
 *    `X-Frame-Options` is the older half and both are sent.
 *  - `form-action 'self'` — an injected form cannot post the session anywhere.
 *  - `connect-src` — an exfiltration channel narrowed to the API this build
 *    actually talks to.
 *
 * `'unsafe-eval'` is added outside production only: React Fast Refresh needs
 * it, and shipping it would undo much of the above.
 *
 * @param {{ apiOrigin?: string, wsOrigin?: string, dev?: boolean }} options
 */
export function buildContentSecurityPolicy({ apiOrigin, wsOrigin, dev = false } = {}) {
  // The API is a different origin in every environment that matters
  // (api.gosumo.aiknol.com in production, :3000 in development), so `'self'`
  // alone would block every fetch the dashboard makes. Sockets need the ws://
  // and wss:// forms of the same host, which `connect-src` treats as distinct
  // schemes.
  const analytics = 'https://analytics.doaide.com';
  const connect = new Set(["'self'", analytics]);
  for (const origin of [apiOrigin, wsOrigin]) {
    if (!origin) continue;
    connect.add(origin);
    connect.add(origin.replace(/^http/, 'ws'));
  }

  const script = dev
    ? `'self' 'unsafe-inline' 'unsafe-eval' ${analytics}`
    : `'self' 'unsafe-inline' ${analytics}`;

  return [
    "default-src 'self'",
    `script-src ${script}`,
    // Tailwind's build output is a stylesheet, but `next/font` injects inline
    // `<style>` for its font-face declarations and React inlines style props.
    "style-src 'self' 'unsafe-inline'",
    // `next.config.mjs` allows remote images from any https host, so the CSP
    // has to as well or configured avatars and catalog images break. `blob:`
    // covers client-side object URLs; `data:` covers inlined icons.
    "img-src 'self' data: blob: https:",
    // `next/font/google` self-hosts at build time, so fonts come from origin.
    "font-src 'self' data:",
    `connect-src ${[...connect].join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
  ].join('; ');
}

/**
 * The full header list for `next.config.mjs`'s `headers()`.
 *
 * HSTS is production-only for the same reason it is in the API: sent over
 * plain http in development it pins the browser to an https port that does not
 * exist, and the remedy is clearing browser state rather than redeploying.
 *
 * @param {{ apiUrl?: string, wsUrl?: string, nodeEnv?: string }} options
 * @returns {{ key: string, value: string }[]}
 */
export function securityHeaders({ apiUrl, wsUrl, nodeEnv } = {}) {
  const dev = (nodeEnv ?? 'development') !== 'production';
  const apiOrigin = toOrigin(apiUrl);
  const wsOrigin = toOrigin(wsUrl);

  const headers = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    // Dashboard paths carry lead, conversation and business ids. `same-origin`
    // rather than `no-referrer` (what the API sends) because the app's own
    // navigation benefits from a referrer and this keeps it in the building.
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
    {
      key: 'Content-Security-Policy',
      value: buildContentSecurityPolicy({ apiOrigin, wsOrigin, dev }),
    },
  ];

  if (!dev) {
    headers.push({
      key: 'Strict-Transport-Security',
      value: `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains; preload`,
    });
  }

  return headers;
}

/**
 * Reduce a configured base URL to the scheme+host+port a CSP source expects.
 *
 * `NEXT_PUBLIC_API_URL` is a base URL and may carry a path or a trailing
 * slash; a CSP source with a path in it matches by path prefix, which is not
 * what is meant here. Anything unparseable yields `undefined` rather than
 * throwing — a malformed env var should narrow the policy, never fail the
 * build.
 */
export function toOrigin(url) {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
