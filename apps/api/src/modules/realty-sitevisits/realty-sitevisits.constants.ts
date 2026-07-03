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

export interface VisitReminderJobData {
  businessId: string;
  visitId: string;
  minutesBefore: number;
}
