/**
 * Queue, schedule and bounds for the SLA breach sweep.
 */

export const SLA_QUEUE = 'sla';

export const SLA_JOBS = {
  BREACH_SWEEP: 'sla-breach-sweep',
} as const;

/** Stable jobId, so a redeploy converges instead of accumulating schedules. */
export const SLA_SWEEP_REPEAT_JOB_ID = 'sla:breach-sweep:periodic';

/**
 * Every five minutes.
 *
 * Breach detection is otherwise event-driven: a tracker is checked when
 * `message.sent` or `conversation.resolved` fires. The case that has no
 * triggering event is the one that matters most — a conversation nobody ever
 * answers — and for it the sweep *is* the detection, not a backstop. So the
 * interval is the resolution of the breach clock: an SLA of 15 minutes
 * detected hourly would report breaches up to an hour late, which is too late
 * to act on. Five minutes is well inside the shortest target a business is
 * likely to set, and the sweep is one indexed query per tenant that has work.
 */
export const SLA_SWEEP_CRON = '*/5 * * * *';

/**
 * Most tenants one sweep will visit.
 *
 * The sweep runs every five minutes, so it does not need to drain the platform
 * in one pass — but it must not silently stop either. `sweepAll` reports the
 * businesses it did not reach, and the processor logs that at warn.
 */
export const SLA_SWEEP_MAX_BUSINESSES = 200;
