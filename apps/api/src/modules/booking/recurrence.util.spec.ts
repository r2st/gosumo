import { RecurrenceFrequency } from '@gosumo/shared';
import {
  expandRecurrence,
  validateRecurrenceRule,
  MAX_OCCURRENCES,
  RecurrenceRule,
} from './recurrence.util';
import { IST_TIMEZONE, utcToZonedParts } from './timezone.util';

describe('recurrence.util', () => {
  const anchor = new Date('2026-06-27T03:30:00Z'); // 09:00 IST, Saturday

  describe('validateRecurrenceRule', () => {
    it('rejects an unbounded rule', () => {
      expect(() =>
        validateRecurrenceRule({ frequency: RecurrenceFrequency.DAILY }),
      ).toThrow(/bounded/);
    });

    it('rejects a non-positive interval', () => {
      expect(() =>
        validateRecurrenceRule({
          frequency: RecurrenceFrequency.DAILY,
          interval: 0,
          count: 3,
        }),
      ).toThrow(/interval/);
    });

    it('rejects out-of-range weekdays', () => {
      expect(() =>
        validateRecurrenceRule({
          frequency: RecurrenceFrequency.WEEKLY,
          count: 3,
          byWeekday: [7],
        }),
      ).toThrow(/byWeekday/);
    });

    it('accepts a count-bounded daily rule', () => {
      expect(() =>
        validateRecurrenceRule({ frequency: RecurrenceFrequency.DAILY, count: 5 }),
      ).not.toThrow();
    });
  });

  describe('expandRecurrence — DAILY', () => {
    it('produces `count` consecutive days preserving local time', () => {
      const rule: RecurrenceRule = { frequency: RecurrenceFrequency.DAILY, count: 3 };
      const occ = expandRecurrence(rule, anchor, 60, IST_TIMEZONE);
      expect(occ).toHaveLength(3);
      expect(occ[0]!.startAt.toISOString()).toBe('2026-06-27T03:30:00.000Z');
      expect(occ[1]!.startAt.toISOString()).toBe('2026-06-28T03:30:00.000Z');
      expect(occ[2]!.startAt.toISOString()).toBe('2026-06-29T03:30:00.000Z');
      // Duration honoured.
      expect(occ[0]!.endAt.getTime() - occ[0]!.startAt.getTime()).toBe(60 * 60_000);
    });

    it('honours interval (every 2 days)', () => {
      const rule: RecurrenceRule = {
        frequency: RecurrenceFrequency.DAILY,
        interval: 2,
        count: 3,
      };
      const occ = expandRecurrence(rule, anchor, 30, IST_TIMEZONE);
      expect(occ.map((o) => o.startAt.toISOString())).toEqual([
        '2026-06-27T03:30:00.000Z',
        '2026-06-29T03:30:00.000Z',
        '2026-07-01T03:30:00.000Z',
      ]);
    });

    it('stops at `until`', () => {
      const rule: RecurrenceRule = {
        frequency: RecurrenceFrequency.DAILY,
        until: '2026-06-29T23:59:00Z',
      };
      const occ = expandRecurrence(rule, anchor, 30, IST_TIMEZONE);
      expect(occ).toHaveLength(3); // 27, 28, 29
    });
  });

  describe('expandRecurrence — WEEKLY', () => {
    it('steps 7 days at a time', () => {
      const rule: RecurrenceRule = { frequency: RecurrenceFrequency.WEEKLY, count: 3 };
      const occ = expandRecurrence(rule, anchor, 45, IST_TIMEZONE);
      expect(occ.map((o) => o.startAt.toISOString())).toEqual([
        '2026-06-27T03:30:00.000Z',
        '2026-07-04T03:30:00.000Z',
        '2026-07-11T03:30:00.000Z',
      ]);
    });

    it('expands byWeekday within each week', () => {
      // Anchor Sat 2026-06-27; repeat Mon(1) & Wed(3), 4 occurrences.
      const rule: RecurrenceRule = {
        frequency: RecurrenceFrequency.WEEKLY,
        count: 4,
        byWeekday: [1, 3],
      };
      const occ = expandRecurrence(rule, anchor, 30, IST_TIMEZONE);
      const days = occ.map((o) => utcToZonedParts(o.startAt, IST_TIMEZONE));
      // First occurrences are the Mon/Wed after the Saturday anchor.
      expect(days[0]!).toMatchObject({ month: 6, day: 29, weekday: 1 }); // Mon
      expect(days[1]!).toMatchObject({ month: 7, day: 1, weekday: 3 }); // Wed
      expect(days[2]!).toMatchObject({ month: 7, day: 6, weekday: 1 }); // next Mon
      expect(days[3]!).toMatchObject({ month: 7, day: 8, weekday: 3 }); // next Wed
      // Local time-of-day preserved.
      expect(days[0]!.hour).toBe(9);
    });
  });

  describe('expandRecurrence — MONTHLY', () => {
    it('steps one month and clamps short months', () => {
      const jan31 = new Date('2026-01-31T04:30:00Z'); // 10:00 IST on Jan 31
      const rule: RecurrenceRule = {
        frequency: RecurrenceFrequency.MONTHLY,
        count: 3,
      };
      const occ = expandRecurrence(rule, jan31, 30, IST_TIMEZONE);
      const days = occ.map((o) => utcToZonedParts(o.startAt, IST_TIMEZONE));
      expect(days[0]!).toMatchObject({ month: 1, day: 31 });
      // February clamps to the 28th (2026 is not a leap year).
      expect(days[1]!).toMatchObject({ month: 2, day: 28 });
      expect(days[2]!).toMatchObject({ month: 3, day: 31 });
    });
  });

  describe('safety cap', () => {
    it('never exceeds MAX_OCCURRENCES even for a huge count', () => {
      const rule: RecurrenceRule = {
        frequency: RecurrenceFrequency.DAILY,
        count: 100_000,
      };
      const occ = expandRecurrence(rule, anchor, 30, IST_TIMEZONE);
      expect(occ.length).toBeLessThanOrEqual(MAX_OCCURRENCES);
    });
  });
});
