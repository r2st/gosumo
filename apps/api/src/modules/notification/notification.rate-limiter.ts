import { Injectable, Logger } from '@nestjs/common';
import { NotificationTemplateChannel } from '@prisma/client';
import { CHANNEL_RATE_LIMITS, RateLimitRule } from './notification.constants';

export interface RateLimitDecision {
  allowed: boolean;
  /** Remaining quota in the current window (0 when blocked). */
  remaining: number;
  /** If blocked, how long (ms) until the window resets. */
  retryAfterMs: number;
}

interface WindowState {
  count: number;
  resetAt: number;
}

/**
 * NotificationRateLimiter — per-(business, channel) fixed-window rate limiter.
 *
 * Enforces the per-second ceilings in {@link CHANNEL_RATE_LIMITS} (e.g. WhatsApp
 * 80 msg/sec) so a burst of notifications never trips a provider's limit.
 *
 * This implementation keeps windows in process memory. It is correct for a
 * single API/worker instance; in a multi-instance production deployment the
 * same algorithm is backed by Redis (`INCR` + `PEXPIRE` on
 * `gosumo:{businessId}:notif-rl:{channel}`) so the limit is shared across pods.
 * The interface is identical, so swapping the store does not change callers.
 */
@Injectable()
export class NotificationRateLimiter {
  private readonly logger = new Logger(NotificationRateLimiter.name);
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly rules: Record<
      NotificationTemplateChannel,
      RateLimitRule
    > = CHANNEL_RATE_LIMITS,
  ) {}

  /**
   * Attempt to consume one unit of quota for (businessId, channel).
   *
   * @param now injectable clock for deterministic tests (defaults to Date.now)
   */
  tryConsume(
    businessId: string,
    channel: NotificationTemplateChannel,
    now: number = Date.now(),
  ): RateLimitDecision {
    const rule = this.rules[channel];
    const key = `${businessId}:${channel}`;
    const existing = this.windows.get(key);

    // Start a fresh window if none exists or the current one has elapsed.
    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + rule.windowMs });
      return { allowed: true, remaining: rule.limit - 1, retryAfterMs: 0 };
    }

    if (existing.count >= rule.limit) {
      const retryAfterMs = Math.max(0, existing.resetAt - now);
      this.logger.debug(
        `Rate limit hit for ${key}: ${existing.count}/${rule.limit}, retry in ${retryAfterMs}ms`,
      );
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: rule.limit - existing.count,
      retryAfterMs: 0,
    };
  }

  /**
   * Inspect remaining quota without consuming it (for diagnostics/preview).
   */
  peek(
    businessId: string,
    channel: NotificationTemplateChannel,
    now: number = Date.now(),
  ): RateLimitDecision {
    const rule = this.rules[channel];
    const existing = this.windows.get(`${businessId}:${channel}`);
    if (!existing || now >= existing.resetAt) {
      return { allowed: true, remaining: rule.limit, retryAfterMs: 0 };
    }
    const remaining = Math.max(0, rule.limit - existing.count);
    return {
      allowed: remaining > 0,
      remaining,
      retryAfterMs: remaining > 0 ? 0 : Math.max(0, existing.resetAt - now),
    };
  }

  /** Clear all windows — primarily for tests. */
  reset(): void {
    this.windows.clear();
  }
}
