import { Test, TestingModule } from '@nestjs/testing';
import * as crypto from 'crypto';
import {
  SessionService,
  StoredSession,
  MAX_CONCURRENT_SESSIONS,
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
      // Already at the cap → one must be evicted before inserting the new one.
      redis.zcard.mockResolvedValue(MAX_CONCURRENT_SESSIONS);
      redis.zrange.mockResolvedValue(['oldest']);

      await service.createSession('user-1', 'biz-1', 'sess-new', 'rt');

      expect(redis.del).toHaveBeenCalledWith('gosumo:session:user-1:oldest');
      expect(redis.zrem).toHaveBeenCalledWith('gosumo:sessions:user-1', 'oldest');
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
  });

  describe('rotateRefreshToken', () => {
    it('replaces the stored hash with the new token hash', async () => {
      redis.get.mockResolvedValue(JSON.stringify(makeStored()));

      await service.rotateRefreshToken('user-1', 'sess-1', 'new-token');

      const stored = JSON.parse(redis.set.mock.calls[0][1] as string) as StoredSession;
      expect(stored.refreshTokenHash).toBe(sha256('new-token'));
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
});
