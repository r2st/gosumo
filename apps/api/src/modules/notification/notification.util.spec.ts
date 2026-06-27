import { NotificationCategory } from '@prisma/client';
import {
  resolvePath,
  evaluateCondition,
  evaluateConditions,
  categoryHonoursOptOut,
  istMinutesOfDay,
  isWithinQuietHours,
  deferUntilQuietHoursEnd,
} from './notification.util';

describe('notification.util', () => {
  describe('resolvePath', () => {
    it('resolves nested dot-paths', () => {
      expect(resolvePath({ a: { b: { c: 7 } } }, 'a.b.c')).toBe(7);
    });
    it('returns undefined for missing keys', () => {
      expect(resolvePath({ a: 1 }, 'a.b.c')).toBeUndefined();
      expect(resolvePath(null, 'a')).toBeUndefined();
    });
  });

  describe('evaluateCondition', () => {
    const payload = { totalPaise: 50000, status: 'PAID', tags: ['vip'] };

    it.each([
      [{ path: 'totalPaise', op: 'gt', value: 10000 }, true],
      [{ path: 'totalPaise', op: 'gte', value: 50000 }, true],
      [{ path: 'totalPaise', op: 'lt', value: 10000 }, false],
      [{ path: 'totalPaise', op: 'lte', value: 50000 }, true],
      [{ path: 'status', op: 'eq', value: 'PAID' }, true],
      [{ path: 'status', op: 'ne', value: 'FAILED' }, true],
      [{ path: 'status', op: 'in', value: ['PAID', 'PENDING'] }, true],
      [{ path: 'missing', op: 'exists' }, false],
      [{ path: 'status', op: 'exists' }, true],
      [{ path: 'status', op: 'bogus', value: 'x' }, false],
    ])('evaluates %o → %s', (condition, expected) => {
      expect(evaluateCondition(condition as never, payload)).toBe(expected);
    });

    it('guards numeric ops against non-numbers', () => {
      expect(
        evaluateCondition({ path: 'status', op: 'gt', value: 1 }, payload),
      ).toBe(false);
    });
  });

  describe('evaluateConditions', () => {
    it('passes when there are no conditions (AND over empty)', () => {
      expect(evaluateConditions([], {})).toBe(true);
      expect(evaluateConditions(undefined, {})).toBe(true);
    });
    it('requires ALL conditions to pass', () => {
      const payload = { a: 5, b: 'x' };
      expect(
        evaluateConditions(
          [
            { path: 'a', op: 'gt', value: 1 },
            { path: 'b', op: 'eq', value: 'x' },
          ],
          payload,
        ),
      ).toBe(true);
      expect(
        evaluateConditions(
          [
            { path: 'a', op: 'gt', value: 1 },
            { path: 'b', op: 'eq', value: 'y' },
          ],
          payload,
        ),
      ).toBe(false);
    });
  });

  describe('categoryHonoursOptOut', () => {
    it('marketing and reminder honour opt-outs', () => {
      expect(categoryHonoursOptOut(NotificationCategory.MARKETING)).toBe(true);
      expect(categoryHonoursOptOut(NotificationCategory.REMINDER)).toBe(true);
    });
    it('transactional and system bypass opt-outs', () => {
      expect(categoryHonoursOptOut(NotificationCategory.TRANSACTIONAL)).toBe(false);
      expect(categoryHonoursOptOut(NotificationCategory.SYSTEM)).toBe(false);
    });
  });

  describe('istMinutesOfDay', () => {
    it('converts UTC to IST minutes-from-midnight (+5:30)', () => {
      // 00:00 UTC = 05:30 IST = 330
      expect(istMinutesOfDay(new Date('2026-06-27T00:00:00Z'))).toBe(330);
      // 20:00 UTC = 01:30 IST next day = 90
      expect(istMinutesOfDay(new Date('2026-06-27T20:00:00Z'))).toBe(90);
    });
  });

  describe('isWithinQuietHours', () => {
    it('handles a same-day window', () => {
      expect(isWithinQuietHours(540, 1080, 600)).toBe(true); // 09:00–18:00, 10:00
      expect(isWithinQuietHours(540, 1080, 1200)).toBe(false); // 20:00
    });
    it('handles a window that wraps midnight', () => {
      // 22:00–07:00
      expect(isWithinQuietHours(1320, 420, 1380)).toBe(true); // 23:00
      expect(isWithinQuietHours(1320, 420, 60)).toBe(true); // 01:00
      expect(isWithinQuietHours(1320, 420, 600)).toBe(false); // 10:00
    });
    it('treats a zero-width window as never quiet', () => {
      expect(isWithinQuietHours(500, 500, 500)).toBe(false);
    });
  });

  describe('deferUntilQuietHoursEnd', () => {
    it('returns null when not in quiet hours', () => {
      // 12:00 UTC = 17:30 IST = 1050; window 22:00–07:00
      const now = new Date('2026-06-27T12:00:00Z');
      expect(deferUntilQuietHoursEnd(now, 1320, 420)).toBeNull();
    });
    it('returns null when no window configured', () => {
      expect(deferUntilQuietHoursEnd(new Date(), null, null)).toBeNull();
    });
    it('defers to the window end when inside a wrapping window', () => {
      // 20:00 UTC = 01:30 IST = 90; window 22:00–07:00 (end=420)
      const now = new Date('2026-06-27T20:00:00Z');
      const until = deferUntilQuietHoursEnd(now, 1320, 420);
      expect(until).not.toBeNull();
      // 07:00 IST = 01:30 UTC; from 01:30 IST that's +330 minutes.
      expect(until!.getTime() - now.getTime()).toBe(330 * 60_000);
    });
  });
});
