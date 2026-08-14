/**
 * RealtyRateLimiter — the branches `realty-rate-limiter.spec.ts` does not reach.
 *
 * That file drives the limiter with an explicit bucket and an explicit clock,
 * which is the right way to test the algorithm deterministically but means the
 * default arguments are never exercised. The defaults are what production
 * actually uses: `RealtyRateLimitGuard` calls `tryConsume(businessId)` with no
 * bucket on an unannotated route, and nothing passes a clock. This file covers
 * those paths, plus `peek()` against an exhausted window — the case that decides
 * whether the readiness endpoint reports pressure or reports nothing.
 */

import { RealtyRateLimiter } from './realty-rate-limiter';
import {
  DEFAULT_REALTY_RATE_LIMIT,
  REALTY_RATE_LIMIT_BUCKETS,
} from './realty-hardening.constants';

const BIZ = '00000000-0000-4000-a000-000000000001';

describe('RealtyRateLimiter — default arguments and peek edges', () => {
  let limiter: RealtyRateLimiter;

  beforeEach(() => {
    limiter = new RealtyRateLimiter();
  });

  describe('the implicit "default" bucket', () => {
    it('applies the global rule when no bucket is named', () => {
      const d = limiter.tryConsume(BIZ);

      expect(d.allowed).toBe(true);
      expect(d.limit).toBe(DEFAULT_REALTY_RATE_LIMIT.limit);
      expect(d.remaining).toBe(DEFAULT_REALTY_RATE_LIMIT.limit - 1);
    });

    it('keeps the unnamed bucket separate from a named one', () => {
      const { limit } = REALTY_RATE_LIMIT_BUCKETS['ai-turn']!;
      for (let i = 0; i < limit; i += 1) limiter.tryConsume(BIZ, 'ai-turn');

      // ai-turn is exhausted; the default bucket has its own untouched window.
      expect(limiter.tryConsume(BIZ, 'ai-turn').allowed).toBe(false);
      expect(limiter.tryConsume(BIZ).allowed).toBe(true);
    });

    it('accumulates across calls that supply no clock', () => {
      const first = limiter.tryConsume(BIZ);
      const second = limiter.tryConsume(BIZ);

      // Both land in the same wall-clock window, so the count carries over.
      expect(second.remaining).toBe(first.remaining - 1);
    });
  });

  describe('the implicit wall clock', () => {
    it('blocks at the ceiling without an injected clock', () => {
      const { limit } = REALTY_RATE_LIMIT_BUCKETS['dlq-replay']!;
      for (let i = 0; i < limit; i += 1) {
        expect(limiter.tryConsume(BIZ, 'dlq-replay').allowed).toBe(true);
      }

      const blocked = limiter.tryConsume(BIZ, 'dlq-replay');
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it('peeks the live window without a clock, and without consuming', () => {
      limiter.tryConsume(BIZ, 'ai-turn');
      const { limit } = REALTY_RATE_LIMIT_BUCKETS['ai-turn']!;

      const peeked = limiter.peek(BIZ, 'ai-turn');
      expect(peeked.remaining).toBe(limit - 1);
      // Peeking twice reports the same thing — it is not a consume.
      expect(limiter.peek(BIZ, 'ai-turn').remaining).toBe(limit - 1);
    });

    it('peeks the default bucket with no arguments beyond the tenant', () => {
      const peeked = limiter.peek(BIZ);

      expect(peeked.allowed).toBe(true);
      expect(peeked.remaining).toBe(DEFAULT_REALTY_RATE_LIMIT.limit);
      expect(peeked.retryAfterMs).toBe(0);
    });

    it('counts live windows with no clock supplied', () => {
      expect(limiter.activeWindows()).toBe(0);

      limiter.tryConsume(BIZ, 'ai-turn');
      limiter.tryConsume(BIZ, 'ingest');

      expect(limiter.activeWindows()).toBe(2);
    });
  });

  describe('peek against an exhausted window', () => {
    it('reports not-allowed and a retry-after once the quota is gone', () => {
      const { limit, windowMs } = REALTY_RATE_LIMIT_BUCKETS['ai-turn']!;
      const now = 10_000;
      for (let i = 0; i < limit; i += 1) limiter.tryConsume(BIZ, 'ai-turn', now);

      const peeked = limiter.peek(BIZ, 'ai-turn', now);

      expect(peeked.allowed).toBe(false);
      expect(peeked.remaining).toBe(0);
      expect(peeked.retryAfterMs).toBe(windowMs);
      expect(peeked.limit).toBe(limit);
    });

    it('never reports a negative retry-after once the window has rolled over', () => {
      const { limit, windowMs } = REALTY_RATE_LIMIT_BUCKETS['ai-turn']!;
      const now = 10_000;
      for (let i = 0; i < limit; i += 1) limiter.tryConsume(BIZ, 'ai-turn', now);

      // Past the reset: peek takes the fresh-window path, so quota is full.
      const peeked = limiter.peek(BIZ, 'ai-turn', now + windowMs + 1);

      expect(peeked.allowed).toBe(true);
      expect(peeked.remaining).toBe(limit);
      expect(peeked.retryAfterMs).toBe(0);
    });

    it('reports the shrinking retry-after as the window drains', () => {
      const { limit, windowMs } = REALTY_RATE_LIMIT_BUCKETS['ai-turn']!;
      const now = 10_000;
      for (let i = 0; i < limit; i += 1) limiter.tryConsume(BIZ, 'ai-turn', now);

      const halfway = limiter.peek(BIZ, 'ai-turn', now + windowMs / 2);

      expect(halfway.retryAfterMs).toBe(windowMs / 2);
    });
  });
});
