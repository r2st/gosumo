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

export interface ReminderJobData {
  businessId: string;
  bookingId: string;
  minutesBefore: number;
}

export interface AutoCancelJobData {
  businessId: string;
  bookingId: string;
}
