/**
 * Bucket arithmetic for the AI quality rollup.
 *
 * These are the numbers the writer and the reader both have to agree on, so
 * they are tested against fixed UTC instants rather than anything derived from
 * the host clock or timezone.
 */

import { AiQualityBucket } from '@prisma/client';
import {
  DAY_MS,
  HOUR_MS,
  bucketSizeMs,
  bucketsToCompute,
  floorToBucket,
  floorToDay,
  floorToHour,
  latestClosedBucketStart,
  rate,
  round4,
} from './ai-quality.util';

const HOUR = AiQualityBucket.HOUR;
const DAY = AiQualityBucket.DAY;

describe('ai-quality bucket arithmetic', () => {
  describe('floorToHour / floorToDay', () => {
    it('truncates to the containing UTC hour', () => {
      expect(floorToHour(new Date('2026-08-15T13:47:31.412Z')).toISOString()).toBe(
        '2026-08-15T13:00:00.000Z',
      );
    });

    it('is a no-op on an exact boundary', () => {
      const exact = new Date('2026-08-15T13:00:00.000Z');
      expect(floorToHour(exact).getTime()).toBe(exact.getTime());
      const midnight = new Date('2026-08-15T00:00:00.000Z');
      expect(floorToDay(midnight).getTime()).toBe(midnight.getTime());
    });

    it('truncates to the containing UTC day, not the local one', () => {
      // 23:30Z belongs to the 15th in UTC. A local-time implementation in any
      // timezone east of UTC would put it on the 16th, and the rollup and the
      // dashboard would then disagree about which day a decision landed in.
      expect(floorToDay(new Date('2026-08-15T23:30:00Z')).toISOString()).toBe(
        '2026-08-15T00:00:00.000Z',
      );
    });
  });

  describe('bucketSizeMs / floorToBucket', () => {
    it('sizes each granularity', () => {
      expect(bucketSizeMs(HOUR)).toBe(HOUR_MS);
      expect(bucketSizeMs(DAY)).toBe(DAY_MS);
    });

    it('dispatches to the matching truncation', () => {
      const d = new Date('2026-08-15T13:47:00Z');
      expect(floorToBucket(d, HOUR).toISOString()).toBe('2026-08-15T13:00:00.000Z');
      expect(floorToBucket(d, DAY).toISOString()).toBe('2026-08-15T00:00:00.000Z');
    });
  });

  describe('latestClosedBucketStart', () => {
    it('is one whole bucket behind the current one', () => {
      // 13:47 → the 13:00 bucket is still accruing, so 12:00 is the newest
      // bucket whose count is final.
      expect(
        latestClosedBucketStart(new Date('2026-08-15T13:47:00Z'), HOUR).toISOString(),
      ).toBe('2026-08-15T12:00:00.000Z');
    });

    it('does not treat an exact boundary as closing the bucket it starts', () => {
      // At exactly 13:00:00 the 13:00 bucket has just opened and holds nothing.
      expect(
        latestClosedBucketStart(new Date('2026-08-15T13:00:00Z'), HOUR).toISOString(),
      ).toBe('2026-08-15T12:00:00.000Z');
    });

    it('works for days', () => {
      expect(
        latestClosedBucketStart(new Date('2026-08-15T13:47:00Z'), DAY).toISOString(),
      ).toBe('2026-08-14T00:00:00.000Z');
    });
  });

  describe('bucketsToCompute', () => {
    const latest = new Date('2026-08-15T12:00:00Z');

    it('returns the single next bucket in the steady state', () => {
      const out = bucketsToCompute(new Date('2026-08-15T11:00:00Z'), latest, HOUR, 48);
      expect(out.map((d) => d.toISOString())).toEqual(['2026-08-15T12:00:00.000Z']);
    });

    it('returns nothing when the newest closed bucket is already computed', () => {
      expect(bucketsToCompute(latest, latest, HOUR, 48)).toEqual([]);
    });

    it('returns nothing when the table is ahead of the closed boundary', () => {
      // Can happen after a manual recompute: never re-do a bucket, and never
      // emit a negative-length range.
      const ahead = new Date('2026-08-15T14:00:00Z');
      expect(bucketsToCompute(ahead, latest, HOUR, 48)).toEqual([]);
    });

    it('fills a gap oldest-first', () => {
      const out = bucketsToCompute(new Date('2026-08-15T09:00:00Z'), latest, HOUR, 48);
      expect(out.map((d) => d.toISOString())).toEqual([
        '2026-08-15T10:00:00.000Z',
        '2026-08-15T11:00:00.000Z',
        '2026-08-15T12:00:00.000Z',
      ]);
    });

    it('keeps the newest buckets when the gap exceeds the cap', () => {
      // A day-long outage with a cap of 3: the dashboard is better served by
      // the last three hours than by three hours from the start of the hole.
      const out = bucketsToCompute(new Date('2026-08-14T12:00:00Z'), latest, HOUR, 3);
      expect(out.map((d) => d.toISOString())).toEqual([
        '2026-08-15T10:00:00.000Z',
        '2026-08-15T11:00:00.000Z',
        '2026-08-15T12:00:00.000Z',
      ]);
    });

    it('does not walk all of history on a cold table', () => {
      const out = bucketsToCompute(null, latest, HOUR, 3);
      expect(out).toHaveLength(3);
      expect(out[out.length - 1]!.toISOString()).toBe('2026-08-15T12:00:00.000Z');
    });

    it('steps by whole days at DAY granularity', () => {
      const dayLatest = new Date('2026-08-14T00:00:00Z');
      const out = bucketsToCompute(new Date('2026-08-11T00:00:00Z'), dayLatest, DAY, 10);
      expect(out.map((d) => d.toISOString())).toEqual([
        '2026-08-12T00:00:00.000Z',
        '2026-08-13T00:00:00.000Z',
        '2026-08-14T00:00:00.000Z',
      ]);
    });
  });

  describe('rate', () => {
    it('divides', () => {
      expect(rate(3, 4)).toBe(0.75);
    });

    it('returns 0 rather than NaN or Infinity for an empty denominator', () => {
      // Every rate in the summary is computed over a `decisions` count that is
      // legitimately zero for a quiet channel; NaN would serialize to null and
      // Infinity would not serialize at all.
      expect(rate(0, 0)).toBe(0);
      expect(rate(5, 0)).toBe(0);
      expect(rate(1, -1)).toBe(0);
    });
  });

  describe('round4', () => {
    it('rounds to the precision confidence is stored at', () => {
      expect(round4(0.123456)).toBe(0.1235);
      expect(round4(1 / 3)).toBe(0.3333);
      expect(round4(1)).toBe(1);
    });
  });
});
