import { TenantRateLimiter } from './tenant-rate-limiter.service';
import {
  TENANT_RATE_LIMIT_BUCKETS,
  TENANT_RATE_LIMIT_SWEEP_THRESHOLD,
} from './tenant-rate-limit.constants';

const BUCKET = 'ai-invoke';
const RULE = TENANT_RATE_LIMIT_BUCKETS[BUCKET]!;

describe('TenantRateLimiter', () => {
  let limiter: TenantRateLimiter;

  beforeEach(() => {
    limiter = new TenantRateLimiter();
  });

  it('admits the first request and reports the ceiling', () => {
    const decision = limiter.consume('b1', BUCKET, 1_000);

    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(RULE.limit);
    expect(decision.remaining).toBe(RULE.limit - 1);
    expect(decision.resetAt).toBe(1_000 + RULE.windowMs);
  });

  it('admits exactly the limit, then blocks', () => {
    for (let i = 0; i < RULE.limit; i++) {
      expect(limiter.consume('b1', BUCKET, 1_000).allowed).toBe(true);
    }

    expect(limiter.consume('b1', BUCKET, 1_000).allowed).toBe(false);
  });

  it('admits the request that consumes the last unit', () => {
    // The decision returned is the one from the charge that was made, never a
    // re-read of the window afterwards — otherwise the caller who takes the
    // final unit is refused for a window they only just filled.
    for (let i = 0; i < RULE.limit - 1; i++) limiter.consume('b1', BUCKET, 1_000);

    const last = limiter.consume('b1', BUCKET, 1_000);

    expect(last.allowed).toBe(true);
    expect(last.remaining).toBe(0);
  });

  it('reports how long until the window resets when blocked', () => {
    for (let i = 0; i < RULE.limit; i++) limiter.consume('b1', BUCKET, 1_000);

    const blocked = limiter.consume('b1', BUCKET, 1_000 + 5_000);

    expect(blocked.retryAfterMs).toBe(RULE.windowMs - 5_000);
    expect(blocked.remaining).toBe(0);
  });

  it('starts a fresh window once the old one has elapsed', () => {
    for (let i = 0; i < RULE.limit; i++) limiter.consume('b1', BUCKET, 1_000);
    expect(limiter.consume('b1', BUCKET, 1_000).allowed).toBe(false);

    expect(limiter.consume('b1', BUCKET, 1_000 + RULE.windowMs).allowed).toBe(true);
  });

  it('keeps one tenant from spending another tenant s quota', () => {
    // The single property this whole mechanism exists for. Keying on anything
    // shared — a route, a process — would let the loudest tenant lock out the
    // rest, which is the outage the limiter is supposed to prevent.
    for (let i = 0; i < RULE.limit; i++) limiter.consume('noisy', BUCKET, 1_000);

    expect(limiter.consume('noisy', BUCKET, 1_000).allowed).toBe(false);
    expect(limiter.consume('quiet', BUCKET, 1_000).allowed).toBe(true);
  });

  it('keeps buckets independent for the same tenant', () => {
    // Exhausting the AI quota must not stop the tenant reading their inbox.
    for (let i = 0; i < RULE.limit; i++) limiter.consume('b1', BUCKET, 1_000);

    expect(limiter.consume('b1', 'search', 1_000).allowed).toBe(true);
  });

  describe('an unknown bucket', () => {
    it('admits the request rather than blocking it', () => {
      // A typo in a decorator must not become a 429 on a route that worked
      // yesterday, for every tenant, describing a quota nobody exceeded.
      const decision = limiter.consume('b1', 'not-a-real-bucket', 1_000);

      expect(decision.allowed).toBe(true);
      expect(decision.unknownBucket).toBe(true);
    });

    it('says so, so the caller can log it instead of failing silently', () => {
      expect(limiter.consume('b1', 'nope', 1_000).unknownBucket).toBe(true);
      expect(limiter.peek('b1', 'nope', 1_000).unknownBucket).toBe(true);
    });

    it('tracks no window for it', () => {
      limiter.consume('b1', 'nope', 1_000);

      expect(limiter.trackedWindows()).toBe(0);
    });
  });

  describe('peek', () => {
    it('does not consume quota', () => {
      limiter.peek('b1', BUCKET, 1_000);
      limiter.peek('b1', BUCKET, 1_000);

      expect(limiter.consume('b1', BUCKET, 1_000).remaining).toBe(RULE.limit - 1);
    });

    it('reports the full ceiling before any request', () => {
      expect(limiter.peek('b1', BUCKET, 1_000).remaining).toBe(RULE.limit);
    });

    it('reports exhaustion once the window is full', () => {
      for (let i = 0; i < RULE.limit; i++) limiter.consume('b1', BUCKET, 1_000);

      const peeked = limiter.peek('b1', BUCKET, 1_000);

      expect(peeked.allowed).toBe(false);
      expect(peeked.retryAfterMs).toBe(RULE.windowMs);
    });
  });

  describe('memory', () => {
    it('does not sweep below the threshold, so the ordinary request pays nothing', () => {
      for (let i = 0; i < 100; i++) limiter.consume(`b${i}`, BUCKET, 1_000);

      // All still resident, elapsed or not — the pass has not run.
      expect(limiter.trackedWindows()).toBe(100);
    });

    it('drops elapsed windows once the map is large', () => {
      // "Bounded by how many customers we have" is a bound that holds right up
      // until it doesn't, and an unswept map turns the mitigation for one
      // resource exhaustion into another one.
      for (let i = 0; i < TENANT_RATE_LIMIT_SWEEP_THRESHOLD; i++) {
        limiter.consume(`b${i}`, BUCKET, 1_000);
      }
      expect(limiter.trackedWindows()).toBe(TENANT_RATE_LIMIT_SWEEP_THRESHOLD);

      limiter.consume('later', BUCKET, 1_000 + RULE.windowMs + 1);

      // Everything from the first pass has elapsed; only the new key survives.
      expect(limiter.trackedWindows()).toBe(1);
    });

    it('never sweeps a live window', () => {
      for (let i = 0; i < TENANT_RATE_LIMIT_SWEEP_THRESHOLD; i++) {
        limiter.consume(`b${i}`, BUCKET, 1_000);
      }

      limiter.consume('later', BUCKET, 1_000);

      expect(limiter.trackedWindows()).toBe(TENANT_RATE_LIMIT_SWEEP_THRESHOLD + 1);
    });

    it('counts only live windows as active', () => {
      limiter.consume('b1', BUCKET, 1_000);

      expect(limiter.activeWindows(1_000)).toBe(1);
      expect(limiter.activeWindows(1_000 + RULE.windowMs)).toBe(0);
    });

    it('clears everything on reset', () => {
      limiter.consume('b1', BUCKET, 1_000);
      limiter.reset();

      expect(limiter.trackedWindows()).toBe(0);
      expect(limiter.consume('b1', BUCKET, 1_000).remaining).toBe(RULE.limit - 1);
    });
  });
});
