/**
 * Bounds and scheduling for asynchronous export archives.
 */

/** Bull queue that builds and expires archives. */
export const EXPORT_QUEUE = 'data-export';

export const EXPORT_JOBS = {
  BUILD: 'build-archive',
  EXPIRE: 'expire-archives',
  RECOVER_STUCK: 'recover-stuck-exports',
} as const;

export interface BuildArchiveJobData {
  businessId: string;
  jobId: string;
}

/**
 * How long a built archive stays downloadable.
 *
 * Seven days is long enough for an operator to request one on Friday and hand
 * it over the following week, and short enough that a tenant's export table is
 * not a growing secondary copy of their customers' personal data. The bytes are
 * the entire point: an expired job keeps its row — the audit trail of who
 * exported what, which must outlive the data — and drops `payload`.
 */
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Expiry sweep. Hourly; the TTL is measured in days, so this is fine-grained enough. */
export const EXPORT_EXPIRY_CRON = '0 * * * *';
export const EXPORT_EXPIRY_REPEAT_JOB_ID = 'data-export-expiry-sweep';

/**
 * Recovery sweep for a job whose build never ran.
 *
 * The row is written to Postgres and the job is added to Redis with no
 * transaction across the two, so a failed `queue.add`, a crash between them, or
 * a Redis flush leaves a PENDING row nobody will ever build. A stranded row is
 * indistinguishable from a waiting one except by age.
 */
export const EXPORT_RECOVERY_CRON = '*/15 * * * *';
export const EXPORT_RECOVERY_REPEAT_JOB_ID = 'data-export-recovery-sweep';

/**
 * Age at which a non-terminal export is considered stranded.
 *
 * Comfortably past how long a build takes — the row caps bound it to seconds —
 * so the sweep never races a job that is merely queued behind others.
 */
export const EXPORT_STUCK_AFTER_MS = 15 * 60 * 1000;

/** Rows the recovery and expiry sweeps touch per tick. */
export const EXPORT_SWEEP_BATCH = 100;

/**
 * Live (PENDING or BUILDING) archive requests one tenant may hold at once.
 *
 * Each build reads up to 5,000 messages across eight tables and holds the
 * result in memory to compress it, so an operator who clicks twenty times
 * queues twenty of those. The rate limiter bounds requests per window; this
 * bounds concurrent *work*, which is the thing that actually competes for the
 * database.
 */
export const MAX_CONCURRENT_EXPORT_JOBS_PER_TENANT = 3;

/** Archive listing page size. */
export const EXPORT_LIST_DEFAULT_LIMIT = 20;
export const EXPORT_LIST_MAX_LIMIT = 100;
