/**
 * A deadline for every outbound HTTP call.
 *
 * Node's global `fetch` has no timeout. Undici will wait for headers
 * indefinitely, and — separately — will wait indefinitely *between* body
 * chunks once headers have arrived. Neither is hypothetical: a provider that
 * accepts the connection and then stalls (an overloaded Meta edge, a Twilio
 * region failing over, a customer's own CRM webhook host) leaves the awaiting
 * task parked forever. In the API that pins a request; in a BullMQ worker it
 * pins a concurrency slot, and the job never fails so it never retries — the
 * queue just quietly loses throughput until the pod is restarted.
 *
 * Two properties matter here and both are deliberate:
 *
 *  - **The deadline covers the whole exchange, not just the headers.** The
 *    timer is armed before the call and is *not* cleared when `fetch` resolves,
 *    because at that moment only the headers have arrived. Leaving it armed is
 *    what bounds `response.json()` / `response.arrayBuffer()` as well. It is
 *    `unref()`ed so a pending deadline never holds the process open at
 *    shutdown, and once the body is fully read the abort is a no-op.
 *
 *    The corollary is that `timeoutMs` must be sized for the *transfer*, not
 *    just the round trip — which is why media transfers take
 *    {@link MEDIA_HTTP_TIMEOUT_MS} rather than the default.
 *
 *  - **A timeout is a typed, retryable failure.** An aborted `fetch` rejects
 *    with a bare `AbortError` that reaches the exception filter as an
 *    unclassified 500 and reaches a BullMQ consumer with no retry hint. This
 *    helper converts it to {@link HttpTimeoutError} — an `ExternalServiceError`
 *    carrying the provider name, HTTP 502 semantics, and `retryable: true`.
 *
 * Callers with their own retry or breaker policy — the LLM client, say — still
 * route through here and simply pass a shorter `timeoutMs`; what they own is
 * what to do about a timeout, not how to detect one.
 */

import { ExternalServiceError } from '@gosumo/shared';

/**
 * Deadline for a JSON API call — payments, channel sends, Qdrant, CRM
 * webhooks. Long enough for a slow-but-alive provider, short enough that a
 * stalled one fails inside a single BullMQ attempt rather than across several.
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/**
 * Deadline for a binary transfer — media up/downloads and audio fetched for
 * transcription. A WhatsApp video on a slow link is legitimately slow, and
 * because the deadline spans the body read a 10s budget would abort healthy
 * transfers.
 */
export const MEDIA_HTTP_TIMEOUT_MS = 30_000;

/** An outbound call that exceeded its deadline. Always worth retrying. */
export class HttpTimeoutError extends ExternalServiceError {
  constructor(service: string, readonly timeoutMs: number, url?: string) {
    super(service, `request timed out after ${timeoutMs}ms`, {
      status: 504,
      retryable: true,
      context: { timeoutMs, url },
    });
  }
}

export interface FetchTimeoutOptions {
  /** Provider name, used in the thrown error. E.g. `'Stripe'`. */
  service: string;
  /** Whole-exchange deadline. Defaults to {@link DEFAULT_HTTP_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * `fetch` with a deadline covering both the response and its body.
 *
 * Drop-in for `fetch(url, init)`. Honours an `init.signal` supplied by the
 * caller: whichever of the two aborts first wins, and a caller-driven abort
 * still surfaces as an `AbortError` rather than being mislabelled a timeout.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  options: FetchTimeoutOptions,
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const controller = new AbortController();

  // Built up front so the identity comparison below distinguishes *our* abort
  // from the caller's, and so the stack points at the call site, not the timer.
  const timeout = new HttpTimeoutError(options.service, timeoutMs, redactUrl(url));

  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  // `setTimeout` is typed as returning a number under the DOM lib and a
  // `Timeout` under @types/node; only the latter can be unref'ed.
  (timer as unknown as { unref?: () => void }).unref?.();

  const callerSignal = init.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason), {
        once: true,
      });
    }
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Only the failure path clears the timer: on success the body is still
    // unread and the deadline is what bounds reading it.
    clearTimeout(timer);
    if (controller.signal.reason === timeout) throw timeout;
    throw err;
  }
}

/**
 * Origin and path only. Query strings on these URLs carry API keys and
 * signatures for some providers, and the error's `context` reaches the logs.
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[unparseable url]';
  }
}
