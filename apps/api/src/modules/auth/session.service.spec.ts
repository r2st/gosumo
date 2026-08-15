import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'crypto';
import {
  SessionService,
  StoredSession,
  MAX_CONCURRENT_SESSIONS,
  SESSION_TTL_SECONDS,
} from './session.service';
import { REDIS_CLIENT } from './redis.provider';

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

const makeStored = (overrides: Partial<StoredSession> = {}): StoredSession => ({
  sessionId: 'sess-1',
  userId: 'user-1',
  businessId: 'biz-1',
  refreshTokenHash: sha256('refresh-token'),
  ip: '1.2.3.4',
  userAgent: 'jest',
  createdAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString(),
  ...overrides,
});

describe('SessionService', () => {
  let service: SessionService;

  const redis = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    expire: jest.fn(),
    mget: jest.fn(),
    zadd: jest.fn(),
    zrem: jest.fn(),
    zcard: jest.fn(),
    zrange: jest.fn(),
    zremrangebyrank: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SessionService, { provide: REDIS_CLIENT, useValue: redis }],
    }).compile();

    service = module.get<SessionService>(SessionService);

    jest.clearAllMocks();
    redis.set.mockResolvedValue('OK');
    redis.del.mockResolvedValue(1);
    redis.zadd.mockResolvedValue(1);
    redis.zrem.mockResolvedValue(1);
    redis.expire.mockResolvedValue(1);
    redis.zcard.mockResolvedValue(0);
    redis.zrange.mockResolvedValue([]);
    redis.zremrangebyrank.mockResolvedValue(0);
  });

  describe('createSession', () => {
    it('persists the session and indexes it', async () => {
      redis.zcard.mockResolvedValue(0);

      await service.createSession('user-1', 'biz-1', 'sess-1', 'refresh-token', {
        ip: '1.2.3.4',
        userAgent: 'jest',
      });

      expect(redis.set).toHaveBeenCalledWith(
        'gosumo:session:user-1:sess-1',
        expect.any(String),
        'EX',
        expect.any(Number),
      );
      const stored = JSON.parse(redis.set.mock.calls[0][1] as string) as StoredSession;
      expect(stored.refreshTokenHash).toBe(sha256('refresh-token'));
      // raw token must never be persisted
      expect(redis.set.mock.calls[0][1]).not.toContain('refresh-token');
      expect(redis.zadd).toHaveBeenCalledWith('gosumo:sessions:user-1', expect.any(Number), 'sess-1');
    });

    it('evicts the oldest session(s) when the cap is exceeded', async () => {
      // The new session is indexed first, so the set the trim sees already
      // includes it: one over the cap → exactly one eviction.
      const overCap = [
        'oldest',
        ...Array.from({ length: MAX_CONCURRENT_SESSIONS }, (_, i) => `sess-${i}`),
      ];
      redis.zrange.mockResolvedValue(overCap);

      await service.createSession('user-1', 'biz-1', 'sess-new', 'rt');

      expect(redis.del).toHaveBeenCalledWith('gosumo:session:user-1:oldest');
      // The index itself is trimmed by rank, in one command.
      expect(redis.zremrangebyrank).toHaveBeenCalledWith(
        'gosumo:sessions:user-1',
        0,
        -(MAX_CONCURRENT_SESSIONS + 1),
      );
      // Only the overflow goes: everything else is still within the cap.
      expect(redis.del).not.toHaveBeenCalledWith('gosumo:session:user-1:sess-0');
    });

    it('does not trim a user who is under the cap', async () => {
      redis.zrange.mockResolvedValue(['sess-a', 'sess-b']);

      await service.createSession('user-1', 'biz-1', 'sess-b', 'rt');

      expect(redis.zremrangebyrank).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });
  });

  describe('isActive', () => {
    it('returns true when the session key exists', async () => {
      redis.exists.mockResolvedValue(1);
      await expect(service.isActive('user-1', 'sess-1')).resolves.toBe(true);
    });

    it('returns false when the session key is gone', async () => {
      redis.exists.mockResolvedValue(0);
      await expect(service.isActive('user-1', 'sess-1')).resolves.toBe(false);
    });
  });

  describe('verifyRefreshToken', () => {
    it('returns true for the matching refresh token', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeStored()));
      await expect(
        service.verifyRefreshToken('user-1', 'sess-1', 'refresh-token'),
      ).resolves.toBe(true);
    });

    it('returns false for a mismatched token', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeStored()));
      await expect(
        service.verifyRefreshToken('user-1', 'sess-1', 'other-token'),
      ).resolves.toBe(false);
    });

    it('returns false when the session is missing', async () => {
      redis.get.mockResolvedValue(null);
      await expect(
        service.verifyRefreshToken('user-1', 'sess-1', 'refresh-token'),
      ).resolves.toBe(false);
    });

    /**
     * `crypto.timingSafeEqual` throws a RangeError on buffers of different
     * lengths rather than returning false. Without the guard in front of it, a
     * stored hash of the wrong width turns every refresh into a 500 — and the
     * comparison that is supposed to be constant-time becomes an exception the
     * caller can time instead.
     */
    it('returns false rather than throwing on a truncated stored hash', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify(makeStored({ refreshTokenHash: sha256('refresh-token').slice(0, 16) })),
      );

      await expect(
        service.verifyRefreshToken('user-1', 'sess-1', 'refresh-token'),
      ).resolves.toBe(false);
    });

    it('returns false rather than throwing on an over-long stored hash', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ ...makeStored(), refreshTokenHash: sha256('refresh-token') + 'abcd' }),
      );

      await expect(
        service.verifyRefreshToken('user-1', 'sess-1', 'refresh-token'),
      ).resolves.toBe(false);
    });

    it('returns false rather than throwing on a non-hex stored hash', async () => {
      // Buffer.from(_, 'hex') stops at the first invalid pair, so garbage in
      // Redis becomes a short buffer — the same guard has to catch it.
      redis.get.mockResolvedValue(JSON.stringify(makeStored({ refreshTokenHash: 'not-hex!!' })));

      await expect(
        service.verifyRefreshToken('user-1', 'sess-1', 'refresh-token'),
      ).resolves.toBe(false);
    });
  });

  describe('rotateRefreshToken', () => {
    it('replaces the stored hash with the new token hash', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeStored()));

      await service.rotateRefreshToken('user-1', 'sess-1', 'new-token');

      const stored = JSON.parse(redis.set.mock.calls[0][1] as string) as StoredSession;
      expect(stored.refreshTokenHash).toBe(sha256('new-token'));
    });

    it('does nothing when the session has already expired', async () => {
      // A session that aged out of Redis between the token check and the
      // rotation must not be written back — that would resurrect a revoked
      // session with a fresh TTL and a valid new token.
      redis.get.mockResolvedValue(null);

      await service.rotateRefreshToken('user-1', 'sess-1', 'new-token');

      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.expire).not.toHaveBeenCalled();
    });
  });

  describe('touch', () => {
    it('refreshes lastUsedAt and the key TTL', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeStored({ lastUsedAt: '2020-01-01T00:00:00.000Z' })));

      await service.touch('user-1', 'sess-1');

      const stored = JSON.parse(redis.set.mock.calls[0][1] as string) as StoredSession;
      expect(stored.lastUsedAt).not.toBe('2020-01-01T00:00:00.000Z');
      expect(redis.set).toHaveBeenCalledWith(
        'gosumo:session:user-1:sess-1',
        expect.any(String),
        'EX',
        expect.any(Number),
      );
    });

    it('does nothing when the session is gone', async () => {
      // touch() runs on the request path for every authenticated call, so a
      // session that expired mid-flight must be a no-op rather than a write
      // that recreates it.
      redis.get.mockResolvedValue(null);

      await service.touch('user-1', 'sess-1');

      expect(redis.set).not.toHaveBeenCalled();
    });

    it('extends the index TTL alongside the session it points at', async () => {
      // Extending only the session key lets the index expire out from under a
      // live session. The index is the only record that the session exists, so
      // `revokeAllSessions` — the mechanism behind logout-everywhere, change
      // password and password reset — would no longer be able to see it, while
      // `isActive` reads the session key and keeps admitting the token.
      redis.get.mockResolvedValue(JSON.stringify(makeStored()));

      await service.touch('user-1', 'sess-1');

      expect(redis.expire).toHaveBeenCalledWith('gosumo:sessions:user-1', SESSION_TTL_SECONDS);
    });

    it('leaves the index alone when there is no session to extend', async () => {
      redis.get.mockResolvedValue(null);

      await service.touch('user-1', 'sess-1');

      expect(redis.expire).not.toHaveBeenCalled();
    });
  });

  describe('listSessions', () => {
    it('maps stored sessions and flags the current one', async () => {
      redis.zrange.mockResolvedValue(['sess-1', 'sess-2']);
      redis.mget.mockResolvedValue([
        JSON.stringify(makeStored({ sessionId: 'sess-1' })),
        JSON.stringify(makeStored({ sessionId: 'sess-2' })),
      ]);

      const sessions = await service.listSessions('user-1', 'sess-2');

      expect(sessions).toHaveLength(2);
      expect(sessions.find((s) => s.sessionId === 'sess-2')?.isCurrent).toBe(true);
      expect(sessions.find((s) => s.sessionId === 'sess-1')?.isCurrent).toBe(false);
    });

    it('prunes stale index entries whose session has expired', async () => {
      redis.zrange.mockResolvedValue(['sess-1', 'stale']);
      redis.mget.mockResolvedValue([JSON.stringify(makeStored({ sessionId: 'sess-1' })), null]);

      const sessions = await service.listSessions('user-1');

      expect(sessions).toHaveLength(1);
      expect(redis.zrem).toHaveBeenCalledWith('gosumo:sessions:user-1', 'stale');
    });

    it('returns an empty array when there are no sessions', async () => {
      redis.zrange.mockResolvedValue([]);
      await expect(service.listSessions('user-1')).resolves.toEqual([]);
    });
  });

  describe('revokeSession', () => {
    it('deletes the session key and removes it from the index', async () => {
      await service.revokeSession('user-1', 'sess-1');
      expect(redis.del).toHaveBeenCalledWith('gosumo:session:user-1:sess-1');
      expect(redis.zrem).toHaveBeenCalledWith('gosumo:sessions:user-1', 'sess-1');
    });
  });

  describe('revokeAllSessions', () => {
    it('deletes every session key and the index', async () => {
      redis.zrange.mockResolvedValue(['sess-1', 'sess-2']);

      await service.revokeAllSessions('user-1');

      expect(redis.del).toHaveBeenCalledWith(
        'gosumo:session:user-1:sess-1',
        'gosumo:session:user-1:sess-2',
      );
      expect(redis.del).toHaveBeenCalledWith('gosumo:sessions:user-1');
    });

    it('still clears the index when there are no sessions', async () => {
      redis.zrange.mockResolvedValue([]);
      await service.revokeAllSessions('user-1');
      expect(redis.del).toHaveBeenCalledWith('gosumo:sessions:user-1');
    });
  });

  /**
   * The concurrent-session cap under load.
   *
   * These run against a stateful fake rather than call-count assertions: the
   * bug being covered is an ordering one, and only a store that actually holds
   * the sorted set can show a cap being overshot.
   */
  describe('concurrent-session cap', () => {
    interface FakeRedis {
      keys: Map<string, string>;
      index: { score: number; member: string }[];
      client: Record<string, unknown>;
    }

    function makeFakeRedis(): FakeRedis {
      const keys = new Map<string, string>();
      const index: { score: number; member: string }[] = [];
      const sorted = (): { score: number; member: string }[] =>
        [...index].sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));

      const client = {
        // `await` on each op so the two logins genuinely interleave rather than
        // running one after the other inside a single microtask.
        set: async (k: string, v: string) => {
          await Promise.resolve();
          keys.set(k, v);
          return 'OK';
        },
        del: async (...ks: string[]) => {
          await Promise.resolve();
          let n = 0;
          for (const k of ks) if (keys.delete(k)) n++;
          return n;
        },
        exists: async (k: string) => (keys.has(k) ? 1 : 0),
        expire: async () => 1,
        zadd: async (_k: string, score: number, member: string) => {
          await Promise.resolve();
          index.push({ score, member });
          return 1;
        },
        zrem: async (_k: string, ...members: string[]) => {
          await Promise.resolve();
          let n = 0;
          for (const m of members) {
            const i = index.findIndex((e) => e.member === m);
            if (i >= 0) {
              index.splice(i, 1);
              n++;
            }
          }
          return n;
        },
        zcard: async () => {
          await Promise.resolve();
          return index.length;
        },
        zrange: async (_k: string, start: number, stop: number) => {
          await Promise.resolve();
          const all = sorted().map((e) => e.member);
          return stop === -1 ? all.slice(start) : all.slice(start, stop + 1);
        },
        zremrangebyrank: async (_k: string, start: number, stop: number) => {
          await Promise.resolve();
          const all = sorted();
          const end = stop < 0 ? all.length + stop : stop;
          const removed = all.slice(start, end + 1);
          for (const entry of removed) {
            index.splice(
              index.findIndex((e) => e.member === entry.member),
              1,
            );
          }
          return removed.length;
        },
      };

      return { keys, index, client };
    }

    const build = (fake: FakeRedis): SessionService =>
      new SessionService(fake.client as never);

    it('holds the cap when many logins land at once', async () => {
      // Counting before inserting is a check-then-act: every racer reads a
      // count that predates the others' writes, concludes there is room, and
      // inserts. Nothing trims afterwards, so the overshoot is permanent — the
      // cap that bounds the blast radius of a stolen credential stops bounding
      // anything.
      const fake = makeFakeRedis();
      const svc = build(fake);

      await Promise.all(
        Array.from({ length: MAX_CONCURRENT_SESSIONS + 4 }, (_, i) =>
          svc.createSession('user-1', 'biz-1', `sess-${i}`, `token-${i}`),
        ),
      );

      expect(fake.index).toHaveLength(MAX_CONCURRENT_SESSIONS);
      // Evicted sessions must lose their key too: `isActive` reads the key, so
      // a session dropped from the index alone would still authenticate.
      expect(fake.keys.size).toBe(MAX_CONCURRENT_SESSIONS);
    });

    it('never evicts the session it was asked to create', async () => {
      // Millisecond scores tie for sessions created in the same tick, and a
      // tie is broken on the member — so without a monotonic score the newest
      // session can rank as the oldest and be trimmed by its own login.
      const fake = makeFakeRedis();
      const svc = build(fake);

      for (let i = 9; i >= 0; i--) {
        await svc.createSession('user-1', 'biz-1', `sess-${i}`, 'token');
      }

      // 'sess-0' sorts first on every tie-break, but it was created last.
      expect(fake.index.map((e) => e.member)).toContain('sess-0');
      expect(fake.keys.has('gosumo:session:user-1:sess-0')).toBe(true);
      expect(fake.index).toHaveLength(MAX_CONCURRENT_SESSIONS);
    });

    it('keeps the newest sessions and drops only the oldest', async () => {
      const fake = makeFakeRedis();
      const svc = build(fake);

      for (let i = 0; i < MAX_CONCURRENT_SESSIONS + 2; i++) {
        await svc.createSession('user-1', 'biz-1', `sess-${i}`, 'token');
      }

      expect(fake.index.map((e) => e.member)).toEqual([
        ...Array.from({ length: MAX_CONCURRENT_SESSIONS }, (_, i) => `sess-${i + 2}`),
      ]);
      expect(fake.keys.has('gosumo:session:user-1:sess-0')).toBe(false);
      expect(fake.keys.has('gosumo:session:user-1:sess-1')).toBe(false);
    });

    it('leaves an under-cap user untouched', async () => {
      const fake = makeFakeRedis();
      const svc = build(fake);

      await svc.createSession('user-1', 'biz-1', 'sess-a', 'token');
      await svc.createSession('user-1', 'biz-1', 'sess-b', 'token');

      expect(fake.index.map((e) => e.member)).toEqual(['sess-a', 'sess-b']);
    });
  });
});
