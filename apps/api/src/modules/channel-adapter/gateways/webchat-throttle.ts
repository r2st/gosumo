import { Injectable, Logger } from "@nestjs/common";

/**
 * Rate limiting for the WebChat gateway.
 *
 * `JwtAuthGuard` rations almost everything in this API by the simple fact that
 * a caller needs a token, and `AuthThrottleGuard` covers the `@Public()` HTTP
 * routes that are left. Neither reaches here: the gateway is a Socket.IO
 * namespace, not an HTTP route, and `AuthThrottleGuard` returns early on
 * anything that is not an HTTP context. So the widget entry point — the one
 * surface on this API that is *designed* to be hit by anonymous visitors from
 * arbitrary websites — had no ceiling at all.
 *
 * Both events it exposes do real, unbounded work:
 *
 *   - `chat:init` without a resumable session inserts a client, a channel
 *     contact and a conversation, then emits `conversation.created`, which
 *     fans out to the conversation, SLA and AI modules. A socket looping it
 *     mints tenant rows and downstream work as fast as the database will take
 *     them, and every row lands in a real business's inbox.
 *   - `chat:message` appends a message and hands it to the AI pipeline, which
 *     is an outbound LLM call. That one costs money per event.
 *
 * The windows are fixed and live in process memory, matching
 * `AuthThrottleLimiter` — exact for the single API instance this deployment
 * runs, and shaped so the Redis-backed version is a store swap rather than a
 * caller change. Like that limiter the IP key space is attacker-controlled, so
 * `sweep()` bounds it; without that, the fix for one denial-of-service would
 * be a slower one.
 */

const MINUTE = 60_000;

/** A fixed-window ceiling: `limit` events per `windowMs`. */
export interface ThrottleWindow {
  limit: number;
  windowMs: number;
}

export const WEBCHAT_THROTTLE_RULES = {
  /**
   * New sessions per caller IP. Charged only when a session is actually
   * created — a visitor replaying the token they were issued is resuming, not
   * creating, so a reconnect loop on a flaky connection never trips this.
   *
   * One real visitor spends exactly one. The ceiling therefore only binds on
   * someone opening sessions they have no intention of using, and is set well
   * above what a carrier-NAT'd handful of genuine visitors to one small
   * business's site would spend in a quarter of an hour.
   */
  session: { limit: 30, windowMs: 15 * MINUTE } as ThrottleWindow,

  /**
   * Messages per session. Sessions are unforgeable, so this is a per-visitor
   * ceiling. Sized above a fast human typing continuously and below what makes
   * the LLM behind the pipeline worth abusing.
   */
  message: { limit: 60, windowMs: 5 * MINUTE } as ThrottleWindow,

  /**
   * Messages per caller IP, across every session it holds. The per-session
   * ceiling alone still lets one host open its full session quota and spend
   * every session's messages; this is what bounds the total.
   */
  messageIp: { limit: 300, windowMs: 5 * MINUTE } as ThrottleWindow,
} as const;

export type WebChatThrottleBucket = keyof typeof WEBCHAT_THROTTLE_RULES;

/**
 * Past this many resident windows the limiter sweeps elapsed ones before
 * admitting a new key.
 */
export const WEBCHAT_THROTTLE_SWEEP_THRESHOLD = 10_000;

interface WindowState {
  count: number;
  resetAt: number;
}

@Injectable()
export class WebChatThrottle {
  private readonly logger = new Logger(WebChatThrottle.name);
  private readonly windows = new Map<string, WindowState>();

  /**
   * Charge one event against `bucket` for `key`, and report whether it is
   * admitted.
   *
   * A `null` key is never chargeable: it means we could not identify the
   * caller, and grouping every such caller under one window would let any one
   * of them lock out the rest.
   *
   * @param now injectable clock for deterministic tests
   */
  consume(
    bucket: WebChatThrottleBucket,
    key: string | null,
    now: number = Date.now(),
  ): boolean {
    if (!key) return true;

    this.sweep(now);

    const window = WEBCHAT_THROTTLE_RULES[bucket];
    const mapKey = `${bucket}:${key}`;
    const existing = this.windows.get(mapKey);

    if (!existing || now >= existing.resetAt) {
      this.windows.set(mapKey, { count: 1, resetAt: now + window.windowMs });
      return true;
    }

    if (existing.count >= window.limit) {
      this.logger.warn(
        `WebChat throttle: bucket "${bucket}" exhausted ` +
          `(${window.limit}/${window.windowMs}ms)`,
      );
      return false;
    }

    // The event that consumes the last unit is admitted; the next one is not.
    existing.count += 1;
    return true;
  }

  /**
   * Drop elapsed windows once the map has grown past the threshold. Their
   * quota has already reset, so discarding them changes no decision — and
   * gating the pass on size keeps the common event off it entirely.
   */
  private sweep(now: number): void {
    if (this.windows.size < WEBCHAT_THROTTLE_SWEEP_THRESHOLD) return;
    for (const [key, state] of this.windows) {
      if (now >= state.resetAt) this.windows.delete(key);
    }
  }

  /** Total resident keys, live or elapsed — the number `sweep()` bounds. */
  trackedWindows(): number {
    return this.windows.size;
  }

  /** Clear all windows — primarily for tests. */
  reset(): void {
    this.windows.clear();
  }
}
