/**
 * Timezone helpers for the Booking module.
 *
 * GoSumo stores every booking time as a UTC `Timestamptz`. Availability,
 * however, is expressed in a business's local timezone (IST by default, but
 * multi-timezone is supported). This module converts between UTC instants and
 * zoned wall-clock times using the built-in `Intl` APIs — no external date
 * library, so it works the same in every Node environment.
 *
 * The two primitives are:
 *  - {@link zonedTimeToUtc}: local wall-clock (Y/M/D h:m in a timezone) → UTC Date
 *  - {@link utcToZonedParts}: UTC Date → wall-clock parts in a timezone
 */

/** Primary timezone for GoSumo (India). */
export const IST_TIMEZONE = 'Asia/Kolkata';

export interface ZonedParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
  /** 0-59 */
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

/**
 * The offset (in ms) of `timeZone` from UTC at the given instant.
 * Positive means the zone is ahead of UTC (e.g. IST = +19_800_000).
 */
export function getZoneOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  // `h23` renders midnight as hour 24 in some engines — normalise to 0.
  const hour = Number(map.hour) % 24;

  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    hour,
    Number(map.minute),
    Number(map.second),
  );

  return asUtc - date.getTime();
}

/**
 * Convert a wall-clock time in `timeZone` to the corresponding UTC instant.
 *
 * The offset depends on the instant itself (DST), so we estimate, then refine
 * once against the candidate instant. IST has no DST, so this is exact; for
 * DST zones the single refinement resolves all but the rare fold/gap edge.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
  second = 0,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  let offset = getZoneOffsetMs(new Date(wallAsUtc), timeZone);
  let utc = wallAsUtc - offset;

  // Refine: the offset at the candidate instant may differ across a DST change.
  offset = getZoneOffsetMs(new Date(utc), timeZone);
  utc = wallAsUtc - offset;

  return new Date(utc);
}

/**
 * Break a UTC instant into wall-clock parts in `timeZone`.
 */
export function utcToZonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = dtf.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekdayMap[map.weekday ?? 'Sun'] ?? 0,
  };
}

/**
 * Minutes elapsed since local midnight for a UTC instant in `timeZone`.
 * Useful for matching an instant against weekly availability windows.
 */
export function minutesSinceLocalMidnight(date: Date, timeZone: string): number {
  const parts = utcToZonedParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

/**
 * The 0-6 weekday (0 = Sunday) of a UTC instant in `timeZone`.
 */
export function zonedWeekday(date: Date, timeZone: string): number {
  return utcToZonedParts(date, timeZone).weekday;
}

/**
 * Build the UTC instant for `minutesFromMidnight` on the local calendar day of
 * `dayAnchor` (interpreted in `timeZone`). Used to turn an availability window
 * (e.g. 09:00 local) into a concrete UTC slot start.
 */
export function localDaySlotToUtc(
  dayAnchor: ZonedParts,
  minutesFromMidnight: number,
  timeZone: string,
): Date {
  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  return zonedTimeToUtc(
    dayAnchor.year,
    dayAnchor.month,
    dayAnchor.day,
    hour,
    minute,
    timeZone,
  );
}

/**
 * Format a UTC instant as an ISO-like local string for display/logging, e.g.
 * `2026-06-27 14:30 (Asia/Kolkata)`.
 */
export function formatInZone(date: Date, timeZone: string): string {
  const p = utcToZonedParts(date, timeZone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${timeZone})`;
}

/** Add `days` calendar days to a {@link ZonedParts} day anchor (date only). */
export function addDaysToParts(parts: ZonedParts, days: number): ZonedParts {
  // Use a UTC date purely as a calendar-arithmetic vehicle (no tz involved).
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  d.setUTCDate(d.getUTCDate() + days);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
    weekday: d.getUTCDay(),
  };
}
