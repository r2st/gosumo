/**
 * Shared constants for the Realty Micro-Market Intelligence module (L1).
 */

/** Bull queue name for intelligence background jobs (the nightly aggregation). */
export const REALTY_INTELLIGENCE_QUEUE = 'realty-intelligence';

/** Job names processed by {@link RealtyIntelligenceProcessor}. */
export const REALTY_INTELLIGENCE_JOBS = {
  NIGHTLY_AGGREGATES: 'nightly-aggregates',
} as const;

/**
 * Repeatable-job id for the nightly aggregation. A stable id means re-registering
 * on every boot never stacks duplicate schedules (BullMQ dedups on it).
 */
export const NIGHTLY_AGGREGATES_JOB_ID = 'realty-intelligence:nightly';

/**
 * Cron for the nightly run — 02:30 IST (21:00 UTC), safely after the day's
 * traffic has settled. BullMQ evaluates cron in UTC unless a tz is given.
 */
export const NIGHTLY_AGGREGATES_CRON = '0 21 * * *';

/**
 * The minimum number of data points a corridor aggregate must be backed by
 * before it is ever emitted. Below this, an individual lead could be
 * reconstructed, so the aggregate is suppressed entirely (anti-reconstruction).
 */
export const DEFAULT_MIN_N_THRESHOLD = 5;

/**
 * How far back the nightly run looks when building aggregates. A year keeps the
 * seasonal-velocity curve meaningful while ageing out stale corridors.
 */
export const AGGREGATION_LOOKBACK_DAYS = 365;

/** Page size when streaming a business's leads through the aggregator. */
export const LEAD_FETCH_PAGE_SIZE = 500;

/**
 * Upper bound on how many leads one tenant contributes to a nightly run.
 * Matches the old page-loop guard (200 pages x 500). Reaching it is logged,
 * not silent — the aggregates would otherwise be a biased sample.
 */
export const LEAD_FETCH_CAP = 100_000;

/**
 * Free OpenRouter model used for the optional one-line natural-language corridor
 * summary. Kept to a small free-tier model — summarization is a nicety, never on
 * the critical path (a failure just leaves the numeric aggregate un-narrated).
 */
export const INTELLIGENCE_SUMMARY_MODEL = 'openai/gpt-oss-20b:free';

export interface NightlyAggregatesJobData {
  /** Optional single-tenant scope; omitted ⇒ every opted-in business. */
  businessId?: string;
}
