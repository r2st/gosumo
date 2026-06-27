import { NotificationCategory } from '@prisma/client';

/** IST is UTC+5:30 — 330 minutes. Quiet hours are expressed in IST. */
export const IST_OFFSET_MINUTES = 330;
const MINUTES_PER_DAY = 1440;

/** A single trigger condition evaluated against an event payload. */
export interface TriggerCondition {
  path: string;
  op: string;
  value?: unknown;
}

/** Resolve a dot-path (`a.b.c`) against a nested object. */
export function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === 'object' && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Evaluate a single condition. Supported operators:
 * `eq, ne, gt, gte, lt, lte, exists, in`. Unknown operators evaluate false.
 */
export function evaluateCondition(
  condition: TriggerCondition,
  payload: unknown,
): boolean {
  const actual = resolvePath(payload, condition.path);
  const { op, value } = condition;

  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === value;
    case 'ne':
      return actual !== value;
    case 'gt':
      return typeof actual === 'number' && typeof value === 'number' && actual > value;
    case 'gte':
      return typeof actual === 'number' && typeof value === 'number' && actual >= value;
    case 'lt':
      return typeof actual === 'number' && typeof value === 'number' && actual < value;
    case 'lte':
      return typeof actual === 'number' && typeof value === 'number' && actual <= value;
    case 'in':
      return Array.isArray(value) && value.includes(actual as never);
    default:
      return false;
  }
}

/**
 * A trigger fires only when ALL of its conditions pass (AND semantics).
 * An empty/undefined condition list always passes.
 */
export function evaluateConditions(
  conditions: TriggerCondition[] | undefined | null,
  payload: unknown,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => evaluateCondition(c, payload));
}

/**
 * Whether a notification category honours marketing-style opt-outs.
 * TRANSACTIONAL and SYSTEM messages (receipts, security, service alerts) are
 * sent regardless of a marketing opt-out; MARKETING and REMINDER honour them.
 */
export function categoryHonoursOptOut(category: NotificationCategory): boolean {
  return (
    category === NotificationCategory.MARKETING ||
    category === NotificationCategory.REMINDER
  );
}

/** Minutes-from-midnight of `date` in IST (0–1439). */
export function istMinutesOfDay(date: Date): number {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (((utcMinutes + IST_OFFSET_MINUTES) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
}

/**
 * Is `minuteOfDay` inside the quiet window [start, end)? The window may wrap
 * midnight (start > end), e.g. 22:00–07:00.
 */
export function isWithinQuietHours(
  start: number,
  end: number,
  minuteOfDay: number,
): boolean {
  if (start === end) return false; // zero-width window = never quiet
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  // wraps midnight
  return minuteOfDay >= start || minuteOfDay < end;
}

/**
 * If `now` falls inside the quiet window, return the Date at which the window
 * ends (so a notification can be deferred); otherwise return null (send now).
 */
export function deferUntilQuietHoursEnd(
  now: Date,
  start: number | null | undefined,
  end: number | null | undefined,
): Date | null {
  if (start == null || end == null) return null;
  const m = istMinutesOfDay(now);
  if (!isWithinQuietHours(start, end, m)) return null;

  // Minutes from `now` until the window's `end` minute (next occurrence).
  let delta: number;
  if (start < end) {
    delta = end - m;
  } else if (m >= start) {
    delta = MINUTES_PER_DAY - m + end; // end is tomorrow IST
  } else {
    delta = end - m; // before end, same IST day
  }
  return new Date(now.getTime() + delta * 60_000);
}
