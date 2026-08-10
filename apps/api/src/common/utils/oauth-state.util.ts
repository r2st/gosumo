import * as crypto from 'crypto';

/**
 * Signed `state` values for outbound OAuth redirects.
 *
 * An OAuth callback is by construction a `@Public()` endpoint: the browser
 * arrives from the provider carrying no session of ours. The only thing telling
 * the callback which tenant the returned authorization code belongs to is the
 * `state` parameter the provider echoes back.
 *
 * If that parameter is the raw `businessId`, the callback is an unauthenticated
 * write keyed by a value anyone can supply. Someone who authorizes their *own*
 * provider account, then replays the resulting code against
 * `?state=<victim businessId>`, binds their account to the victim's tenant —
 * and every subsequent export pushes that tenant's data into storage the
 * attacker controls. Guessing the id is not much of a barrier either; it leaks
 * through any surface that echoes it.
 *
 * So `state` has to be unforgeable and short-lived. These helpers make it an
 * HMAC-SHA256 token over `businessId | issuedAt | nonce`, verified and
 * expiry-checked on the way back. It is deliberately stateless — no store to
 * provision or clean up — which means a token is replayable inside its TTL by
 * whoever already holds it. That is acceptable: holding it requires having
 * started the flow as an authenticated member of that tenant, which is exactly
 * the property the raw-id version lacked.
 */

/** How long a consent redirect stays valid. Long enough to sign in and consent. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  /** businessId */
  b: string;
  /** issued-at, epoch ms */
  t: number;
  /** nonce — makes two states for the same tenant differ */
  n: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(payloadB64: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
}

/**
 * Mint a signed state token carrying `businessId`.
 *
 * @param issuedAt Injectable clock for tests; defaults to now.
 */
export function signOAuthState(
  businessId: string,
  secret: string,
  issuedAt: number = Date.now(),
): string {
  if (!secret) {
    // Minting an unsigned state would silently reintroduce the hole this
    // module exists to close, so refuse rather than degrade.
    throw new Error('Cannot sign an OAuth state without a secret');
  }

  const payload: StatePayload = {
    b: businessId,
    t: issuedAt,
    n: crypto.randomBytes(9).toString('base64url'),
  };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));

  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/**
 * Recover the `businessId` from a state token, or `null` when the token is
 * malformed, forged, or older than `ttlMs`.
 *
 * Never throws — a bad state is an ordinary rejection, not an exception.
 */
export function verifyOAuthState(
  state: string,
  secret: string,
  ttlMs: number = OAUTH_STATE_TTL_MS,
  now: number = Date.now(),
): string | null {
  if (!state || !secret) return null;

  const separator = state.lastIndexOf('.');
  if (separator <= 0) return null;

  const payloadB64 = state.slice(0, separator);
  const signature = state.slice(separator + 1);
  const expected = sign(payloadB64, secret);

  // Compare in constant time, but only once the lengths match — timingSafeEqual
  // throws on a length mismatch, and the length of a hex digest is public.
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return null;
  if (!crypto.timingSafeEqual(given, want)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as StatePayload;
  } catch {
    return null;
  }

  if (typeof payload.b !== 'string' || !payload.b) return null;
  if (typeof payload.t !== 'number' || !Number.isFinite(payload.t)) return null;

  // Reject both stale tokens and ones stamped in the future — a future stamp
  // means the payload was tampered with under a leaked secret, or clocks are
  // far enough apart that the TTL means nothing.
  const age = now - payload.t;
  if (age < 0 || age > ttlMs) return null;

  return payload.b;
}
