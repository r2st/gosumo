/**
 * Calendar-aware ISO-8601 date validation.
 *
 * `@IsDateString()` from class-validator only checks ISO-8601 *shape*. It
 * happily accepts `2026-02-31`, and every consumer that does `new Date(value)`
 * then silently receives 3 March — a different day than the client sent. The
 * same hole admits `2025-02-29` (not a leap year), month `13`, day `00`, and
 * hour `25`.
 *
 * The consequences are real in this codebase: a snooze wakes a conversation on
 * the wrong day, a coupon's `validUntil` extends past its intended expiry, a
 * booking lands in the wrong slot, and a possession date misreports to a buyer.
 * None of these fail loudly — they roll.
 *
 * `@IsCalendarDateString()` closes it by requiring that the components a client
 * wrote survive a round-trip through `Date`. If any field is normalized away,
 * the value is rejected rather than silently rewritten.
 */

import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * ISO-8601 calendar date, optionally with a time and offset.
 *
 * Accepted shapes:
 *   2026-02-28
 *   2026-02-28T10:30
 *   2026-02-28T10:30:00
 *   2026-02-28T10:30:00.123
 *   ...each of the timed forms with `Z`, `+05:30`, `-0800`, or no offset.
 *
 * Deliberately rejected: week dates (`2026-W05`), ordinal dates (`2026-059`),
 * and basic format without separators (`20260228`). None are used by any
 * client here, and every one of them is a likelier typo than an intent.
 */
const ISO_8601_CALENDAR =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Result of a failed check, used to build a message that names the fault. */
type Fault = 'format' | 'calendar' | 'time' | 'offset';

function faultFor(value: unknown): Fault | null {
  if (typeof value !== 'string') return 'format';

  const match = ISO_8601_CALENDAR.exec(value);
  if (!match) return 'format';

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , offsetRaw] = match;

  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);

  // Round-trip the calendar components. Date.UTC normalizes out-of-range
  // values (month 13 → January of the next year, 31 Feb → 3 March), so if any
  // component comes back changed, the client wrote a date that does not exist.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return 'calendar';
  }

  if (hourRaw !== undefined) {
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    // Seconds may be absent; `60` is a leap second, which `Date` rolls into the
    // next minute, so it is rejected along with anything above it.
    const second = secondRaw === undefined ? 0 : Number(secondRaw);
    if (hour > 23 || minute > 59 || second > 59) return 'time';
  }

  if (offsetRaw !== undefined && offsetRaw !== 'Z') {
    const sign = offsetRaw.startsWith('-') ? -1 : 1;
    const digits = offsetRaw.slice(1).replace(':', '');
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMinutes = Number(digits.slice(2, 4));
    if (offsetMinutes > 59) return 'offset';
    // UTC offsets run from -12:00 to +14:00 (Kiribati). Anything wider is a
    // malformed offset rather than a real zone.
    const totalMinutes = sign * (offsetHours * 60 + offsetMinutes);
    if (totalMinutes < -12 * 60 || totalMinutes > 14 * 60) return 'offset';
  }

  // Final guard: whatever survived the component checks must still parse.
  if (Number.isNaN(new Date(value).getTime())) return 'format';

  return null;
}

/**
 * True when `value` is an ISO-8601 string naming a date that actually exists.
 *
 * Exported separately from the decorator so non-DTO code (parsers, importers,
 * webhook payload handling) can reuse the same rule instead of re-deriving it.
 */
export function isCalendarDateString(value: unknown): value is string {
  return faultFor(value) === null;
}

const MESSAGES: Record<Fault, string> = {
  format: 'must be an ISO-8601 date string (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ssZ)',
  calendar: 'must be a date that exists on the calendar',
  time: 'must have a valid time of day (00:00:00 through 23:59:59)',
  offset: 'must have a UTC offset between -12:00 and +14:00',
};

/**
 * Validates that a property is an ISO-8601 string naming a real calendar date.
 *
 * Drop-in replacement for `@IsDateString()`; every value the old decorator
 * accepted still passes except the impossible ones it should never have let
 * through.
 */
export function IsCalendarDateString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isCalendarDateString',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isCalendarDateString(value);
        },
        defaultMessage(args: ValidationArguments): string {
          const fault = faultFor(args.value) ?? 'format';
          return `${args.property} ${MESSAGES[fault]}`;
        },
      },
    });
  };
}
