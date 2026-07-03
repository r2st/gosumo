import { Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_REALTY_RATE_LIMIT,
  RateLimitRule,
  REALTY_RATE_LIMIT_BUCKETS,
} from './realty-hardening.constants';

export interface RateLimitDecision {
  allowed: boolean;
  /** Remaining quota in the current window (0 when blocked). */
  remaining: number;
  /** If blocked, how long (ms) until the window resets. */
  retryAfterMs: number;
  /** The effective ceiling that was applied. */
  limit: number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

/**
 * RealtyRateLimiter — per-(business, bucket) fixed-window API rate limiter
 * (Phase 7 hardening). Guards the realty REST surface against runaway loops and
 * abusive bursts before they reach the DB or the (metered) LLM.
 *
 * Windows live in process memory: correct for a single API instance, and the
 * exact algorithm (`INCR` + `PEXPIRE` on `gosumo:{businessId}:realty-rl:{bucket}`)
 * backs it with Redis in multi-instance production — the interface is identical
 * so swapping the store never changes callers. This mirrors
 * `NotificationRateLimiter` so the two limiters behave the same way.
 */
@Injectable()
export class RealtyRateLimiter {
  private readonly logger = new Logger(RealtyRateLimiter.name);
  private readonly windows = new Map<string, WindowState>();

  /** Resolve the rule for a bucket (named override or the global default). */
  ruleFor(bucket?: string): RateLimitRule {
    if (bucket && REALTY_RATE_LIMIT_BUCKETS[bucket]) {
      return REALTY_RATE_LIMIT_BUCKETS[bucket]!;
    }
    return DEFAULT_REALTY_RATE_LIMIT;
  }

  /**
   * Attempt to consume one unit of quota for (businessId, bucket).
   *
   * @param now injectable clock for deterministic tests (defaults to Date.now)
   */
  tryConsume(
    businessId: string,
    bucket = 'default',
    now: number = Date.now(),
  ): RateLimitDecision {
    const rule = this.ruleFor(bucket);
    const key = `${businessId}:${bucket}`;
    const existing = this.windows.get(key);

    // Start a fresh window if none exists or the current one has elapsed.
    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + rule.windowMs });
      return {
        allowed: true,
        remaining: rule.limit - 1,
        retryAfterMs: 0,
        limit: rule.limit,
      };
    }

    if (existing.count >= rule.limit) {
      const retryAfterMs = Math.max(0, existing.resetAt - now);
      this.logger.debug(
        `Realty rate limit hit for ${key}: ${existing.count}/${rule.limit}, retry in ${retryAfterMs}ms`,
      );
      return { allowed: false, remaining: 0, retryAfterMs, limit: rule.limit };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: rule.limit - existing.count,
      retryAfterMs: 0,
      limit: rule.limit,
    };
  }

  /** Inspect remaining quota without consuming it (diagnostics/readiness). */
  peek(
    businessId: string,
    bucket = 'default',
    now: number = Date.now(),
  ): RateLimitDecision {
    const rule = this.ruleFor(bucket);
    const existing = this.windows.get(`${businessId}:${bucket}`);
    if (!existing || now >= existing.resetAt) {
      return { allowed: true, remaining: rule.limit, retryAfterMs: 0, limit: rule.limit };
    }
    const remaining = Math.max(0, rule.limit - existing.count);
    return {
      allowed: remaining > 0,
      remaining,
      retryAfterMs: remaining > 0 ? 0 : Math.max(0, existing.resetAt - now),
      limit: rule.limit,
    };
  }

  /** Number of live (non-expired) windows — a coarse pressure signal. */
  activeWindows(now: number = Date.now()): number {
    let n = 0;
    for (const w of this.windows.values()) if (now < w.resetAt) n += 1;
    return n;
  }

  /** Clear all windows — primarily for tests. */
  reset(): void {
    this.windows.clear();
  }
}
