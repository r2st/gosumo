/** The BullMQ queue that drives the scheduled DPDPA retention sweep. */
export const COMPLIANCE_QUEUE = 'compliance';

export const COMPLIANCE_JOBS = {
  /** Weekly retention sweep across all businesses. */
  RETENTION_SWEEP: 'retention-sweep',
} as const;

/** Stable repeatable-job id so re-registration on boot never duplicates the schedule. */
export const RETENTION_REPEAT_JOB_ID = 'compliance:retention:weekly';

/** Weekly, Sundays 03:00 (server time) — a quiet window for the sweep. */
export const RETENTION_CRON = '0 3 * * 0';

// ─────────────────────────────────────────────
// Retention sweep bounds
//
// The sweep erases leads one at a time, so it needs a page size, a per-tenant
// ceiling, and a deadline. Without all three it is either unbounded (a tenant
// with a large backlog runs past `JOB_TIMEOUT_MS` and the whole sweep is
// killed mid-run) or, as it was, silently truncated at a single page.
// ─────────────────────────────────────────────

/**
 * Leads fetched per page.
 *
 * Also the repository default. Each lead costs a handful of statements
 * (anonymize the lead, anonymize its messages, write the audit row), so the
 * page is sized to be a meaningful unit of work without holding a large result
 * set in memory.
 */
export const RETENTION_LEAD_BATCH_SIZE = 500;

/**
 * Most leads one business may have erased in a single run.
 *
 * A ceiling rather than "drain it all" so one tenant with a very large backlog
 * cannot consume the entire run's budget and starve every tenant after it in
 * `runAll`. Ten pages clears any realistic weekly accrual in one run; a bigger
 * backlog than that is a migration, and it drains over the following runs with
 * `leadsPending` flagging it the whole time.
 */
export const RETENTION_MAX_LEADS_PER_BUSINESS = 10 * RETENTION_LEAD_BATCH_SIZE;

/**
 * Wall-clock budget for a whole `runAll`, in ms.
 *
 * Set below `JOB_TIMEOUT_MS` (5 min) on purpose. Bull's timeout is a kill, not
 * a request to stop: it fails the job wherever it happens to be, so nothing
 * records how far the sweep got and the retry starts over. Stopping ourselves
 * with a minute to spare means the run ends by returning a result — including
 * which businesses it never reached — instead of by being shot.
 */
export const RETENTION_RUN_BUDGET_MS = 4 * 60 * 1000;
