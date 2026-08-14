import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import {
  ANALYTICS_CACHE,
  AnalyticsCache,
  analyticsCacheProvider,
} from './analytics.cache';
import { REDIS_MAX_RETRIES_PER_REQUEST } from '../auth/redis.provider';

jest.mock('ioredis');

/**
 * The provider is the only place the analytics module builds a Redis client, so
 * the tests pin the connection options (a wrong `maxRetriesPerRequest` wedges
 * the dashboard behind a retry storm), the error handler that keeps a Redis
 * outage off the process, and the TTL argument order on `set`.
 */
type RedisStub = {
  get: jest.Mock;
  set: jest.Mock;
  on: jest.Mock;
};

const RedisMock = Redis as unknown as jest.Mock;

describe('analyticsCacheProvider', () => {
  let client: RedisStub;
  let config: Record<string, unknown>;
  let error: jest.SpyInstance;

  const build = (): AnalyticsCache => {
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key in config ? config[key] : fallback,
      ),
    };
    return (
      analyticsCacheProvider as {
        useFactory: (c: ConfigService) => AnalyticsCache;
      }
    ).useFactory(configService as unknown as ConfigService);
  };

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    client = { get: jest.fn(), set: jest.fn().mockResolvedValue('OK'), on: jest.fn() };
    RedisMock.mockReset();
    RedisMock.mockImplementation(() => client);
    config = {};
  });

  afterEach(() => jest.restoreAllMocks());

  describe('provider shape', () => {
    it('is registered under the ANALYTICS_CACHE token', () => {
      expect(analyticsCacheProvider).toEqual(
        expect.objectContaining({
          provide: ANALYTICS_CACHE,
          inject: [ConfigService],
        }),
      );
    });

    it('uses a symbol token, so it cannot collide with a string token', () => {
      expect(typeof ANALYTICS_CACHE).toBe('symbol');
    });
  });

  describe('connection options', () => {
    it('falls back to localhost:6379 when Redis is unconfigured', () => {
      build();
      expect(RedisMock).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'localhost', port: 6379 }),
      );
    });

    it('uses the configured host and port', () => {
      config = { 'app.redis.host': 'redis.internal', 'app.redis.port': 6380 };
      build();
      expect(RedisMock).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'redis.internal', port: 6380 }),
      );
    });

    it('omits the password entirely when none is configured', () => {
      build();
      expect(RedisMock.mock.calls[0][0]).not.toHaveProperty('password');
    });

    it('passes the password through when one is configured', () => {
      config = { 'app.redis.password': 's3cret' };
      build();
      expect(RedisMock).toHaveBeenCalledWith(
        expect.objectContaining({ password: 's3cret' }),
      );
    });

    it('treats an empty password as absent rather than authenticating with ""', () => {
      config = { 'app.redis.password': '' };
      build();
      expect(RedisMock.mock.calls[0][0]).not.toHaveProperty('password');
    });

    it('caps the per-request retries so an unreachable Redis cannot wedge the dashboard', () => {
      // This asserted `null` — no cap, retry forever — on the reasoning that a
      // cap would make a slow Redis fail. It has the trade backwards for a
      // cache: uncapped, a command issued while Redis is down never settles,
      // and AnalyticsService's fail-open catch has no error to catch. The
      // dashboard hung instead of falling back to the live query.
      build();
      expect(RedisMock).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
          lazyConnect: false,
        }),
      );
    });

    it('never reverts to an unbounded retry count', () => {
      build();
      expect(RedisMock.mock.calls[0][0].maxRetriesPerRequest).not.toBeNull();
    });

    it('shares the auth bound rather than keeping its own', () => {
      // Two Redis clients drifting apart on this is how one surface degrades
      // and the other hangs during the same outage.
      build();
      expect(RedisMock.mock.calls[0][0].maxRetriesPerRequest).toBe(
        REDIS_MAX_RETRIES_PER_REQUEST,
      );
    });
  });

  describe('error handling', () => {
    it('logs Redis errors instead of letting them reach the process', () => {
      build();
      const [event, handler] = client.on.mock.calls[0] as [
        string,
        (e: Error) => void,
      ];
      expect(event).toBe('error');
      expect(() => handler(new Error('ECONNRESET'))).not.toThrow();
      expect(error).toHaveBeenCalledWith(
        'Analytics cache Redis error: ECONNRESET',
      );
    });
  });

  describe('cache operations', () => {
    it('reads straight through to the client', async () => {
      client.get.mockResolvedValueOnce('{"cached":true}');
      await expect(build().get('summary:biz-1')).resolves.toBe('{"cached":true}');
      expect(client.get).toHaveBeenCalledWith('summary:biz-1');
    });

    it('returns null on a miss rather than throwing', async () => {
      client.get.mockResolvedValueOnce(null);
      await expect(build().get('summary:biz-1')).resolves.toBeNull();
    });

    it('writes with an EX expiry in seconds', async () => {
      await build().set('summary:biz-1', '{"a":1}', 300);
      expect(client.set).toHaveBeenCalledWith(
        'summary:biz-1',
        '{"a":1}',
        'EX',
        300,
      );
    });

    it('resolves to undefined on write, so callers cannot depend on the raw reply', async () => {
      await expect(build().set('k', 'v', 60)).resolves.toBeUndefined();
    });
  });
});
