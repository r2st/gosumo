/**
 * Per-query timing, and the slow-query log.
 *
 * The API has request-level timing (`LoggingInterceptor` logs a duration on the
 * way out) and it has nothing below that. So "this endpoint took 4 seconds" was
 * always where the trail ended: whether that was one bad query, thirty good
 * ones in a loop, or an upstream provider was a question you answered by
 * reading code and guessing. On a box whose Postgres is capped at 50
 * connections and shared with another service, a query that holds a connection
 * for a second is not a latency problem, it is a capacity problem — and it is
 * invisible until the pool is exhausted and *every* endpoint fails at once.
 *
 * This makes the slow ones say so, with the model, the action, and the
 * correlation id that ties the line back to the request or job that caused it.
 *
 * ## Level, and why it is not `warn` by default
 *
 * A slow query is logged at `warn` and a *very* slow one at `error`, because in
 * a healthy production neither fires. The threshold is what keeps that true:
 * 500ms is roughly two orders of magnitude above this schema's indexed lookups,
 * so a line here means something is genuinely wrong (a missing index, a table
 * scan on a grown table, a lock wait) rather than "the database was busy". A
 * threshold low enough to fire routinely trains the on-call to filter the level
 * out, and then the real one is missed too.
 *
 * ## What is measured
 *
 * Wall-clock around the middleware chain: the engine round trip plus
 * serialization, i.e. what the caller actually waited. That is deliberately not
 * the database's own execution time — `log: ['query']` reports that, and the
 * gap between the two (connection-pool wait) is exactly the symptom worth
 * seeing here. A query that took 2ms in Postgres and 900ms to get a connection
 * is the pool telling you it is full, and only this measurement shows it.
 *
 * Failures are timed too. A query that throws after 30 seconds is the most
 * important slow query in the process and the one a success-only timer misses.
 */

import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { correlationTag, getRequestContext } from '../context/request-context';

/** Above this, a query is logged. */
export const DEFAULT_SLOW_QUERY_MS = 500;

/**
 * Above this, the line is an `error` rather than a `warn`.
 *
 * Ten times the warn threshold. At five seconds a single query has outlived the
 * webhook deadline every channel provider enforces, so whatever it belongs to
 * has already failed for the caller — that is a different severity from "this
 * page felt slow".
 */
export const CRITICAL_QUERY_MS = 5_000;

/** Read the threshold override, ignoring anything that is not a positive number. */
export function configuredSlowQueryMs(
  raw: string | undefined = process.env['SLOW_QUERY_THRESHOLD_MS'],
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SLOW_QUERY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLOW_QUERY_MS;
  return parsed;
}

/** Running totals, for the readiness probe and for tests. */
export interface QueryTimingStats {
  /** Queries observed since boot. */
  total: number;
  /** Of those, how many were over the threshold. */
  slow: number;
  /** The slowest single query seen, and what it was. */
  slowest: { model: string; action: string; durationMs: number } | null;
}

/**
 * Process-wide counters.
 *
 * A counter rather than a histogram on purpose: this exists so an operator can
 * ask "is the database the problem right now" from the readiness body without
 * a metrics stack, and three numbers answer that. Anything finer belongs in
 * Postgres' own `pg_stat_statements`, which is already authoritative and does
 * not cost this process anything to keep.
 */
export class QueryTimingRecorder {
  private totalCount = 0;
  private slowCount = 0;
  private slowestSeen: QueryTimingStats['slowest'] = null;

  record(model: string, action: string, durationMs: number, thresholdMs: number): void {
    this.totalCount += 1;
    if (durationMs < thresholdMs) return;

    this.slowCount += 1;
    if (!this.slowestSeen || durationMs > this.slowestSeen.durationMs) {
      this.slowestSeen = { model, action, durationMs };
    }
  }

  stats(): QueryTimingStats {
    return {
      total: this.totalCount,
      slow: this.slowCount,
      slowest: this.slowestSeen ? { ...this.slowestSeen } : null,
    };
  }

  reset(): void {
    this.totalCount = 0;
    this.slowCount = 0;
    this.slowestSeen = null;
  }
}

/** The one recorder the app reads; the middleware below writes to it. */
export const queryTimingRecorder = new QueryTimingRecorder();

export interface QueryTimingOptions {
  thresholdMs?: number;
  recorder?: QueryTimingRecorder;
  logger?: Logger;
  /** Injectable clock, so tests do not depend on the event loop. */
  now?: () => number;
}

/**
 * Build the timing middleware.
 *
 * Register it **before** any middleware that rewrites arguments, so it is the
 * outermost link in the chain and measures the whole cost of the query rather
 * than everything except the part this app added.
 */
export function createQueryTimingMiddleware(
  options: QueryTimingOptions = {},
): Prisma.Middleware {
  const logger = options.logger ?? new Logger('PrismaQueryTiming');
  const thresholdMs = options.thresholdMs ?? configuredSlowQueryMs();
  const recorder = options.recorder ?? queryTimingRecorder;
  const now = options.now ?? (() => Date.now());

  return async (params, next) => {
    const startedAt = now();
    try {
      return await next(params);
    } finally {
      const durationMs = now() - startedAt;
      // Raw queries have no model; naming them `$raw` keeps the line's shape
      // constant so a log query can group on it.
      const model = params.model ?? '$raw';
      recorder.record(model, params.action, durationMs, thresholdMs);

      if (durationMs >= thresholdMs) {
        const businessId = getRequestContext()?.businessId;
        const tenant = businessId ? ` | business ${businessId}` : '';
        const line =
          `${correlationTag()}Slow query: ${model}.${params.action} took ${durationMs}ms ` +
          `(threshold ${thresholdMs}ms)${tenant}`;

        if (durationMs >= CRITICAL_QUERY_MS) {
          logger.error(line);
        } else {
          logger.warn(line);
        }
      }
    }
  };
}
