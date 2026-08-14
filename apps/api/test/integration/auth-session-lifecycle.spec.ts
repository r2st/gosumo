/**
 * Auth session lifecycle — integration test.
 *
 * The auth unit specs assert each service against a mocked collaborator, which
 * is how a session bug survives them: every part behaves correctly in
 * isolation, and the defect lives in the handoff. This wires the *real*
 * AuthService, SessionService, JwtService and AuthThrottleLimiter together and
 * drives the flows an operator actually performs:
 *
 *   register / login  → session created, tokens bound to it
 *   refresh           → refresh token rotated, the old one dies
 *   refresh (replayed)→ session revoked defensively, all tokens dead
 *   logout            → that session only
 *   logout-all        → every session
 *   6th login         → the oldest session evicted
 *
 * Only the I/O edges are faked: Prisma (through AuthRepository) and Redis. The
 * Redis fake is a real key/value + sorted-set implementation rather than a
 * jest.fn() returning canned values, because the thing under test *is* the
 * bookkeeping — a mock that always answers "yes" would pass every assertion
 * here while the production code lost sessions.
 *
 * What this catches that the unit specs cannot: a rotation that stores the new
 * hash but leaves the old token valid, a revoke that clears the record but not
 * the index, or an eviction that drops the wrong session.
 */

import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, ConflictException, Logger } from '@nestjs/common';

import { AuthService } from '../../src/modules/auth/auth.service';
import { AuthRepository } from '../../src/modules/auth/auth.repository';
import {
  SessionService,
  MAX_CONCURRENT_SESSIONS,
} from '../../src/modules/auth/session.service';
import { RedisClient } from '../../src/modules/auth/redis.provider';

const JWT_SECRET = 'integration-test-secret-value-32-chars';
/** Arbitrary fixed epoch (ms) for tests that need a deterministic clock. */
const CLOCK_ORIGIN = 1_700_000_000_000;
const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const USER_ID = '00000000-0000-4000-a000-0000000000ff';
const EMAIL = 'owner@example.com';
const PASSWORD = 'Sup3rSecret!';

// ─────────────────────────────────────────────
// An in-memory Redis with the semantics this module depends on
// ─────────────────────────────────────────────

/**
 * Implements only what `SessionService` and `AuthService` call, but implements
 * it faithfully: `zrange` returns members ordered by score (which is what makes
 * "oldest session" meaningful), `del` is variadic and counts real deletions,
 * and `mget` preserves positional nulls for keys that are gone — the exact
 * behaviour `listSessions` relies on to detect a stale index entry.
 */
class FakeRedis implements RedisClient {
  private readonly kv = new Map<string, string>();
  private readonly zsets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | null> {
    return this.kv.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    this.kv.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (this.kv.delete(k)) n += 1;
      if (this.zsets.delete(k)) n += 1;
    }
    return n;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.kv.has(k) || this.zsets.has(k)).length;
  }

  async expire(): Promise<number> {
    return 1;
  }

  async incr(key: string): Promise<number> {
    const next = Number(this.kv.get(key) ?? '0') + 1;
    this.kv.set(key, String(next));
    return next;
  }

  async ttl(key: string): Promise<number> {
    return this.kv.has(key) ? 900 : -2;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.kv.get(k) ?? null);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.zsets.get(key) ?? new Map<string, number>();
    const isNew = !set.has(member);
    set.set(member, score);
    this.zsets.set(key, set);
    return isNew ? 1 : 0;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const set = this.zsets.get(key);
    if (!set) return 0;
    return members.filter((m) => set.delete(m)).length;
  }

  async zcard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const ordered = [...(this.zsets.get(key) ?? new Map())]
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
    const end = stop < 0 ? ordered.length + stop + 1 : stop + 1;
    return ordered.slice(start, end);
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  /** Test affordance — not part of the production surface. */
  keys(): string[] {
    return [...this.kv.keys(), ...this.zsets.keys()];
  }
}

// ─────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────

interface Member {
  id: string;
  business_id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  password_hash: string | null;
}

describe('auth session lifecycle (integration)', () => {
  let redis: FakeRedis;
  let sessions: SessionService;
  let auth: AuthService;
  let jwt: JwtService;
  let member: Member;
  let repo: jest.Mocked<Partial<AuthRepository>>;
  let clock: jest.SpyInstance<number, []> | null = null;

  /**
   * Pin `Date.now()`. Kept behind a helper with an `afterEach` restore because a
   * frozen clock that leaks out of the test that set it changes session
   * ordering everywhere downstream — a failure that shows up in an unrelated
   * test and points nowhere near its cause.
   */
  const freezeClock = (ms: number): void => {
    clock ??= jest.spyOn(Date, 'now');
    clock.mockReturnValue(ms);
  };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    clock?.mockRestore();
    clock = null;
  });

  afterAll(() => jest.restoreAllMocks());

  beforeEach(async () => {
    redis = new FakeRedis();
    jwt = new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '15m' } });
    sessions = new SessionService(redis);

    // A real bcrypt hash, so `login` exercises a genuine verify rather than a
    // stubbed comparison. Cost 4 keeps the suite fast; the production factor is
    // set in AuthService and is not what this file is testing.
    member = {
      id: USER_ID,
      business_id: BUSINESS_ID,
      email: EMAIL,
      name: 'Owner',
      role: 'OWNER',
      status: 'ACTIVE',
      password_hash: await bcrypt.hash(PASSWORD, 4),
    };

    repo = {
      findTeamMemberByEmail: jest.fn().mockResolvedValue(member),
      findTeamMemberById: jest.fn().mockResolvedValue(member),
      isBusinessEmailTaken: jest.fn().mockResolvedValue(false),
      createTeamMemberWithBusiness: jest.fn().mockResolvedValue(member),
      updateLastLogin: jest.fn().mockResolvedValue(undefined),
      isSlugTaken: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<Partial<AuthRepository>>;

    const config = {
      get: (key: string, fallback?: unknown) =>
        key === 'app.jwt.secret' ? JWT_SECRET : fallback,
    } as unknown as ConfigService;

    auth = new AuthService(
      repo as unknown as AuthRepository,
      jwt,
      config,
      sessions,
      redis,
    );
  });

  const login = () => auth.login({ email: EMAIL, password: PASSWORD }, { ip: '1.2.3.4' });

  const sessionIdOf = (token: string): string =>
    jwt.verify<{ sessionId: string }>(token).sessionId;

  // ─────────────────────────────────────────────

  describe('login', () => {
    it('creates exactly one session and binds the tokens to it', async () => {
      const tokens = await login();

      const list = await sessions.listSessions(USER_ID);
      expect(list).toHaveLength(1);
      // Both tokens must name the same session, or revoking one leaves the
      // other alive.
      expect(sessionIdOf(tokens.accessToken)).toBe(list[0]!.sessionId);
      expect(sessionIdOf(tokens.refreshToken)).toBe(list[0]!.sessionId);
    });

    it('records the caller IP against the session', async () => {
      await login();
      expect((await sessions.listSessions(USER_ID))[0]!.ip).toBe('1.2.3.4');
    });

    it('rejects a wrong password without creating a session', async () => {
      await expect(
        auth.login({ email: EMAIL, password: 'wrong-password' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(await sessions.listSessions(USER_ID)).toEqual([]);
    });

    it('refuses a suspended account that has valid credentials', async () => {
      member.status = 'SUSPENDED';

      await expect(login()).rejects.toThrow(UnauthorizedException);
      expect(await sessions.listSessions(USER_ID)).toEqual([]);
    });
  });

  describe('register', () => {
    it('issues a usable session for the new account', async () => {
      repo.findTeamMemberByEmail = jest.fn().mockResolvedValue(null);

      const tokens = await auth.register({
        email: EMAIL,
        password: PASSWORD,
        businessName: 'Test Biz',
      } as Parameters<AuthService['register']>[0]);

      expect(await sessions.isActive(USER_ID, sessionIdOf(tokens.accessToken))).toBe(true);
    });

    it('creates no session when the email is already taken', async () => {
      await expect(
        auth.register({
          email: EMAIL,
          password: PASSWORD,
          businessName: 'Test Biz',
        } as Parameters<AuthService['register']>[0]),
      ).rejects.toThrow(ConflictException);

      expect(await sessions.listSessions(USER_ID)).toEqual([]);
    });
  });

  describe('refresh rotation', () => {
    it('issues a working new refresh token', async () => {
      const first = await login();

      const second = await auth.refreshTokens(first.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);
      // The new one must itself be refreshable, or the session dies after one
      // rotation and every operator is logged out after 15 minutes.
      await expect(auth.refreshTokens(second.refreshToken)).resolves.toBeDefined();
    });

    it('keeps the rotated token on the same session', async () => {
      const first = await login();
      const second = await auth.refreshTokens(first.refreshToken);

      expect(sessionIdOf(second.refreshToken)).toBe(sessionIdOf(first.refreshToken));
      expect(await sessions.listSessions(USER_ID)).toHaveLength(1);
    });

    /**
     * The security property this whole design exists for. A rotated-away token
     * turning up again means it was captured, so the response is not just to
     * refuse it — it is to kill the session, which also invalidates whatever
     * the attacker rotated into.
     */
    it('revokes the whole session when an old refresh token is replayed', async () => {
      const first = await login();
      const second = await auth.refreshTokens(first.refreshToken);

      await expect(auth.refreshTokens(first.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );

      // The attacker's freshly rotated token is dead too.
      await expect(auth.refreshTokens(second.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(await sessions.listSessions(USER_ID)).toEqual([]);
    });

    it('rejects a token signed with a different secret', async () => {
      const foreign = new JwtService({ secret: 'some-other-secret' }).sign({
        sub: USER_ID,
        businessId: BUSINESS_ID,
        sessionId: 'sess-forged',
      });

      await expect(auth.refreshTokens(foreign)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a well-signed token that names no session', async () => {
      // Pre-session tokens would otherwise refresh forever, outside every
      // revocation path in this file.
      const unbound = jwt.sign({ sub: USER_ID, businessId: BUSINESS_ID });

      await expect(auth.refreshTokens(unbound)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a refresh for an account suspended since login', async () => {
      const tokens = await login();
      member.status = 'SUSPENDED';

      await expect(auth.refreshTokens(tokens.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a refresh for an account that no longer exists', async () => {
      const tokens = await login();
      repo.findTeamMemberById = jest.fn().mockResolvedValue(null);

      await expect(auth.refreshTokens(tokens.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  /**
   * Regression cover for the rotation-collision bug.
   *
   * Rotation detection works by hashing the presented refresh token and
   * comparing it to the hash stored on the session. That only distinguishes an
   * old token from its replacement if the two tokens actually differ — and
   * every claim in the payload is stable across a rotation except `iat`/`exp`,
   * which are whole seconds. Two refreshes inside one second therefore produced
   * the *same* token bytes, and a replayed token verified clean.
   *
   * These tests freeze the clock, which makes the collision certain rather than
   * a race that reproduces on fast machines and not on slow ones.
   */
  describe('token identity', () => {
    const claimsOf = (token: string): { jti?: string; iat?: number } =>
      jwt.verify<{ jti?: string; iat?: number }>(token);

    it('gives the access and refresh token of one pair different ids', async () => {
      freezeClock(CLOCK_ORIGIN);
      const tokens = await login();

      const access = claimsOf(tokens.accessToken);
      const refresh = claimsOf(tokens.refreshToken);

      expect(access.jti).toEqual(expect.any(String));
      expect(refresh.jti).toEqual(expect.any(String));
      expect(access.jti).not.toBe(refresh.jti);
    });

    it('issues distinct refresh tokens when two rotations share a second', async () => {
      freezeClock(CLOCK_ORIGIN);
      const first = await login();
      const second = await auth.refreshTokens(first.refreshToken);
      const third = await auth.refreshTokens(second.refreshToken);

      // Same second — so this is exactly the case that used to collide.
      expect(claimsOf(first.refreshToken).iat).toBe(claimsOf(third.refreshToken).iat);
      expect(new Set([first, second, third].map((t) => t.refreshToken)).size).toBe(3);
    });

    it('detects a replay of a token rotated away in the same second', async () => {
      freezeClock(CLOCK_ORIGIN);
      const first = await login();
      const second = await auth.refreshTokens(first.refreshToken);

      // Identical timestamps, so the only thing telling these two apart is `jti`.
      expect(claimsOf(first.refreshToken).iat).toBe(claimsOf(second.refreshToken).iat);

      await expect(auth.refreshTokens(first.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(await sessions.listSessions(USER_ID)).toEqual([]);
    });

    it('never repeats an id across many logins in the same second', async () => {
      freezeClock(CLOCK_ORIGIN);

      const ids: (string | undefined)[] = [];
      for (let i = 0; i < 10; i += 1) {
        const tokens = await login();
        ids.push(claimsOf(tokens.accessToken).jti, claimsOf(tokens.refreshToken).jti);
      }

      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('logout', () => {
    it('kills the refresh token for that session only', async () => {
      const a = await login();
      const b = await login();

      await auth.logout(USER_ID, sessionIdOf(a.accessToken));

      await expect(auth.refreshTokens(a.refreshToken)).rejects.toThrow(UnauthorizedException);
      await expect(auth.refreshTokens(b.refreshToken)).resolves.toBeDefined();
    });

    it('removes the session from the index, not just the record', async () => {
      // A record deleted without its index entry leaves a phantom session in
      // the operator's session list forever.
      const a = await login();
      await auth.logout(USER_ID, sessionIdOf(a.accessToken));

      expect(await sessions.listSessions(USER_ID)).toEqual([]);
    });

    it('logs out every session when called without a session id', async () => {
      const a = await login();
      const b = await login();

      await auth.logout(USER_ID);

      await expect(auth.refreshTokens(a.refreshToken)).rejects.toThrow(UnauthorizedException);
      await expect(auth.refreshTokens(b.refreshToken)).rejects.toThrow(UnauthorizedException);
    });

    it('leaves no Redis keys behind after logoutAll', async () => {
      await login();
      await login();

      await auth.logoutAll(USER_ID);

      expect(redis.keys().filter((k) => k.includes(USER_ID))).toEqual([]);
    });

    it('is idempotent', async () => {
      const a = await login();
      const sid = sessionIdOf(a.accessToken);

      await auth.logout(USER_ID, sid);
      await expect(auth.logout(USER_ID, sid)).resolves.toBeUndefined();
    });
  });

  describe('concurrent session cap', () => {
    /**
     * Freeze *before* each login, never after. The index score comes from
     * `Date.now()` at `createSession` time, so a login that runs against the
     * real clock is stamped ~1.79e12 while the frozen ones sit at 1.7e12 —
     * which silently makes the first session the *newest* and the eviction
     * assertion test the opposite of what it claims.
     */
    it('evicts the oldest session on the one past the limit', async () => {
      const issued = [];
      for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i += 1) {
        freezeClock(CLOCK_ORIGIN + i * 1_000);
        issued.push(await login());
      }
      expect(await sessions.listSessions(USER_ID)).toHaveLength(MAX_CONCURRENT_SESSIONS);

      freezeClock(CLOCK_ORIGIN + MAX_CONCURRENT_SESSIONS * 1_000);
      const newest = await login();

      const live = await sessions.listSessions(USER_ID);
      expect(live).toHaveLength(MAX_CONCURRENT_SESSIONS);
      // The newest survives and the *first* session — the oldest — is the one
      // that went, rather than an arbitrary one that merely kept the count right.
      expect(live.map((s) => s.sessionId)).toContain(sessionIdOf(newest.accessToken));
      expect(live.map((s) => s.sessionId)).not.toContain(sessionIdOf(issued[0]!.accessToken));
      await expect(auth.refreshTokens(issued[0]!.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
      // ...and every other session is untouched: eviction takes the oldest, not
      // "the oldest plus whatever else shared its second".
      await expect(auth.refreshTokens(issued[1]!.refreshToken)).resolves.toBeDefined();
    });

    it('never exceeds the cap however many times the user logs in', async () => {
      for (let i = 0; i < MAX_CONCURRENT_SESSIONS + 4; i += 1) {
        freezeClock(CLOCK_ORIGIN + i * 1_000);
        await login();
      }

      expect((await sessions.listSessions(USER_ID)).length).toBeLessThanOrEqual(
        MAX_CONCURRENT_SESSIONS,
      );
    });
  });

  describe('session listing', () => {
    it('flags the caller’s own session as current', async () => {
      const a = await login();
      await login();

      const list = await auth.getActiveSessions(USER_ID, sessionIdOf(a.accessToken));

      expect(list.filter((s) => s.isCurrent).map((s) => s.sessionId)).toEqual([
        sessionIdOf(a.accessToken),
      ]);
    });

    it('drops an index entry whose session has expired', async () => {
      // Session records carry a TTL and the index does not, so the index
      // outlives them. listSessions is where that is reconciled.
      const a = await login();
      await redis.del(`gosumo:session:${USER_ID}:${sessionIdOf(a.accessToken)}`);

      expect(await sessions.listSessions(USER_ID)).toEqual([]);
      // And the stale entry is gone, not merely skipped.
      expect(await redis.zcard(`gosumo:sessions:${USER_ID}`)).toBe(0);
    });
  });
});
