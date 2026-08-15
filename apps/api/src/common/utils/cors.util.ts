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
 */
export function resolveCorsOrigin(raw: string): string | string[] {
  return raw.includes(',') ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
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
