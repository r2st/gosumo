/**
 * RealtyRateLimiter unit tests — Phase 7 hardening.
 *
 * Deterministic via the injectable `now` clock. Covers: window consumption,
 * blocking at the ceiling, per-window reset, bucket-specific rules, per-tenant
 * isolation, peek (non-consuming), and the active-window pressure signal.
 */

import { RealtyRateLimiter } from './realty-rate-limiter';
import {
  DEFAULT_REALTY_RATE_LIMIT,
  REALTY_RATE_LIMIT_BUCKETS,
} from './realty-hardening.constants';

const BIZ = '00000000-0000-4000-a000-000000000001';
const BIZ2 = '00000000-0000-4000-a000-000000000002';

describe('RealtyRateLimiter', () => {
  let limiter: RealtyRateLimiter;

  beforeEach(() => {
    limiter = new RealtyRateLimiter();
  });

  it('resolves the default rule and named bucket rules', () => {
    expect(limiter.ruleFor()).toBe(DEFAULT_REALTY_RATE_LIMIT);
    expect(limiter.ruleFor('unknown')).toBe(DEFAULT_REALTY_RATE_LIMIT);
    expect(limiter.ruleFor('ai-turn')).toBe(REALTY_RATE_LIMIT_BUCKETS['ai-turn']);
  });

  it('allows requests up to the ceiling then blocks with a retry-after', () => {
    const { limit, windowMs } = REALTY_RATE_LIMIT_BUCKETS['ai-turn']!;
    const now = 1_000;
    for (let i = 0; i < limit; i += 1) {
      const d = limiter.tryConsume(BIZ, 'ai-turn', now);
      expect(d.allowed).toBe(true);
      expect(d.remaining).toBe(limit - 1 - i);
    }
    const blocked = limiter.tryConsume(BIZ, 'ai-turn', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBe(windowMs); // full window remains at t=now
  });

  it('starts a fresh window once the previous one elapses', () => {
    const { limit, windowMs } = REALTY_RATE_LIMIT_BUCKETS['ai-turn']!;
    const start = 5_000;
    for (let i = 0; i < limit; i += 1) limiter.tryConsume(BIZ, 'ai-turn', start);
    expect(limiter.tryConsume(BIZ, 'ai-turn', start).allowed).toBe(false);
    // After the window rolls over, quota is replenished.
    const after = limiter.tryConsume(BIZ, 'ai-turn', start + windowMs);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(limit - 1);
  });

  it('isolates windows per tenant', () => {
    const { limit } = REALTY_RATE_LIMIT_BUCKETS['ai-turn']!;
    for (let i = 0; i < limit; i += 1) limiter.tryConsume(BIZ, 'ai-turn', 100);
    // BIZ is exhausted, BIZ2 is untouched.
    expect(limiter.tryConsume(BIZ, 'ai-turn', 100).allowed).toBe(false);
    expect(limiter.tryConsume(BIZ2, 'ai-turn', 100).allowed).toBe(true);
  });

  it('peek reports quota without consuming it', () => {
    const before = limiter.peek(BIZ, 'ai-turn', 0);
    expect(before.remaining).toBe(REALTY_RATE_LIMIT_BUCKETS['ai-turn']!.limit);
    // Peeking twice does not decrement.
    expect(limiter.peek(BIZ, 'ai-turn', 0).remaining).toBe(before.remaining);
  });

  it('counts only live windows for the pressure signal', () => {
    limiter.tryConsume(BIZ, 'default', 0);
    limiter.tryConsume(BIZ2, 'default', 0);
    expect(limiter.activeWindows(0)).toBe(2);
    // Windows expire after the default window length.
    expect(limiter.activeWindows(DEFAULT_REALTY_RATE_LIMIT.windowMs + 1)).toBe(0);
  });

  it('reset clears all windows', () => {
    limiter.tryConsume(BIZ, 'ai-turn', 0);
    limiter.reset();
    expect(limiter.activeWindows(0)).toBe(0);
  });
});
