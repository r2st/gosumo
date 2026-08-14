/**
 * Resolving the caller's IP address behind a reverse proxy.
 *
 * This API runs behind Caddy in production, so `req.ip` is the proxy's own
 * address on every request — useless both for session records and, more
 * importantly, for anything that rations requests per caller. The real client
 * is the *first* entry of `X-Forwarded-For`; the entries after it are the
 * proxies the request passed through.
 *
 * The header is client-supplied and therefore forgeable. That is tolerable
 * here because the trusted proxy in front of this app appends the real peer
 * address rather than passing through what the client sent, and because the
 * fallback (`req.ip`) is strictly worse: it collapses every caller onto one
 * bucket. Treat the result as a best-effort grouping key, not as proof of
 * identity — nothing authenticates on it.
 */

/** The subset of an Express request this helper needs. */
export interface IpBearingRequest {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

/**
 * The caller's IP, or `null` when nothing in the request reveals one.
 *
 * Express may hand back `X-Forwarded-For` as a string (`"a, b, c"`) or, when
 * the header appears more than once, as an array — both shapes are normalised
 * to the first non-empty entry.
 */
export function clientIp(req: IpBearingRequest): string | null {
  const forwarded = req.headers?.['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;

  const fromHeader = first
    ?.split(',')
    .map((s) => s.trim())
    .find((s) => s.length > 0);

  return fromHeader ?? req.ip ?? req.socket?.remoteAddress ?? null;
}
