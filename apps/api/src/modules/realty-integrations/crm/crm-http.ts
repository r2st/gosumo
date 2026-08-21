/**
 * Minimal JSON HTTP helper shared by the CRM adapters. No SDK dependency,
 * consistent with the Razorpay/Stripe services. Never throws on non-2xx; the
 * caller inspects `ok`.
 *
 * These URLs are the least trustworthy in the platform: the destination is a
 * tenant-configured webhook on a host GoSumo does not run, reached from a
 * BullMQ worker. A host that accepts the connection and then stalls would hold
 * a concurrency slot indefinitely, so the deadline is not optional here.
 */
import { Logger } from '@nestjs/common';

import { fetchWithTimeout } from '../../../common/utils/http-timeout.util';

export interface JsonHttpResponse {
  ok: boolean;
  status: number;
  body: unknown;
  /** How many attempts it took. 1 when it succeeded first time. */
  attempts: number;
}

/** Total attempts, including the first. */
export const CRM_MAX_ATTEMPTS = 3;

/** Base backoff in ms; doubled per attempt (500ms, 1000ms). */
export const CRM_RETRY_BASE_MS = 500;

/**
 * Statuses worth a second attempt.
 *
 * Deliberately narrow, and the omissions matter more than the entries.
 *
 * A CRM lead push is **not idempotent**: the destination creates a lead record,
 * and a blind retry of a request that actually succeeded gives the customer's
 * sales team the same lead twice. Duplicate leads in a CRM are worse than a
 * missed push — a missed push is visible as `realty.crm.push_failed` and can be
 * re-driven, while a duplicate is silent and lands in someone's call list.
 *
 * So this retries only where the request provably did **not** reach the
 * application:
 *
 *  - **429** — the rate limiter rejected it before any processing.
 *  - **502 / 503 / 504** — the gateway never got a usable answer from the
 *    origin, or explicitly says it is unavailable.
 *
 * And not:
 *
 *  - **500** — the origin ran the request and then failed. It may well have
 *    created the lead before failing.
 *  - **A timeout or transport error** — the most ambiguous case of all. The
 *    bytes were sent; whether they were processed is unknowable from here.
 *    These stay a single attempt and surface as a failure the operator can
 *    re-drive deliberately.
 *
 * 4xx other than 429 is a bad payload or bad credentials, which a re-run
 * reproduces exactly.
 */
export const CRM_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

const logger = new Logger('CrmHttp');

/**
 * Honour `Retry-After` when the provider sends one, capped.
 *
 * A provider that says "wait 3600" is telling us the quota is gone for the
 * hour; sleeping that long inside a worker would hold the slot for an hour and
 * is never the right answer here. The cap turns the header into a hint rather
 * than an instruction, and the push falls back to the queue's own retry.
 */
const RETRY_AFTER_CAP_MS = 5_000;

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;

  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    // `unref` so a pending backoff never holds the process open during
    // shutdown — the send is already lost at that point, and the queue owns
    // the retry.
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonHttpResponse> {
  const serialised = JSON.stringify(body);
  let last: JsonHttpResponse | null = null;

  for (let attempt = 1; attempt <= CRM_MAX_ATTEMPTS; attempt += 1) {
    // A transport failure or timeout is *not* caught and retried here — see
    // CRM_RETRYABLE_STATUSES on why an ambiguous send must not be repeated.
    // It propagates to the adapter, which reports it as a failed push.
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: serialised,
      },
      { service: 'CRM webhook' },
    );

    let parsed: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    last = { ok: res.ok, status: res.status, body: parsed, attempts: attempt };

    if (res.ok || !CRM_RETRYABLE_STATUSES.has(res.status)) {
      if (res.ok && attempt > 1) {
        logger.log(`CRM webhook succeeded on attempt ${attempt}`);
      }
      return last;
    }

    if (attempt === CRM_MAX_ATTEMPTS) break;

    const delay = retryAfterMs(res) ?? CRM_RETRY_BASE_MS * 2 ** (attempt - 1);
    logger.warn(
      `CRM webhook responded ${res.status}; retrying in ${delay}ms ` +
        `(attempt ${attempt} of ${CRM_MAX_ATTEMPTS})`,
    );
    await sleep(delay);
  }

  // Unreachable with CRM_MAX_ATTEMPTS >= 1; the assertion keeps the return
  // type honest rather than widening it to `| null` for a case that cannot
  // happen.
  /* istanbul ignore next */
  if (!last) throw new Error('CRM webhook made no attempt');
  return last;
}
