import {
  IST_TIMEZONE,
  getZoneOffsetMs,
  zonedTimeToUtc,
  utcToZonedParts,
  minutesSinceLocalMidnight,
  zonedWeekday,
  localDaySlotToUtc,
  addDaysToParts,
  formatInZone,
} from './timezone.util';

describe('timezone.util', () => {
  describe('getZoneOffsetMs', () => {
    it('returns +5:30 for IST (no DST)', () => {
      const offset = getZoneOffsetMs(new Date('2026-06-27T00:00:00Z'), IST_TIMEZONE);
      expect(offset).toBe(5.5 * 60 * 60 * 1000);
    });

    it('returns 0 for UTC', () => {
      expect(getZoneOffsetMs(new Date('2026-06-27T00:00:00Z'), 'UTC')).toBe(0);
    });

    it('reflects US Eastern DST difference', () => {
      // EDT (summer) = UTC-4; EST (winter) = UTC-5.
      const summer = getZoneOffsetMs(
        new Date('2026-07-01T12:00:00Z'),
        'America/New_York',
      );
      const winter = getZoneOffsetMs(
        new Date('2026-01-01T12:00:00Z'),
        'America/New_York',
      );
      expect(summer).toBe(-4 * 60 * 60 * 1000);
      expect(winter).toBe(-5 * 60 * 60 * 1000);
    });
  });

  describe('zonedTimeToUtc', () => {
    it('converts an IST wall-clock time to the right UTC instant', () => {
      // 09:00 IST on 2026-06-27 == 03:30 UTC.
      const utc = zonedTimeToUtc(2026, 6, 27, 9, 0, IST_TIMEZONE);
      expect(utc.toISOString()).toBe('2026-06-27T03:30:00.000Z');
    });

    it('round-trips through utcToZonedParts', () => {
      const utc = zonedTimeToUtc(2026, 12, 31, 23, 30, IST_TIMEZONE);
      const parts = utcToZonedParts(utc, IST_TIMEZONE);
      expect(parts).toMatchObject({
        year: 2026,
        month: 12,
        day: 31,
        hour: 23,
        minute: 30,
      });
    });

    it('handles a DST zone wall-clock time', () => {
      // 09:00 in New York on 2026-07-01 (EDT, UTC-4) == 13:00 UTC.
      const utc = zonedTimeToUtc(2026, 7, 1, 9, 0, 'America/New_York');
      expect(utc.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    });
  });

  describe('utcToZonedParts', () => {
    it('extracts IST parts with weekday', () => {
      // 2026-06-27 is a Saturday.
      const parts = utcToZonedParts(new Date('2026-06-27T03:30:00Z'), IST_TIMEZONE);
      expect(parts.hour).toBe(9);
      expect(parts.minute).toBe(0);
      expect(parts.weekday).toBe(6); // Saturday
    });

    it('rolls the calendar day forward for late-UTC IST times', () => {
      // 20:00 UTC on the 26th is 01:30 IST on the 27th.
      const parts = utcToZonedParts(new Date('2026-06-26T20:00:00Z'), IST_TIMEZONE);
      expect(parts.day).toBe(27);
      expect(parts.hour).toBe(1);
      expect(parts.minute).toBe(30);
    });
  });

  describe('minutesSinceLocalMidnight', () => {
    it('computes IST minutes from midnight', () => {
      const mins = minutesSinceLocalMidnight(
        new Date('2026-06-27T03:30:00Z'),
        IST_TIMEZONE,
      );
      expect(mins).toBe(9 * 60); // 09:00 IST
    });
  });

  describe('zonedWeekday', () => {
    it('returns 0 for Sunday', () => {
      // 2026-06-28 is a Sunday.
      expect(zonedWeekday(new Date('2026-06-28T06:00:00Z'), IST_TIMEZONE)).toBe(0);
    });
  });

  describe('localDaySlotToUtc', () => {
    it('builds a UTC instant for a minute offset on a local day', () => {
      const anchor = utcToZonedParts(new Date('2026-06-27T00:00:00Z'), IST_TIMEZONE);
      const utc = localDaySlotToUtc(anchor, 10 * 60 + 30, IST_TIMEZONE); // 10:30 IST
      expect(utc.toISOString()).toBe('2026-06-27T05:00:00.000Z');
    });
  });

  describe('addDaysToParts', () => {
    it('advances across a month boundary and recomputes weekday', () => {
      const anchor = utcToZonedParts(new Date('2026-06-30T06:00:00Z'), IST_TIMEZONE);
      const next = addDaysToParts(anchor, 1);
      expect(next).toMatchObject({ year: 2026, month: 7, day: 1 });
    });
  });

  describe('formatInZone', () => {
    it('formats a readable local string', () => {
      const s = formatInZone(new Date('2026-06-27T03:30:00Z'), IST_TIMEZONE);
      expect(s).toBe('2026-06-27 09:00 (Asia/Kolkata)');
    });
  });
});
