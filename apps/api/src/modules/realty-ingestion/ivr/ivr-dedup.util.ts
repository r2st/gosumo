/**
 * IVR trigger de-duplication (pure, unit-tested).
 *
 * A buyer often rings the missed-call number two or three times in quick
 * succession before giving up. Each ring fires a webhook, but we must only
 * greet them on WhatsApp once — a burst of greetings reads as spam and burns the
 * 24h WhatsApp service window. This tracks the last trigger time per (business,
 * phone) and suppresses repeats inside a 5-minute window.
 *
 * In-memory and per-process by design: a single API instance is the deploy
 * topology, the window is short, and the only cost of a rare cross-instance
 * miss is one duplicate greeting. It is deliberately not a shared/Redis store —
 * keeping it pure makes the 5-minute rule exhaustively testable with an injected
 * clock.
 */

/** Default suppression window: repeated calls within 5 minutes greet once. */
export const IVR_DEDUP_WINDOW_MS = 5 * 60 * 1000;

export class IvrDedupTracker {
  private readonly lastTrigger = new Map<string, number>();

  constructor(private readonly windowMs: number = IVR_DEDUP_WINDOW_MS) {}

  /**
   * Record a call and report whether it should trigger the WhatsApp greeting.
   * Returns true (and stamps the clock) on the first call or one outside the
   * window; false for a repeat inside the window (no re-stamp — the window is
   * measured from the first call of the burst, so a persistent redialer can't
   * hold it open indefinitely).
   */
  shouldTrigger(businessId: string, phone: string, now: number = Date.now()): boolean {
    this.evictExpired(now);
    const key = `${businessId}:${phone}`;
    const last = this.lastTrigger.get(key);
    if (last !== undefined && now - last < this.windowMs) {
      return false;
    }
    this.lastTrigger.set(key, now);
    return true;
  }

  /** Drop entries older than the window so the map can't grow unbounded. */
  private evictExpired(now: number): void {
    for (const [key, ts] of this.lastTrigger) {
      if (now - ts >= this.windowMs) this.lastTrigger.delete(key);
    }
  }
}
