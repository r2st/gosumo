/**
 * Shared constants for the Booking module.
 */

/** Bull queue name for booking background jobs (reminders, auto-cancel). */
export const BOOKING_QUEUE = 'booking';

/** Job names processed by {@link BookingProcessor}. */
export const BOOKING_JOBS = {
  REMINDER: 'reminder',
  AUTO_CANCEL: 'auto-cancel',
} as const;

/**
 * Default reminder lead times (minutes before start): 24 hours and 1 hour.
 * Each becomes a delayed job; the processor emits `booking.reminder`.
 */
export const DEFAULT_REMINDER_OFFSETS_MINUTES = [1440, 60];

/** PENDING bookings without payment are auto-cancelled after this long. */
export const AUTO_CANCEL_PENDING_HOURS = 24;

/**
 * Cap on the staff roster returned to the booking assignment picker.
 * The picker is a dropdown, not a paged list — a tenant large enough to exceed
 * this has outgrown the control, not the query. Bounded so the endpoint cannot
 * be turned into an unbounded table read.
 */
export const STAFF_ROSTER_LIMIT = 200;

export interface ReminderJobData {
  businessId: string;
  bookingId: string;
  minutesBefore: number;
}

export interface AutoCancelJobData {
  businessId: string;
  bookingId: string;
}
