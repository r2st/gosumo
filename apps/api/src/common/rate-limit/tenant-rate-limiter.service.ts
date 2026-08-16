import { Injectable, Logger } from '@nestjs/common';
import {
  TenantRateLimitRule,
  TENANT_RATE_LIMIT_BUCKETS,
  TENANT_RATE_LIMIT_SWEEP_THRESHOLD,
} from './tenant-rate-limit.constants';

export interface TenantRateLimitDecision {
  allowed: boolean;
  /** Remaining quota in the current window (0 when blocked). */
  remaining: number;
  /** If blocked, how long (ms) until the window resets. */
  retryAfterMs: number;
  /** The effective ceiling that was applied. */
  limit: number;
  /** Epoch ms at which the current window resets. */
  resetAt: number;
  /**
   * True when the bucket named on the route has no rule. The request is
   * admitted — refusing traffic because of our own typo would be worse — but
   * the caller is told so it can be logged once rather than silently.
   */
  unknownBucket: boolean;
}

interface WindowState {
  count: number;
  resetAt: number;
}

/**
 * TenantRateLimiter — fixed-window rationing of the authenticated API, keyed
 * by `(businessId, bucket)`.
 *
 * Windows live in process memory. That is exact for a single API instance,
 * which is what this deployment runs, and the shape is deliberately identical
 * to `AuthThrottleLimiter`, `RealtyRateLimiter` and `NotificationRateLimiter`
 * so the Redis-backed version (`INCR` + `PEXPIRE` on
 * `gosumo:{businessId}:rl:{bucket}`) is a store swap and not a caller change.
 *
 * Fixed windows, not a sliding log or token bucket, for the same reason the
 * siblings use them: the failure this guards against is a loop, and a loop
 * exhausts any of the three in the first fraction of a window. The burst a
 * fixed window lets through at a boundary — up to 2× the limit across two
 * adjacent windows — is real, and it is uninteresting here because every limit
 * is set an order of magnitude above legitimate use. Paying for per-request
 * timestamps to close it would be optimising the wrong number.
 */
@Injectable()
export class TenantRateLimiter {
  private readonly logger = new Logger(TenantRateLimiter.name);
  private readonly windows = new Map<string, WindowState>();

  /** The rule for a bucket, or `undefined` when the bucket is unknown. */
  ruleFor(bucket: string): TenantRateLimitRule | undefined {
    return TENANT_RATE_LIMIT_BUCKETS[bucket];
  }

  /**
   * Charge one request against `(businessId, bucket)`.
   *
   * @param now injectable clock for deterministic tests (defaults to Date.now)
   */
  consume(
    businessId: string,
    bucket: string,
    now: number = Date.now(),
  ): TenantRateLimitDecision {
    const rule = this.ruleFor(bucket);

    // An unknown bucket admits the request. The alternative — treating a
    // missing rule as "block" — turns a typo in a decorator into a 429 on a
    // route that worked yesterday, for every tenant, with a message that
    // describes a quota nobody exceeded. The contract spec is what catches the
    // typo; this is what keeps it from being an outage in the meantime.
    if (!rule) {
      return {
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER,
        retryAfterMs: 0,
        limit: 0,
        resetAt: now,
        unknownBucket: true,
      };
    }

    this.sweep(now);

    const key = `${businessId}:${bucket}`;
    const existing = this.windows.get(key);

    if (!existing || now >= existing.resetAt) {
      const resetAt = now + rule.windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return {
        allowed: true,
        remaining: rule.limit - 1,
        retryAfterMs: 0,
        limit: rule.limit,
        resetAt,
        unknownBucket: false,
      };
    }

    if (existing.count >= rule.limit) {
      // DEBUG, not WARN. A tenant hitting a ceiling is the limiter working, it
      // is self-correcting, and at 300/minute a single loop would write
      // thousands of WARN lines a minute — which is how the level stops
      // meaning anything. What is worth a WARN is a tenant that keeps hitting
      // it, and that is a question for the metrics, not for one request.
      this.logger.debug(
        `Tenant rate limit reached: bucket "${bucket}" for ${businessId} ` +
          `(${rule.limit}/${rule.windowMs}ms)`,
      );
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, existing.resetAt - now),
        limit: rule.limit,
        resetAt: existing.resetAt,
        unknownBucket: false,
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: rule.limit - existing.count,
      retryAfterMs: 0,
      limit: rule.limit,
      resetAt: existing.resetAt,
      unknownBucket: false,
    };
  }

  /**
   * Read remaining quota without consuming it.
   *
   * Used by diagnostics and by the tests; never on the request path, because a
   * peek followed by a consume is two decisions where the contract promises
   * one.
   */
  peek(
    businessId: string,
    bucket: string,
    now: number = Date.now(),
  ): TenantRateLimitDecision {
    const rule = this.ruleFor(bucket);
    if (!rule) {
      return {
        allowed: true,
        remaining: Number.MAX_SAFE_INTEGER,
        retryAfterMs: 0,
        limit: 0,
        resetAt: now,
        unknownBucket: true,
      };
    }

    const existing = this.windows.get(`${businessId}:${bucket}`);
    if (!existing || now >= existing.resetAt) {
      return {
        allowed: true,
        remaining: rule.limit,
        retryAfterMs: 0,
        limit: rule.limit,
        resetAt: now + rule.windowMs,
        unknownBucket: false,
      };
    }

    const remaining = Math.max(0, rule.limit - existing.count);
    return {
      allowed: remaining > 0,
      remaining,
      retryAfterMs: remaining > 0 ? 0 : Math.max(0, existing.resetAt - now),
      limit: rule.limit,
      resetAt: existing.resetAt,
      unknownBucket: false,
    };
  }

  /**
   * Drop elapsed windows once the map has grown past the threshold.
   *
   * An expired entry's quota has already reset, so discarding it changes no
   * decision; doing the pass only when the map is large keeps the ordinary
   * request off it entirely.
   */
  private sweep(now: number): void {
    if (this.windows.size < TENANT_RATE_LIMIT_SWEEP_THRESHOLD) return;
    for (const [key, state] of this.windows) {
      if (now >= state.resetAt) this.windows.delete(key);
    }
  }

  /** Live (non-elapsed) windows — a coarse pressure signal. */
  activeWindows(now: number = Date.now()): number {
    let n = 0;
    for (const w of this.windows.values()) if (now < w.resetAt) n += 1;
    return n;
  }

  /**
   * Total resident keys, live or elapsed. This is the number `sweep()` bounds
   * and the one that matters for memory — `activeWindows()` cannot tell
   * "swept" from "expired but still held".
   */
  trackedWindows(): number {
    return this.windows.size;
  }

  /** Clear all windows — tests, and a manual reset during an incident. */
  reset(): void {
    this.windows.clear();
  }
}
