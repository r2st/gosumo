/**
 * AuthThrottleLimiter unit tests.
 *
 * The limiter is the only thing standing between the internet and an unbounded
 * number of business rows / outbound emails, so these cases pin down the exact
 * boundary (the Nth request passes, the N+1th does not), the window reset, the
 * independence of the keys, and the two properties that are easy to get wrong:
 * a blocked IP must not also drain a victim's subject quota, and the key map
 * must not grow without bound.
 */

import { AuthThrottleLimiter } from './auth-throttle.limiter';
import { AUTH_THROTTLE_BUCKETS, AUTH_THROTTLE_SWEEP_THRESHOLD } from './auth-throttle.constants';

const IP = '203.0.113.7';
const T0 = 1_700_000_000_000;

describe('AuthThrottleLimiter', () => {
  let limiter: AuthThrottleLimiter;

  beforeEach(() => {
    limiter = new AuthThrottleLimiter();
  });

  describe('ruleFor', () => {
    it('resolves each configured bucket', () => {
      expect(limiter.ruleFor('register')).toBe(AUTH_THROTTLE_BUCKETS['register']);
      expect(limiter.ruleFor('forgot-password')).toBe(AUTH_THROTTLE_BUCKETS['forgot-password']);
    });

    it('returns undefined for an unknown bucket', () => {
      expect(limiter.ruleFor('nope')).toBeUndefined();
    });
  });

  describe('unknown buckets', () => {
    it('allows the request rather than blocking it', () => {
      // A typo'd bucket name is a config bug, not an attack. Failing open here
      // keeps a deploy alive; the contract spec is what fails on the typo.
      const d = limiter.consume('does-not-exist', { ip: IP }, T0);
      expect(d.allowed).toBe(true);
      expect(d.limit).toBe(0);
    });
  });

  describe('per-IP window', () => {
    const limit = AUTH_THROTTLE_BUCKETS['register']!.ip.limit;

    it('admits exactly `limit` requests and blocks the next', () => {
      for (let i = 0; i < limit; i += 1) {
        expect(limiter.consume('register', { ip: IP }, T0).allowed).toBe(true);
      }
      const blocked = limiter.consume('register', { ip: IP }, T0);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.limit).toBe(limit);
    });

    it('counts down the remaining quota', () => {
      expect(limiter.consume('register', { ip: IP }, T0).remaining).toBe(limit - 1);
      expect(limiter.consume('register', { ip: IP }, T0).remaining).toBe(limit - 2);
    });

    it('reports how long until the window resets', () => {
      const windowMs = AUTH_THROTTLE_BUCKETS['register']!.ip.windowMs;
      for (let i = 0; i < limit; i += 1) limiter.consume('register', { ip: IP }, T0);

      const blocked = limiter.consume('register', { ip: IP }, T0 + 1_000);
      expect(blocked.retryAfterMs).toBe(windowMs - 1_000);
    });

    it('admits again once the window has elapsed', () => {
      const windowMs = AUTH_THROTTLE_BUCKETS['register']!.ip.windowMs;
      for (let i = 0; i < limit; i += 1) limiter.consume('register', { ip: IP }, T0);
      expect(limiter.consume('register', { ip: IP }, T0).allowed).toBe(false);

      const afterReset = limiter.consume('register', { ip: IP }, T0 + windowMs);
      expect(afterReset.allowed).toBe(true);
      expect(afterReset.remaining).toBe(limit - 1);
    });

    it('keeps separate IPs independent', () => {
      for (let i = 0; i < limit; i += 1) limiter.consume('register', { ip: IP }, T0);
      expect(limiter.consume('register', { ip: IP }, T0).allowed).toBe(false);
      // A second caller is unaffected by the first one's exhausted window.
      expect(limiter.consume('register', { ip: '198.51.100.4' }, T0).allowed).toBe(true);
    });

    it('keeps separate buckets independent', () => {
      for (let i = 0; i < limit; i += 1) limiter.consume('register', { ip: IP }, T0);
      expect(limiter.consume('register', { ip: IP }, T0).allowed).toBe(false);
      // Exhausting signup must not lock the same caller out of logging in.
      expect(limiter.consume('login', { ip: IP }, T0).allowed).toBe(true);
    });
  });

  describe('unkeyable callers', () => {
    it('admits a request with no IP rather than pooling it', () => {
      // Pooling every unkeyable caller into one window would let any single one
      // of them lock out all the others.
      const limit = AUTH_THROTTLE_BUCKETS['register']!.ip.limit;
      for (let i = 0; i < limit * 3; i += 1) {
        expect(limiter.consume('register', { ip: null }, T0).allowed).toBe(true);
      }
    });

    it('reports the full allowance for a bucket with no subject rule', () => {
      const d = limiter.consume('register', { ip: null }, T0);
      expect(d.remaining).toBe(AUTH_THROTTLE_BUCKETS['register']!.ip.limit);
    });

    it('still applies the subject window when only the IP is missing', () => {
      const subject = AUTH_THROTTLE_BUCKETS['forgot-password']!.subject!;
      for (let i = 0; i < subject.limit; i += 1) {
        expect(
          limiter.consume('forgot-password', { ip: null, subject: 'a@b.com' }, T0).allowed,
        ).toBe(true);
      }
      expect(
        limiter.consume('forgot-password', { ip: null, subject: 'a@b.com' }, T0).allowed,
      ).toBe(false);
    });
  });

  describe('subject window', () => {
    const rule = AUTH_THROTTLE_BUCKETS['forgot-password']!;

    it('blocks a victim address hit from many different IPs', () => {
      // The whole point of the second dimension: each of these is a fresh IP
      // window, so only the per-address ceiling can stop the mail flood.
      for (let i = 0; i < rule.subject!.limit; i += 1) {
        const d = limiter.consume('forgot-password', { ip: `198.51.100.${i}`, subject: 'v@x.com' }, T0);
        expect(d.allowed).toBe(true);
      }
      const blocked = limiter.consume(
        'forgot-password',
        { ip: '198.51.100.99', subject: 'v@x.com' },
        T0,
      );
      expect(blocked.allowed).toBe(false);
      expect(blocked.limit).toBe(rule.subject!.limit);
    });

    it('treats the subject case-insensitively', () => {
      // Email addresses are matched case-insensitively at the service layer;
      // if the limiter disagreed, `V@X.com` would be a free extra allowance.
      for (let i = 0; i < rule.subject!.limit; i += 1) {
        limiter.consume('forgot-password', { ip: `198.51.100.${i}`, subject: 'v@x.com' }, T0);
      }
      expect(
        limiter.consume('forgot-password', { ip: '198.51.100.99', subject: 'V@X.COM' }, T0)
          .allowed,
      ).toBe(false);
    });

    it('keeps separate subjects independent', () => {
      for (let i = 0; i < rule.subject!.limit; i += 1) {
        limiter.consume('forgot-password', { ip: `198.51.100.${i}`, subject: 'v@x.com' }, T0);
      }
      expect(
        limiter.consume('forgot-password', { ip: '198.51.100.99', subject: 'other@x.com' }, T0)
          .allowed,
      ).toBe(true);
    });

    it('does not charge the subject window once the IP window is exhausted', () => {
      // Otherwise a blocked attacker keeps burning down a victim's quota as a
      // side effect, and the rate limiter becomes a lockout weapon: spam one
      // address from one host and its owner can no longer reset their password.
      //
      // Exhaust the IP window against throwaway subjects, so the victim's own
      // window is provably untouched going in.
      for (let i = 0; i < rule.ip.limit; i += 1) {
        expect(
          limiter.consume('forgot-password', { ip: IP, subject: `filler${i}@x.com` }, T0).allowed,
        ).toBe(true);
      }

      // Now the attacker aims at the victim and is refused by the IP ceiling.
      expect(limiter.consume('forgot-password', { ip: IP, subject: 'v@x.com' }, T0).allowed).toBe(
        false,
      );

      // The victim still has their full allowance from any other host.
      for (let i = 0; i < rule.subject!.limit; i += 1) {
        expect(
          limiter.consume('forgot-password', { ip: `198.51.100.${i}`, subject: 'v@x.com' }, T0)
            .allowed,
        ).toBe(true);
      }
    });

    it('ignores the subject dimension when no subject was supplied', () => {
      // A malformed body has no email; the IP ceiling still applies.
      for (let i = 0; i < rule.ip.limit; i += 1) {
        expect(limiter.consume('forgot-password', { ip: IP, subject: null }, T0).allowed).toBe(
          true,
        );
      }
      expect(limiter.consume('forgot-password', { ip: IP, subject: null }, T0).allowed).toBe(
        false,
      );
    });
  });

  describe('key-space growth', () => {
    it('sweeps elapsed windows once past the threshold', () => {
      // The key is the caller's IP, so an attacker cycling source addresses
      // controls how big this map gets. Without the sweep, mitigating one
      // denial-of-service would introduce a slower one.
      for (let i = 0; i < AUTH_THROTTLE_SWEEP_THRESHOLD; i += 1) {
        limiter.consume('register', { ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` }, T0);
      }
      expect(limiter.trackedWindows()).toBe(AUTH_THROTTLE_SWEEP_THRESHOLD);

      const windowMs = AUTH_THROTTLE_BUCKETS['register']!.ip.windowMs;
      limiter.consume('register', { ip: '203.0.113.1' }, T0 + windowMs + 1);

      // Everything from the first burst has elapsed and been dropped from the
      // map itself; only the request that triggered the sweep remains.
      expect(limiter.trackedWindows()).toBe(1);
    });

    it('keeps windows that are still live when it sweeps', () => {
      // The sweep must drop only elapsed entries — dropping a live one would
      // hand its owner a fresh allowance mid-window.
      const windowMs = AUTH_THROTTLE_BUCKETS['register']!.ip.windowMs;
      for (let i = 0; i < AUTH_THROTTLE_SWEEP_THRESHOLD - 1; i += 1) {
        limiter.consume('register', { ip: `10.${(i >> 8) & 255}.${i & 255}.1` }, T0);
      }
      // One caller arrives late, so its window is still open at sweep time.
      limiter.consume('register', { ip: '203.0.113.50' }, T0 + windowMs - 1);

      limiter.consume('register', { ip: '203.0.113.51' }, T0 + windowMs + 1);

      // The late caller survived alongside the one that triggered the sweep,
      // and its count carried over — it has one fewer than a fresh window.
      expect(limiter.trackedWindows()).toBe(2);
      expect(
        limiter.consume('register', { ip: '203.0.113.50' }, T0 + windowMs + 1).remaining,
      ).toBe(AUTH_THROTTLE_BUCKETS['register']!.ip.limit - 2);
    });

    it('does not sweep while the map is small', () => {
      // Below the threshold the common request never pays for the pass, so an
      // elapsed entry stays resident — it is simply no longer counted.
      limiter.consume('register', { ip: IP }, T0);
      const windowMs = AUTH_THROTTLE_BUCKETS['register']!.ip.windowMs;
      limiter.consume('register', { ip: '198.51.100.4' }, T0 + windowMs + 1);

      expect(limiter.trackedWindows()).toBe(2);
      expect(limiter.activeWindows(T0 + windowMs + 1)).toBe(1);
    });
  });

  describe('activeWindows / reset', () => {
    it('counts only live windows', () => {
      limiter.consume('register', { ip: IP }, T0);
      expect(limiter.activeWindows(T0)).toBe(1);
      expect(limiter.activeWindows(T0 + AUTH_THROTTLE_BUCKETS['register']!.ip.windowMs)).toBe(0);
    });

    it('defaults its clock to now', () => {
      limiter.consume('register', { ip: IP });
      expect(limiter.activeWindows()).toBe(1);
    });

    it('clears every window', () => {
      limiter.consume('register', { ip: IP }, T0);
      limiter.reset();
      expect(limiter.activeWindows(T0)).toBe(0);
    });
  });
});
