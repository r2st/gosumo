/** BullMQ queue driving the weekly portal-parser health probe. */
export const PARSER_HEALTH_QUEUE = 'realty-parser-health';

export const PARSER_HEALTH_JOBS = {
  /** Weekly re-parse of the known-good sample emails across all portals. */
  WEEKLY_CHECK: 'weekly-parser-check',
} as const;

/** Stable repeatable-job id so re-registration on boot never duplicates the schedule. */
export const PARSER_HEALTH_REPEAT_JOB_ID = 'realty-parser-health:weekly';

/** Weekly, Mondays 04:00 (server time) — a quiet window before the workweek. */
export const PARSER_HEALTH_CRON = '0 4 * * 1';
