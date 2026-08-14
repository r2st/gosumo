/**
 * Shared constants for the Realty Site Visits module.
 */

/** Bull queue name for site-visit background jobs (reminders). */
export const REALTY_VISITS_QUEUE = 'realty-visits';

/** Job names processed by {@link RealtyVisitsProcessor}. */
export const REALTY_VISIT_JOBS = {
  REMINDER: 'visit-reminder',
} as const;

/**
 * Reminder lead times in minutes before the scheduled visit: T-24h and T-2h
 * (blueprint §14). Each becomes a delayed Bull job; the processor emits
 * `realty.visit.reminder` so the notification path sends the WhatsApp template.
 */
export const VISIT_REMINDER_OFFSETS_MINUTES = [1440, 120];

/** Default visit duration when the caller does not specify one. */
export const DEFAULT_VISIT_DURATION_MINUTES = 45;

/**
 * Widest span the calendar endpoint will serve in one request.
 *
 * `GET calendar` takes a caller-supplied `from`/`to` and returned every row in
 * between with no ceiling, so `from=1970-01-01&to=2999-01-01` read the tenant's
 * entire visit history into memory and mapped all of it to DTOs. A year covers
 * any real calendar view; beyond that the caller wants the paginated list.
 */
export const CALENDAR_MAX_RANGE_DAYS = 366;

/**
 * Hard row ceiling on a single calendar range, as a backstop for a dense tenant
 * inside an otherwise legal span. Exceeding it is logged, not silent.
 */
export const CALENDAR_MAX_VISITS = 5000;

export interface VisitReminderJobData {
  businessId: string;
  visitId: string;
  minutesBefore: number;
}
