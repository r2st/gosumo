import { AiQualityBucket } from '@prisma/client';

/**
 * Constants for the AI response-quality rollup.
 */

/** Bull queue driving the scheduled rollup. Shares nothing with the AI pipeline. */
export const AI_QUALITY_QUEUE = 'ai-quality';

export const AI_QUALITY_JOBS = {
  /** Roll up every closed hour bucket that has not been computed yet. */
  ROLLUP: 'ai-quality-rollup',
} as const;

/** Stable repeatable-job id so a redeploy replaces the schedule, never adds one. */
export const AI_QUALITY_REPEAT_JOB_ID = 'ai-quality:rollup:hourly';

/**
 * Ten past the hour, hourly.
 *
 * Not on the hour: a decision started at 10:59:58 writes its row a second or
 * two into the next hour, and a rollup that fires at 11:00:00 races it. The
 * bucket would be computed short and — because the job upserts and then never
 * revisits a computed bucket — stay short. Ten minutes is far past any single
 * pipeline run (`JOB_TIMEOUT_MS` is 5 minutes) so the window is closed for
 * real by the time it is counted.
 */
export const AI_QUALITY_ROLLUP_CRON = '10 * * * *';

/**
 * How many closed hour buckets one tick will compute, newest-first.
 *
 * A tick normally has exactly one bucket to do. The backlog exists so an API
 * that was down for a day catches up on its own rather than leaving a hole in
 * the series that nothing ever fills — and it is capped so the catch-up cannot
 * turn into a run that outlives its job timeout.
 */
export const AI_QUALITY_MAX_BUCKETS_PER_RUN = 48;

/**
 * Wall-clock budget for one rollup tick, in ms. Below `JOB_TIMEOUT_MS` (5 min)
 * so the run ends by returning a result instead of being killed mid-bucket.
 */
export const AI_QUALITY_RUN_BUDGET_MS = 4 * 60 * 1000;

/**
 * Daily rollups are derived from the hour rows rather than re-scanning
 * `ai_decisions`, except for the percentiles — see
 * {@link AiQualityRepository.rollupBucket}.
 */
export const AI_QUALITY_BUCKETS: AiQualityBucket[] = [
  AiQualityBucket.HOUR,
  AiQualityBucket.DAY,
];

/** Number of confidence histogram buckets. Deciles: [0,0.1) … [0.9,1.0]. */
export const CONFIDENCE_DECILES = 10;

/**
 * Default lookback for the read API when a caller supplies no window, in days.
 * A week is the shortest span in which a shifted override rate is a trend
 * rather than a busy afternoon.
 */
export const DEFAULT_QUALITY_WINDOW_DAYS = 7;

/** Hard ceiling on a read window, in days. Bounds the rows a single query returns. */
export const MAX_QUALITY_WINDOW_DAYS = 180;
