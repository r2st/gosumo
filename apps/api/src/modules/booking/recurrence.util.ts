/**
 * Recurring-appointment expansion for the Booking module.
 *
 * A recurrence is a compact rule (frequency + interval + bound) plus an anchor
 * start instant. Occurrences are produced as UTC instants but stepped in the
 * series' local timezone, so the local time-of-day is preserved across DST
 * transitions (a 9:00am weekly slot stays 9:00am local year-round).
 */
import { RecurrenceFrequency } from '@gosumo/shared';
import { utcToZonedParts, zonedTimeToUtc, ZonedParts } from './timezone.util';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  /** Step size, e.g. interval 2 + WEEKLY = every other week. Defaults to 1. */
  interval?: number;
  /** Hard cap on the number of occurrences generated. */
  count?: number;
  /** ISO-8601 UTC instant; occurrences strictly after this are excluded. */
  until?: string;
  /** For WEEKLY: which weekdays (0=Sun..6=Sat) the event repeats on. */
  byWeekday?: number[];
}

/** A single materialised occurrence of a series. */
export interface RecurrenceOccurrence {
  startAt: Date;
  endAt: Date;
}

/**
 * Hard safety cap so a malformed unbounded rule can never spin forever.
 */
export const MAX_OCCURRENCES = 366;

/**
 * Validate a recurrence rule, throwing on anything that would produce an
 * infinite or empty series.
 */
export function validateRecurrenceRule(rule: RecurrenceRule): void {
  const interval = rule.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error('Recurrence interval must be a positive integer');
  }
  if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1)) {
    throw new Error('Recurrence count must be a positive integer');
  }
  if (rule.count === undefined && rule.until === undefined) {
    throw new Error('Recurrence must be bounded by either count or until');
  }
  if (rule.until !== undefined && Number.isNaN(Date.parse(rule.until))) {
    throw new Error('Recurrence until must be a valid ISO-8601 date');
  }
  if (
    rule.byWeekday &&
    rule.byWeekday.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  ) {
    throw new Error('Recurrence byWeekday entries must be 0-6 (0=Sunday)');
  }
  if (!Object.values(RecurrenceFrequency).includes(rule.frequency)) {
    throw new Error(`Unsupported recurrence frequency: ${rule.frequency}`);
  }
}

/**
 * Expand a recurrence into concrete occurrences.
 *
 * @param rule             the recurrence definition
 * @param anchorStartUtc   UTC instant of the first occurrence
 * @param durationMinutes  length of each occurrence
 * @param timeZone         IANA tz the local time-of-day is anchored to
 */
export function expandRecurrence(
  rule: RecurrenceRule,
  anchorStartUtc: Date,
  durationMinutes: number,
  timeZone: string,
): RecurrenceOccurrence[] {
  validateRecurrenceRule(rule);

  const interval = rule.interval ?? 1;
  const limit = Math.min(rule.count ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  const untilMs = rule.until ? Date.parse(rule.until) : Infinity;

  const anchor = utcToZonedParts(anchorStartUtc, timeZone);
  const occurrences: RecurrenceOccurrence[] = [];

  const push = (start: Date): boolean => {
    if (start.getTime() > untilMs) {
      return false;
    }
    occurrences.push({
      startAt: start,
      endAt: new Date(start.getTime() + durationMinutes * 60_000),
    });
    return occurrences.length < limit;
  };

  if (rule.frequency === RecurrenceFrequency.WEEKLY && rule.byWeekday?.length) {
    expandWeeklyByWeekday(rule, anchor, interval, timeZone, untilMs, limit, occurrences, durationMinutes);
    return occurrences;
  }

  // Simple cadence: step the local day forward and re-anchor the time-of-day.
  for (let i = 0; occurrences.length < limit; i++) {
    const next = stepLocalDate(anchor, rule.frequency, i * interval);
    const start = zonedTimeToUtc(
      next.year,
      next.month,
      next.day,
      anchor.hour,
      anchor.minute,
      timeZone,
    );
    if (!push(start)) {
      break;
    }
    // Guard against runaway loops on `until`-bounded rules.
    if (i > MAX_OCCURRENCES * Math.max(interval, 1)) {
      break;
    }
  }

  return occurrences;
}

/**
 * WEEKLY with explicit weekdays: walk week-by-week (stepping by `interval`
 * weeks) and within each active week emit every selected weekday in order.
 */
function expandWeeklyByWeekday(
  rule: RecurrenceRule,
  anchor: ZonedParts,
  interval: number,
  timeZone: string,
  untilMs: number,
  limit: number,
  out: RecurrenceOccurrence[],
  durationMinutes: number,
): void {
  const weekdays = [...new Set(rule.byWeekday)].sort((a, b) => a - b);

  // Move the anchor back to the Sunday of its week so weeks align predictably.
  const anchorWeekStart = addLocalDays(anchor, -anchor.weekday);

  for (let week = 0; out.length < limit; week++) {
    const weekStart = addLocalDays(anchorWeekStart, week * interval * 7);

    for (const wd of weekdays) {
      const day = addLocalDays(weekStart, wd);
      const start = zonedTimeToUtc(
        day.year,
        day.month,
        day.day,
        anchor.hour,
        anchor.minute,
        timeZone,
      );

      // Skip occurrences strictly before the anchor (same-week earlier days).
      if (week === 0 && start.getTime() < zonedTimeToUtc(anchor.year, anchor.month, anchor.day, anchor.hour, anchor.minute, timeZone).getTime()) {
        continue;
      }
      if (start.getTime() > untilMs) {
        return;
      }
      out.push({
        startAt: start,
        endAt: new Date(start.getTime() + durationMinutes * 60_000),
      });
      if (out.length >= limit) {
        return;
      }
    }

    if (week > MAX_OCCURRENCES) {
      return;
    }
  }
}

/** Step a local calendar date by `n` units of `frequency`. */
function stepLocalDate(
  anchor: ZonedParts,
  frequency: RecurrenceFrequency,
  n: number,
): ZonedParts {
  switch (frequency) {
    case RecurrenceFrequency.DAILY:
      return addLocalDays(anchor, n);
    case RecurrenceFrequency.WEEKLY:
      return addLocalDays(anchor, n * 7);
    case RecurrenceFrequency.MONTHLY:
      return addLocalMonths(anchor, n);
    default:
      return anchor;
  }
}

function addLocalDays(parts: ZonedParts, days: number): ZonedParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  d.setUTCDate(d.getUTCDate() + days);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
    second: 0,
    weekday: d.getUTCDay(),
  };
}

function addLocalMonths(parts: ZonedParts, months: number): ZonedParts {
  const totalMonths = (parts.year * 12 + (parts.month - 1)) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  // Clamp the day to the last day of the target month (e.g. Jan 31 → Feb 28).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(parts.day, daysInMonth);
  const d = new Date(Date.UTC(year, month - 1, day));
  return {
    year,
    month,
    day,
    hour: parts.hour,
    minute: parts.minute,
    second: 0,
    weekday: d.getUTCDay(),
  };
}
