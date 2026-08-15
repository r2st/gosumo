import { createHash } from 'crypto';

/**
 * DPDPA compliance primitives (business plan §21), as pure functions so they are
 * exhaustively unit-testable and side-effect free.
 */

/** The placeholder a buyer's name is replaced with on erasure. */
export const ANONYMIZED_NAME = 'Anonymized';

/** Default retention window in months (plan §21). */
export const DEFAULT_RETENTION_MONTHS = 24;

/**
 * Build the first-contact data-processing notice (DPDPA §5 notice requirement).
 * Kept short so it fits inside the first WhatsApp message.
 */
export function buildFirstContactNotice(businessName: string): string {
  const name = businessName?.trim() || 'this brokerage';
  return `Your data is processed by ${name} to assist with your property search. Reply STOP to opt out anytime.`;
}

/**
 * Prepend the first-contact notice to an outbound message, once. When the notice
 * has already been delivered (`alreadySent`) or there is no message, the original
 * message is returned unchanged.
 */
export function withFirstContactNotice(
  message: string | null,
  businessName: string,
  alreadySent: boolean,
): string | null {
  if (message == null) return message;
  if (alreadySent) return message;
  const notice = buildFirstContactNotice(businessName);
  const trimmed = message.trim();
  if (!trimmed) return notice;
  return `${notice}\n\n${trimmed}`;
}

/**
 * Irreversibly pseudonymize a phone number for erasure. Returns a stable,
 * non-reversible token so anonymized records stay joinable for reporting without
 * exposing the original PII. Empty input yields a fixed sentinel.
 */
export function anonymizePhone(phone: string | null | undefined): string {
  if (!phone) return 'anon:unknown';
  const digest = createHash('sha256').update(phone).digest('hex').slice(0, 16);
  return `anon:${digest}`;
}

/** Irreversibly pseudonymize an email address (null-safe). */
export function anonymizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const digest = createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
  return `anon+${digest}@erased.invalid`;
}

/**
 * Subtract `months` whole months from a date (UTC-safe, clamping the day to the
 * target month's length).
 *
 * `setUTCMonth` alone overflows forward when the target month is shorter than
 * the source day: on 31 March, `setUTCMonth(month - 1)` asks for 31 February and
 * JS answers 3 March — a cutoff *later* than the date it was measured back from.
 * Every caller here uses the result to decide what to destroy, so an overshoot
 * erases records still inside the retention window. Anchoring to the 1st before
 * shifting the month keeps the arithmetic on real dates, then the day is clamped
 * back down (31 Mar − 1mo → 28 Feb, not 3 Mar). Time-of-day is preserved.
 */
export function subtractMonths(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const result = new Date(from.getTime());
  // Anchor to the 1st so the month shift itself can never roll over.
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  // Day 0 of the following month is the last day of the target month.
  const daysInTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, daysInTargetMonth));
  return result;
}

/**
 * Whether a lead is inactive past the retention window and eligible for
 * auto-anonymization. Uses the last activity timestamp (falling back to created)
 * against `retentionMonths` before `now`.
 */
export function isPastRetention(
  lastActivityAt: Date | null,
  createdAt: Date,
  retentionMonths: number,
  now: Date,
): boolean {
  const reference = lastActivityAt ?? createdAt;
  return reference.getTime() < retentionCutoff(retentionMonths, now).getTime();
}

/** The cutoff timestamp before which records are past the retention window. */
export function retentionCutoff(retentionMonths: number, now: Date): Date {
  return subtractMonths(now, retentionMonths);
}
