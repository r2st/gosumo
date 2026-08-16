import { NotificationDigestFrequency } from '@prisma/client';
import {
  ALERT_SUPPRESSION_REASONS,
  DEFAULT_SETTINGS_TIMEZONE,
  isKnownAlertKind,
  severityRank,
} from './notification-settings.constants';

/**
 * Timezone-aware scheduling helpers for operator notification settings.
 *
 * The rest of the notification module expresses quiet hours in IST minutes
 * (`notification.util.ts`), because client-facing quiet hours predate any
 * per-tenant timezone. Operator settings carry their own IANA `timezone`
 * column, so these helpers resolve wall-clock time in that zone instead of
 * assuming one. Nothing here reads `IST_OFFSET_MINUTES`.
 */

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;

/** Wall-clock fields of an instant, as read in a particular IANA zone. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Whether `timeZone` is a zone this runtime can resolve.
 *
 * Validated on write so a typo is a 400 at the settings endpoint rather than a
 * digest that silently never cuts. Read paths still fall back (see
 * {@link safeTimeZone}) because a row written by an older build, or by a
 * runtime with a fuller tz database, must not take the sweep down.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `timeZone` if this runtime can resolve it, otherwise the product default. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (timeZone && isValidTimeZone(timeZone)) return timeZone;
  return DEFAULT_SETTINGS_TIMEZONE;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Read the wall-clock fields of `date` as they appear in `timeZone`. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const zone = safeTimeZone(timeZone);
  const parts = partsFormatter(zone).formatToParts(date);
  const read = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // `hour12: false` renders midnight as 24 in some ICU versions; normalise it.
  const hour = read('hour') % 24;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Minutes from local midnight (0–1439) at `date`, in `timeZone`. */
export function zonedMinutesOfDay(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** Local day-of-week at `date` in `timeZone`. 0 = Sunday. */
export function zonedDayOfWeek(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Offset of `timeZone` from UTC at `date`, in minutes (east of UTC positive). */
function offsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop sub-second precision on both sides so the difference is whole minutes.
  return (asUtc - Math.floor(date.getTime() / 1000) * 1000) / MS_PER_MINUTE;
}

/**
 * The instant at which `timeZone`'s wall clock reads the given local fields.
 *
 * Two passes, because the offset needed to convert the wall clock depends on
 * the instant being computed: the first pass guesses using the offset in force
 * at the naive UTC reading, the second re-reads the offset at that guess. That
 * settles every case except a wall-clock time that a DST spring-forward skips
 * entirely, which lands on the instant the clock jumps to — the same choice the
 * platform makes, and one hour is not material for a digest cut.
 */
export function instantForLocalWallClock(
  local: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const zone = safeTimeZone(timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const firstGuess = new Date(asUtc - offsetMinutes(new Date(asUtc), zone) * MS_PER_MINUTE);
  return new Date(asUtc - offsetMinutes(firstGuess, zone) * MS_PER_MINUTE);
}

/** Add `days` to a local calendar date, normalising month/year rollover. */
function addLocalDays(
  local: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Is `minuteOfDay` inside the quiet window `[start, end)`?
 *
 * The window may wrap midnight (start > end), e.g. 22:00–07:00. A zero-width
 * window is never quiet, which is what makes `start === end` a usable way for
 * an operator to disable the window without clearing both columns.
 */
export function isWithinWindow(start: number, end: number, minuteOfDay: number): boolean {
  if (start === end) return false;
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end;
}

/**
 * The instant `now`'s quiet window ends, or null when `now` is not inside one.
 */
export function quietHoursEndAfter(
  now: Date,
  start: number | null | undefined,
  end: number | null | undefined,
  timeZone: string,
): Date | null {
  if (start == null || end == null) return null;
  const zone = safeTimeZone(timeZone);
  const minute = zonedMinutesOfDay(now, zone);
  if (!isWithinWindow(start, end, minute)) return null;

  let delta: number;
  if (start < end) {
    delta = end - minute;
  } else if (minute >= start) {
    delta = MINUTES_PER_DAY - minute + end; // `end` falls on the next local day
  } else {
    delta = end - minute; // still before `end` on the same local day
  }
  return new Date(now.getTime() + delta * MS_PER_MINUTE);
}

// ─────────────────────────────────────────────
// Alert resolution
// ─────────────────────────────────────────────

/** The subset of a settings row that alert resolution reads. */
export interface AlertRoutingSettings {
  realtime_enabled: boolean;
  realtime_alerts: string[];
  realtime_min_severity: string;
  muted_channels: string[];
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  quiet_hours_override_severity: string | null;
  timezone: string;
}

/** One alert being tested against a business's rules. */
export interface AlertCandidate {
  kind: string;
  severity: string;
  /** Conversation channel the alert originated from, when it had one. */
  sourceChannel?: string | null;
}

/** What the rules say should happen to an alert. */
export interface AlertDecision {
  /** Send it — now if `deferUntil` is null, at `deferUntil` otherwise. */
  deliver: boolean;
  /** Set only when the alert is held for quiet hours. */
  deferUntil: Date | null;
  /** Why it was withheld or deferred. Null when it goes out immediately. */
  reason: string | null;
}

/**
 * Decide whether one operator alert may be delivered now, later, or not at all.
 *
 * Order matters: the cheap unconditional switches run before quiet hours, so an
 * alert an operator has muted is reported as muted rather than as deferred, and
 * never comes back at the end of the window.
 *
 * **An empty `realtime_alerts` means every kind is subscribed, not none.** The
 * column defaults to `[]`, and the master switch is `realtime_enabled`; reading
 * empty as "nothing is on" would make a business that never opened the settings
 * page silently unreachable, and would leave `realtime_enabled: true` with
 * nothing to do. An operator who wants silence turns the master switch off.
 */
export function resolveAlertDelivery(
  settings: AlertRoutingSettings,
  alert: AlertCandidate,
  now: Date,
): AlertDecision {
  const withheld = (reason: string): AlertDecision => ({
    deliver: false,
    deferUntil: null,
    reason,
  });

  if (!settings.realtime_enabled) {
    return withheld(ALERT_SUPPRESSION_REASONS.REALTIME_DISABLED);
  }

  // Unknown entries are dropped rather than rejected, so a kind written by a
  // newer dashboard cannot make an otherwise-valid allow-list unsatisfiable.
  const subscribed = settings.realtime_alerts.filter(isKnownAlertKind);
  if (subscribed.length > 0 && !subscribed.includes(alert.kind as never)) {
    return withheld(ALERT_SUPPRESSION_REASONS.KIND_UNSUBSCRIBED);
  }

  if (alert.sourceChannel && settings.muted_channels.includes(alert.sourceChannel)) {
    return withheld(ALERT_SUPPRESSION_REASONS.CHANNEL_MUTED);
  }

  const rank = severityRank(alert.severity);
  if (rank < severityRank(settings.realtime_min_severity)) {
    return withheld(ALERT_SUPPRESSION_REASONS.BELOW_MIN_SEVERITY);
  }

  const quietEnd = quietHoursEndAfter(
    now,
    settings.quiet_hours_start,
    settings.quiet_hours_end,
    settings.timezone,
  );
  if (quietEnd) {
    // An override severity set at all means "wake me for this and louder". An
    // outage that starts at 02:00 is precisely what quiet hours must not hide.
    const override = settings.quiet_hours_override_severity;
    if (override != null && rank >= severityRank(override)) {
      return { deliver: true, deferUntil: null, reason: null };
    }
    return { deliver: true, deferUntil: quietEnd, reason: ALERT_SUPPRESSION_REASONS.QUIET_HOURS };
  }

  return { deliver: true, deferUntil: null, reason: null };
}

// ─────────────────────────────────────────────
// Digest scheduling
// ─────────────────────────────────────────────

/**
 * The next instant a digest should be cut, or null when the frequency is OFF.
 *
 * Strictly after `from`: the sweep stamps `next_digest_at` from the cut it just
 * performed, and an inclusive result there would re-cut the same window forever.
 */
export function nextDigestAt(
  from: Date,
  frequency: NotificationDigestFrequency,
  digestHour: number,
  digestDayOfWeek: number,
  timeZone: string,
): Date | null {
  if (frequency === NotificationDigestFrequency.OFF) return null;

  const zone = safeTimeZone(timeZone);
  const local = zonedParts(from, zone);

  if (frequency === NotificationDigestFrequency.HOURLY) {
    // Top of the next local hour. Computed on the local clock rather than by
    // adding an hour to `from`, so zones offset by :30 or :45 (India, Nepal,
    // Chatham) cut on their own hour boundary and not on UTC's.
    const atHour = instantForLocalWallClock(
      { year: local.year, month: local.month, day: local.day, hour: local.hour, minute: 0 },
      zone,
    );
    if (atHour.getTime() > from.getTime()) return atHour;
    const nextHour = local.hour + 1;
    const rolled = nextHour > 23 ? addLocalDays(local, 1) : local;
    return instantForLocalWallClock(
      {
        year: rolled.year,
        month: rolled.month,
        day: rolled.day,
        hour: nextHour % 24,
        minute: 0,
      },
      zone,
    );
  }

  const hour = clampHour(digestHour);

  if (frequency === NotificationDigestFrequency.DAILY) {
    const today = instantForLocalWallClock(
      { year: local.year, month: local.month, day: local.day, hour, minute: 0 },
      zone,
    );
    if (today.getTime() > from.getTime()) return today;
    const tomorrow = addLocalDays(local, 1);
    return instantForLocalWallClock({ ...tomorrow, hour, minute: 0 }, zone);
  }

  // WEEKLY — advance to the next occurrence of `digestDayOfWeek`.
  const targetDow = clampDayOfWeek(digestDayOfWeek);
  const currentDow = zonedDayOfWeek(from, zone);
  let daysAhead = (targetDow - currentDow + 7) % 7;

  let candidate = instantForLocalWallClock(
    { ...addLocalDays(local, daysAhead), hour, minute: 0 },
    zone,
  );
  if (candidate.getTime() <= from.getTime()) {
    daysAhead += 7;
    candidate = instantForLocalWallClock(
      { ...addLocalDays(local, daysAhead), hour, minute: 0 },
      zone,
    );
  }
  return candidate;
}

/** Hours outside 0–23 come from a stale client; clamp rather than throw on read. */
function clampHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  return Math.min(23, Math.max(0, Math.trunc(hour)));
}

/** Days outside 0–6 come from a stale client; clamp rather than throw on read. */
function clampDayOfWeek(day: number): number {
  if (!Number.isFinite(day)) return 0;
  return Math.min(6, Math.max(0, Math.trunc(day)));
}
