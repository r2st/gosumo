/**
 * Lightweight relative date-time parsing for broker voice commands (pure).
 *
 * Brokers say "tomorrow 5pm" or "today 3:30pm", not ISO-8601. This resolves the
 * common relative phrases against a provided `now` (so it stays deterministic
 * and testable). It is intentionally conservative: a phrase with no clock time
 * returns null, because booking a site visit at an unknown time is worse than
 * asking the broker to confirm.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve a "when" phrase to an absolute Date, or null when no clock time is
 * present. Understands today / tonight / tomorrow / day after (+ a bare time,
 * which defaults to today, rolling to tomorrow if that time already passed).
 */
export function parseRelativeDateTime(phrase: string, now: Date): Date | null {
  const text = phrase.trim().toLowerCase();
  if (!text) return null;

  const time = matchTime(text);
  if (!time) return null;

  let dayOffset = 0;
  if (/\bday after\b/.test(text)) dayOffset = 2;
  else if (/\btomorrow\b/.test(text)) dayOffset = 1;
  else if (/\btonight\b/.test(text)) {
    dayOffset = 0;
  }

  const base = new Date(now.getTime() + dayOffset * DAY_MS);
  const result = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    time.hours,
    time.minutes,
    0,
    0,
  );

  // A bare time (no day word) that has already passed today rolls to tomorrow.
  const hasDayWord = /\b(today|tonight|tomorrow|day after)\b/.test(text);
  if (!hasDayWord && result.getTime() <= now.getTime()) {
    return new Date(result.getTime() + DAY_MS);
  }
  return result;
}

interface ClockTime {
  hours: number;
  minutes: number;
}

function matchTime(text: string): ClockTime | null {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) return null;
  let hours = parseInt(m[1]!, 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];

  if (hours > 23 || minutes > 59) return null;
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  // A bare hour with no meridiem and no colon under 8 is ambiguous; assume the
  // broker means the afternoon/evening (5 → 17:00) for realty site visits.
  if (!meridiem && !m[2] && hours >= 1 && hours <= 7) hours += 12;

  return { hours, minutes };
}
