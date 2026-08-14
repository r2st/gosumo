/**
 * Webhook dead-letter queue — shared knobs.
 *
 * Everything the retry policy depends on lives here so the backoff curve can be
 * reasoned about (and tuned) in one place rather than being spread across the
 * service, the processor, and their tests.
 */

/** BullMQ queue that carries webhook retry jobs. */
export const WEBHOOK_DLQ_QUEUE = 'webhook-dlq';

export const WEBHOOK_DLQ_JOBS = {
  RETRY: 'webhook.retry',
  SWEEP: 'webhook.sweep',
} as const;

/**
 * The recovery sweep runs every five minutes — often enough that a retry lost
 * with its Redis job is delayed by minutes rather than forgotten, rare enough
 * that the query (one index scan on `[status, next_retry_at]`) is free.
 */
export const WEBHOOK_DLQ_SWEEP_CRON = '*/5 * * * *';

/** Stable id so re-registering on every deploy never stacks the schedule. */
export const WEBHOOK_DLQ_SWEEP_JOB_ID = 'webhook-dlq-sweep';

/**
 * Total delivery attempts before an entry is DISCARDED, counting the original
 * live delivery as attempt 1. With the curve below that spans ~2h of retries,
 * which comfortably outlasts a rolling deploy or a brief gateway outage.
 */
export const WEBHOOK_MAX_ATTEMPTS = 6;

/** First retry delay. Doubles per attempt. */
export const WEBHOOK_RETRY_BASE_MS = 30_000;

/** Ceiling on any single backoff, so attempt 6 does not land tomorrow. */
export const WEBHOOK_RETRY_MAX_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Delay before retry `attempt` (1 = the first retry, i.e. after the live
 * delivery failed once): 30s, 1m, 2m, 4m, 8m … capped at one hour.
 *
 * Deterministic on purpose. Jitter matters when thousands of clients retry the
 * *same* upstream at once; here each entry is an independent provider event
 * that already arrived at its own moment, so spreading them buys nothing and
 * costs a test that can assert the schedule.
 */
export function webhookRetryBackoffMs(attempt: number): number {
  const step = Math.max(1, Math.floor(attempt));
  // 2 ** 30 * 30s already overflows past the cap; clamp the exponent so a
  // nonsense attempt number cannot produce Infinity.
  const exponent = Math.min(step - 1, 30);
  return Math.min(WEBHOOK_RETRY_MAX_BACKOFF_MS, WEBHOOK_RETRY_BASE_MS * 2 ** exponent);
}

/** Backlog depth (PENDING entries, all tenants) at which readiness degrades. */
export const WEBHOOK_DLQ_DEPTH_WARN = 25;
/** Backlog depth at which readiness fails outright. */
export const WEBHOOK_DLQ_DEPTH_FAIL = 100;

/** Domain events emitted as an entry moves through the queue. */
export const WEBHOOK_DLQ_EVENTS = {
  CAPTURED: 'webhook.deadletter.captured',
  REPLAYED: 'webhook.deadletter.replayed',
  DISCARDED: 'webhook.deadletter.discarded',
  RESOLVED: 'webhook.deadletter.resolved',
} as const;
