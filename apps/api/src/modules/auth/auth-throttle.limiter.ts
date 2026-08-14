import { Injectable, Logger } from '@nestjs/common';
import {
  AuthThrottleRule,
  AUTH_THROTTLE_BUCKETS,
  AUTH_THROTTLE_SWEEP_THRESHOLD,
  ThrottleWindow,
} from './auth-throttle.constants';

export interface ThrottleDecision {
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
 * AuthThrottleLimiter — fixed-window rationing for the unauthenticated auth
 * routes, keyed by caller IP and (where the route acts on someone else's
 * behalf) by the subject named in the rule.
 *
 * Windows live in process memory. That is exact for a single API instance —
 * which is what this deployment runs — and deliberately shaped like
 * `RealtyRateLimiter` and `NotificationRateLimiter` so that the Redis-backed
 * version (`INCR` + `PEXPIRE` on `gosumo:authrl:{bucket}:{key}`) is a store
 * swap and not a caller change.
 *
 * The one way this limiter differs from its tenant-keyed siblings is that its
 * key space belongs to the attacker: anyone can present a new source address.
 * Hence `sweep()` — without it the mitigation for one denial-of-service would
 * be a slower one.
 */
@Injectable()
export class AuthThrottleLimiter {
  private readonly logger = new Logger(AuthThrottleLimiter.name);
  private readonly windows = new Map<string, WindowState>();

  /** The rule for a bucket, or `undefined` when the bucket is unknown. */
  ruleFor(bucket: string): AuthThrottleRule | undefined {
    return AUTH_THROTTLE_BUCKETS[bucket];
  }

  /**
   * Consume one unit against every dimension the bucket defines.
   *
   * Dimensions are evaluated in order and the *first* breach is returned, so a
   * caller who has exhausted the IP window is not also charged against the
   * subject window — otherwise a blocked attacker would keep burning down a
   * victim's quota as a side effect.
   *
   * @param now injectable clock for deterministic tests (defaults to Date.now)
   */
  consume(
    bucket: string,
    dimensions: { ip: string | null; subject?: string | null },
    now: number = Date.now(),
  ): ThrottleDecision {
    const rule = this.ruleFor(bucket);
    // An unknown bucket must not silently become "unlimited" *or* "blocked":
    // the contract spec is what catches it, and at runtime the safe reading of
    // a missing rule is that this route was never meant to be rationed.
    if (!rule) {
      return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0, limit: 0 };
    }

    this.sweep(now);

    // A caller we cannot key on (no IP at all) is not chargeable — grouping
    // every such request together would let one of them lock out the rest.
    let outcome: ThrottleDecision | null = null;

    if (dimensions.ip) {
      const ipDecision = this.tryWindow(`${bucket}:ip:${dimensions.ip}`, rule.ip, now);
      if (!ipDecision.allowed) {
        this.logger.warn(
          `Auth throttle: bucket "${bucket}" exhausted for ip ${dimensions.ip} ` +
            `(${rule.ip.limit}/${rule.ip.windowMs}ms)`,
        );
        return ipDecision;
      }
      outcome = ipDecision;
    }

    if (rule.subject && dimensions.subject) {
      const key = `${bucket}:sub:${dimensions.subject.toLowerCase()}`;
      const subjectDecision = this.tryWindow(key, rule.subject, now);
      if (!subjectDecision.allowed) {
        // The subject is a user-supplied email; log the bucket, not the value.
        this.logger.warn(
          `Auth throttle: bucket "${bucket}" exhausted for a single subject ` +
            `(${rule.subject.limit}/${rule.subject.windowMs}ms)`,
        );
      }
      // The subject window is the narrower, more specific one — report it, so
      // the quota headers describe the ceiling the caller will actually hit.
      return subjectDecision;
    }

    // The decision returned is the one from the charge that was made, never a
    // re-read of the window afterwards: the request that consumes the *last*
    // unit is admitted, even though the window it leaves behind has none left.
    return (
      outcome ?? { allowed: true, remaining: rule.ip.limit, retryAfterMs: 0, limit: rule.ip.limit }
    );
  }

  /** Charge one request against a single named window. */
  private tryWindow(key: string, window: ThrottleWindow, now: number): ThrottleDecision {
    const existing = this.windows.get(key);

    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + window.windowMs });
      return {
        allowed: true,
        remaining: window.limit - 1,
        retryAfterMs: 0,
        limit: window.limit,
      };
    }

    if (existing.count >= window.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, existing.resetAt - now),
        limit: window.limit,
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: window.limit - existing.count,
      retryAfterMs: 0,
      limit: window.limit,
    };
  }

  /**
   * Drop elapsed windows once the map has grown past the threshold. Expired
   * entries are dead weight — their quota has already reset — so discarding
   * them changes no decision, and doing the pass only when the map is large
   * keeps the common request off it entirely.
   */
  private sweep(now: number): void {
    if (this.windows.size < AUTH_THROTTLE_SWEEP_THRESHOLD) return;
    for (const [key, state] of this.windows) {
      if (now >= state.resetAt) this.windows.delete(key);
    }
  }

  /** Number of live (non-expired) windows — a coarse pressure signal. */
  activeWindows(now: number = Date.now()): number {
    let n = 0;
    for (const w of this.windows.values()) if (now < w.resetAt) n += 1;
    return n;
  }

  /**
   * Total resident keys, live or elapsed. This is the number `sweep()` bounds
   * and the one that matters for memory — `activeWindows()` cannot distinguish
   * "swept" from "expired but still held".
   */
  trackedWindows(): number {
    return this.windows.size;
  }

  /** Clear all windows — primarily for tests. */
  reset(): void {
    this.windows.clear();
  }
}
