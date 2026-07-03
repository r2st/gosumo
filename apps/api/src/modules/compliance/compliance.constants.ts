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
