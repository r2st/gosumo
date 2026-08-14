/**
 * Display-formatting contract for the dashboard.
 *
 * `paiseToRupees` is the single authorised paise→rupees conversion in the
 * frontend (root CLAUDE.md rule 4), and the IST helpers are the only place UTC
 * timestamps from the API become local dates. Both are wrong in ways that are
 * easy to miss by eye — a rupees/paise slip is a factor of 100, and an IST
 * off-by-one only shows up for timestamps near midnight — so they are pinned
 * here rather than trusted to review.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatDateIST,
  formatDateTimeIST,
  formatDayLabelIST,
  formatDuration,
  formatNumber,
  formatRatioPct,
  formatTimeIST,
  humanizeEnum,
  istDayKey,
  paiseToCompactRupees,
  paiseToRupees,
  timeAgo,
} from './format';

afterEach(() => {
  vi.useRealTimers();
});

/** Intl inserts a non-breaking space after the symbol in some environments. */
function normalize(s: string): string {
  return s.replace(/ /g, ' ');
}

describe('paiseToRupees', () => {
  it('divides by 100 and groups Indian-style', () => {
    expect(normalize(paiseToRupees(1_050_000))).toBe('₹10,500.00');
  });

  it('renders sub-rupee amounts without losing the paise', () => {
    expect(normalize(paiseToRupees(1))).toBe('₹0.01');
    expect(normalize(paiseToRupees(99))).toBe('₹0.99');
  });

  it('treats a missing amount as zero rather than NaN', () => {
    expect(normalize(paiseToRupees(undefined))).toBe('₹0.00');
    expect(normalize(paiseToRupees(null))).toBe('₹0.00');
  });

  it('renders an explicit zero', () => {
    expect(normalize(paiseToRupees(0))).toBe('₹0.00');
  });

  it('keeps the sign on a negative amount (refunds)', () => {
    expect(normalize(paiseToRupees(-50_000))).toContain('500.00');
    expect(normalize(paiseToRupees(-50_000))).toMatch(/-/);
  });

  it('groups lakhs the Indian way, not the western way', () => {
    // 12,34,567.00 — not 1,234,567.00
    expect(normalize(paiseToRupees(123_456_700))).toBe('₹12,34,567.00');
  });
});

describe('paiseToCompactRupees', () => {
  it('uses crores at and above 1Cr', () => {
    expect(paiseToCompactRupees(1_00_00_000 * 100)).toBe('₹1.00Cr');
    expect(paiseToCompactRupees(2_50_00_000 * 100)).toBe('₹2.50Cr');
  });

  it('uses lakhs between 1L and 1Cr', () => {
    expect(paiseToCompactRupees(1_00_000 * 100)).toBe('₹1.00L');
    expect(paiseToCompactRupees(85_00_000 * 100)).toBe('₹85.00L');
  });

  it('uses thousands between 1K and 1L', () => {
    expect(paiseToCompactRupees(1_000 * 100)).toBe('₹1.0K');
    expect(paiseToCompactRupees(99_999 * 100)).toBe('₹100.0K');
  });

  it('prints whole rupees below 1K', () => {
    expect(paiseToCompactRupees(999 * 100)).toBe('₹999');
    expect(paiseToCompactRupees(0)).toBe('₹0');
  });

  it('treats a missing amount as zero', () => {
    expect(paiseToCompactRupees(undefined)).toBe('₹0');
    expect(paiseToCompactRupees(null)).toBe('₹0');
  });

  it('switches unit exactly at each boundary, not near it', () => {
    expect(paiseToCompactRupees(99_999 * 100)).toContain('K');
    expect(paiseToCompactRupees(100_000 * 100)).toContain('L');
    expect(paiseToCompactRupees(9_999_999 * 100)).toContain('L');
    expect(paiseToCompactRupees(10_000_000 * 100)).toContain('Cr');
  });
});

describe('IST timestamp helpers', () => {
  // 2026-06-27T11:00:00Z is 16:30 IST the same day.
  const UTC = '2026-06-27T11:00:00.000Z';

  it('renders date and time in IST, not UTC', () => {
    expect(formatDateTimeIST(UTC)).toBe('27 Jun 2026, 4:30 PM');
  });

  it('renders the date alone', () => {
    expect(formatDateIST(UTC)).toBe('27 Jun 2026');
  });

  it('renders the time alone', () => {
    expect(formatTimeIST(UTC)).toBe('4:30 PM');
  });

  it('rolls a late-evening UTC timestamp onto the next IST day', () => {
    // 19:00Z is 00:30 IST on the 28th — the off-by-one this helper exists for.
    expect(formatDateIST('2026-06-27T19:00:00.000Z')).toBe('28 Jun 2026');
    expect(istDayKey('2026-06-27T19:00:00.000Z')).toBe('2026-06-28');
  });

  it('renders an em dash for a missing timestamp', () => {
    for (const fn of [formatDateTimeIST, formatDateIST, formatTimeIST]) {
      expect(fn(undefined)).toBe('—');
      expect(fn(null)).toBe('—');
      expect(fn('')).toBe('—');
    }
  });

  it('renders an em dash for an unparseable timestamp rather than "Invalid Date"', () => {
    expect(formatDateTimeIST('not-a-date')).toBe('—');
    expect(formatDateIST('not-a-date')).toBe('—');
    expect(formatTimeIST('not-a-date')).toBe('—');
  });

  it('returns an empty day key for missing or unparseable input', () => {
    expect(istDayKey(undefined)).toBe('');
    expect(istDayKey('')).toBe('');
    expect(istDayKey('not-a-date')).toBe('');
  });
});

describe('formatDayLabelIST', () => {
  it('labels an IST-today timestamp "Today"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-27T11:00:00.000Z'));

    expect(formatDayLabelIST('2026-06-27T05:00:00.000Z')).toBe('Today');
  });

  it('labels the previous IST day "Yesterday"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-27T11:00:00.000Z'));

    expect(formatDayLabelIST('2026-06-26T05:00:00.000Z')).toBe('Yesterday');
  });

  it('falls back to an absolute IST date for anything older', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-27T11:00:00.000Z'));

    expect(formatDayLabelIST('2026-06-20T05:00:00.000Z')).toBe('20 Jun 2026');
  });

  it('groups a just-before-IST-midnight message under the right local day', () => {
    // 2026-06-27T18:45Z = 00:15 IST on the 28th, which is "Today" when now is
    // also the 28th IST. Comparing in UTC would call it yesterday.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T06:00:00.000Z'));

    expect(formatDayLabelIST('2026-06-27T18:45:00.000Z')).toBe('Today');
  });

  it('returns an empty label for missing or unparseable input', () => {
    expect(formatDayLabelIST(undefined)).toBe('');
    expect(formatDayLabelIST('not-a-date')).toBe('');
  });
});

describe('timeAgo', () => {
  const NOW = new Date('2026-06-27T12:00:00.000Z');

  function ago(ms: number): string {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    return timeAgo(new Date(NOW.getTime() - ms).toISOString());
  }

  it('says "now" under a minute', () => {
    expect(ago(0)).toBe('now');
    expect(ago(59_000)).toBe('now');
  });

  it('counts minutes, then hours, then days, then weeks', () => {
    expect(ago(5 * 60_000)).toBe('5m');
    expect(ago(3 * 3_600_000)).toBe('3h');
    expect(ago(2 * 86_400_000)).toBe('2d');
    expect(ago(14 * 86_400_000)).toBe('2w');
  });

  it('falls back to an absolute date beyond about a month', () => {
    expect(ago(60 * 86_400_000)).toBe('28 Apr 2026');
  });

  it('returns an empty string for missing or unparseable input', () => {
    expect(timeAgo(undefined)).toBe('');
    expect(timeAgo(null)).toBe('');
    expect(timeAgo('not-a-date')).toBe('');
  });
});

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('renders minutes, dropping a zero seconds remainder', () => {
    expect(formatDuration(150_000)).toBe('2m 30s');
    expect(formatDuration(120_000)).toBe('2m');
  });

  it('renders hours to one decimal past an hour', () => {
    expect(formatDuration(5_400_000)).toBe('1.5h');
  });

  it('renders an em dash for zero, negative, or missing durations', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatRatioPct', () => {
  it('scales a 0–1 ratio to a percentage', () => {
    expect(formatRatioPct(0.873)).toBe('87.3%');
  });

  it('passes an already-scaled 0–100 value through', () => {
    expect(formatRatioPct(87.3)).toBe('87.3%');
  });

  it('honours the requested precision', () => {
    expect(formatRatioPct(0.873, 0)).toBe('87%');
    expect(formatRatioPct(0.873, 2)).toBe('87.30%');
  });

  it('treats exactly 1 as 100%, the top of the ratio range', () => {
    expect(formatRatioPct(1)).toBe('100.0%');
  });

  it('renders an em dash for missing or NaN input', () => {
    expect(formatRatioPct(undefined)).toBe('—');
    expect(formatRatioPct(null)).toBe('—');
    expect(formatRatioPct(NaN)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('groups Indian-style', () => {
    expect(formatNumber(1_234_567)).toBe('12,34,567');
  });

  it('renders 0 for missing or NaN input rather than an empty cell', () => {
    expect(formatNumber(undefined)).toBe('0');
    expect(formatNumber(null)).toBe('0');
    expect(formatNumber(NaN)).toBe('0');
  });

  it('renders an explicit zero', () => {
    expect(formatNumber(0)).toBe('0');
  });
});

describe('humanizeEnum', () => {
  it('title-cases an UPPER_SNAKE value', () => {
    expect(humanizeEnum('PENDING_PAYMENT')).toBe('Pending Payment');
  });

  it('handles a single-word value', () => {
    expect(humanizeEnum('OPEN')).toBe('Open');
  });

  it('renders an em dash for missing or empty input', () => {
    expect(humanizeEnum(undefined)).toBe('—');
    expect(humanizeEnum(null)).toBe('—');
    expect(humanizeEnum('')).toBe('—');
  });
});
