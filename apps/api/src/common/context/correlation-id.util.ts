/**
 * The correlation id itself — naming, validation, and minting.
 *
 * Kept apart from the middleware and the store because the interesting part is
 * not the plumbing, it is that **an inbound correlation id is untrusted input**
 * and it is treated everywhere as though it were ours: it goes into log lines,
 * into a response header, and (once queues carry it) into a job payload that is
 * logged again on the other side of Redis, minutes later, with no request in
 * sight to attribute it to.
 *
 * That is the whole reason this file validates rather than passes through.
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * The header carried in and out. `x-correlation-id` is what the API already
 * emitted before this module existed, so it stays — changing it would break
 * whatever is already grepping for it.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * `x-request-id` is what Caddy, most load balancers, and most client SDKs
 * generate on their own. Accepting it as a fallback means a request that
 * arrived with a proxy-assigned id keeps that id instead of being given a
 * second, unrelated one — which is the difference between one searchable
 * identifier across the whole hop chain and two that nobody can join.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Upper bound on an accepted inbound id.
 *
 * A UUID is 36. 64 leaves room for the longer trace ids real proxies emit
 * (AWS's `Root=1-...` form, a 32-hex W3C trace-id) without letting a caller
 * decide how many bytes every log line for their request costs. Unbounded, a
 * 1 MB header — comfortably under the body limit, which does not apply to
 * headers — is written to disk twice per request forever.
 */
export const MAX_CORRELATION_ID_LENGTH = 64;

/**
 * The only shape accepted from outside.
 *
 * Deliberately a strict allow-list rather than a "strip the bad characters"
 * pass, because the bad characters are the entire point:
 *
 *   - `\r` and `\n` split a log line. An attacker who can inject them writes
 *     forged entries into the same file the on-call reads during an incident,
 *     attributing their own text to any component they like. Logs are the one
 *     record that survives the request, so forging them is not cosmetic.
 *   - `\x1b` is an ANSI escape. Logs are read in terminals; escapes repaint
 *     and clear the screen, and hide the lines around them.
 *   - Everything else here is defence in depth for whatever reads the logs
 *     next — a shipper that parses `key=value`, a dashboard that renders HTML.
 *
 * A rejected id is not an error: the request simply gets a fresh one. Refusing
 * the request instead would let anyone turn a malformed header into a 400 on a
 * route that has nothing to do with correlation.
 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * The inbound id if it is one we are willing to repeat, otherwise `undefined`.
 *
 * `undefined` rather than a thrown error or a silently-cleaned string, so the
 * caller decides what to do with a bad one — and so a test can tell "absent"
 * from "rejected".
 */
export function sanitizeCorrelationId(value: unknown): string | undefined {
  // Express gives an array when a header appears more than once. Taking the
  // first would let a caller smuggle a second value past a proxy that only
  // inspected one, so the ambiguous case is refused outright.
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_CORRELATION_ID_LENGTH) return undefined;
  if (!CORRELATION_ID_PATTERN.test(trimmed)) return undefined;

  return trimmed;
}

/** A fresh id, for a request that arrived without a usable one. */
export function newCorrelationId(): string {
  return uuidv4();
}

/**
 * The id for this request: the caller's if it survives {@link sanitizeCorrelationId},
 * the proxy's `x-request-id` if that does, otherwise a new one.
 *
 * Takes the two header values rather than the request so it stays a pure
 * function — the branch that matters (accept vs. mint) is then testable
 * without an HTTP layer.
 */
export function resolveCorrelationId(
  correlationHeader: unknown,
  requestIdHeader?: unknown,
): string {
  return (
    sanitizeCorrelationId(correlationHeader) ??
    sanitizeCorrelationId(requestIdHeader) ??
    newCorrelationId()
  );
}
