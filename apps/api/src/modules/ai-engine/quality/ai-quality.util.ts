import { AiQualityBucket } from '@prisma/client';

/**
 * Bucket arithmetic for the AI quality rollup.
 *
 * Everything here is UTC. Bucket boundaries have to agree between the writer
 * (the rollup job) and the reader (the API), and the only way two processes on
 * different hosts agree on "the start of the day" is if neither of them asks
 * the host what timezone it is in.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Start of the UTC hour containing `d`. */
export function floorToHour(d: Date): Date {
  return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

/** Start of the UTC day containing `d`. */
export function floorToDay(d: Date): Date {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
}

/** Length of one bucket at this granularity, in ms. */
export function bucketSizeMs(bucket: AiQualityBucket): number {
  return bucket === AiQualityBucket.DAY ? DAY_MS : HOUR_MS;
}

/** Start of the bucket containing `d` at this granularity. */
export function floorToBucket(d: Date, bucket: AiQualityBucket): Date {
  return bucket === AiQualityBucket.DAY ? floorToDay(d) : floorToHour(d);
}

/**
 * Start of the newest bucket that is definitely closed at `now`.
 *
 * One whole bucket behind the current one. The current bucket is still
 * accruing decisions, and a rollup writes each bucket exactly once — counting
 * an open bucket freezes a partial count as the final answer.
 */
export function latestClosedBucketStart(now: Date, bucket: AiQualityBucket): Date {
  return new Date(floorToBucket(now, bucket).getTime() - bucketSizeMs(bucket));
}

/**
 * The bucket starts to compute, oldest first.
 *
 * `lastComputed` is the newest bucket already in the table (null on a cold
 * table). The result is everything strictly after it up to `latestClosed`,
 * capped at `max` — and when capped it keeps the *newest* buckets, because a
 * dashboard showing the last day is worth more than one showing a week-old
 * hole. The skipped span is reported by the caller rather than silently lost.
 */
export function bucketsToCompute(
  lastComputed: Date | null,
  latestClosed: Date,
  bucket: AiQualityBucket,
  max: number,
): Date[] {
  const size = bucketSizeMs(bucket);
  const end = latestClosed.getTime();

  // Cold table: do the most recent `max` buckets rather than all of history.
  const start =
    lastComputed === null
      ? end - (max - 1) * size
      : lastComputed.getTime() + size;

  if (start > end) return [];

  const out: Date[] = [];
  for (let t = start; t <= end; t += size) out.push(new Date(t));

  return out.length > max ? out.slice(out.length - max) : out;
}

/** Safe division that returns 0 rather than NaN for an empty denominator. */
export function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/** Round to 4 decimal places — the precision `confidence_score` is stored at. */
export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
