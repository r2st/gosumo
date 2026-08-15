/**
 * How an allow-list env var becomes a CORS configuration.
 *
 * Two surfaces need this and they need it to agree: the REST API (whose
 * allow-list is the dashboard origin) and the web-chat socket (whose
 * allow-list is every site a customer has embedded the widget on, which in
 * practice starts as "anywhere"). The rule that matters is the same for both,
 * so it lives here rather than being written twice with one of the copies
 * eventually drifting.
 */

/**
 * Parse a comma-separated allow-list. A single value is passed through, so an
 * unset var still means `*`.
 *
 * Every value is trimmed and empties are dropped, including the single-value
 * case. Two env spellings depend on it. `CORS_ORIGIN=` — set but empty, which
 * is what a half-filled `.env` template leaves behind — is a string, so `??`
 * never substitutes the default and the raw value reached the CORS layer as
 * `''`; the `cors` package treats *any* falsy origin as the wildcard, so that
 * silently became `Access-Control-Allow-Origin: *` while `allowCredentials`
 * saw a non-wildcard string and turned credentials on: the one pairing this
 * file exists to prevent, arrived at through the back door. It also skipped
 * the production warning in `main.ts`, which only recognises a literal `*`.
 * `CORS_ORIGIN=" https://app.example "` had the milder version of the same
 * problem — an untrimmed origin never string-equals a real `Origin` header, so
 * every cross-origin request was refused with the allow-list looking correct.
 *
 * Normalising to `*` here rather than throwing keeps the fallback in one
 * place: the caller's wildcard branch already warns and drops credentials.
 */
export function resolveCorsOrigin(raw: string): string | string[] {
  const origins = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) return '*';
  return origins.length === 1 ? (origins[0] as string) : origins;
}

/**
 * Whether credentialed cross-origin requests may be allowed.
 *
 * `Access-Control-Allow-Origin: *` together with
 * `Access-Control-Allow-Credentials: true` is the one combination the CORS
 * spec forbids outright: a browser rejects the response instead of relaxing
 * either half, so advertising it does not loosen anything — it breaks every
 * credentialed request while still telling every origin it may try. The
 * wildcard is only ever a convenience for a surface that genuinely has no
 * fixed origin, so when it is in effect credentials come off rather than the
 * origin being narrowed.
 */
export function allowCredentials(origin: string | string[]): boolean {
  return origin !== '*';
}

/** Both halves of the decision for one env var, in the shape CORS options take. */
export function corsOptionsFor(raw: string): {
  origin: string | string[];
  credentials: boolean;
} {
  const origin = resolveCorsOrigin(raw);
  return { origin, credentials: allowCredentials(origin) };
}
