import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import Redis from 'ioredis';
import {
  ANALYTICS_CACHE,
  ANALYTICS_CACHE_QUIT_TIMEOUT_MS,
  AnalyticsCache,
  AnalyticsCacheLifecycle,
  RedisAnalyticsCache,
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

/**
 * The connection this provider opens is the only one in the app built outside
 * `redisProvider`, and nothing was ever closing it. `RedisLifecycle` closes the
 * auth module's client on every restart; this one was left for the server to
 * reap on its own timeout — one leaked connection per restart, against a
 * 50-connection ceiling this deployment shares with another service.
 */
describe('AnalyticsCacheLifecycle', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  const cacheWith = (over: Partial<AnalyticsCache> = {}): AnalyticsCache =>
    ({ get: jest.fn(), set: jest.fn(), ...over }) as unknown as AnalyticsCache;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('closes the cache connection on shutdown', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    await new AnalyticsCacheLifecycle(cacheWith({ close })).onApplicationShutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Analytics cache connection closed');
  });

  it('closes in the last shutdown phase, not the first', () => {
    // The dashboard is still being served while in-flight requests drain, and
    // every one of those reads goes through this cache.
    const lifecycle = new AnalyticsCacheLifecycle(cacheWith());
    expect(typeof lifecycle.onApplicationShutdown).toBe('function');
    expect(
      (lifecycle as unknown as { onModuleDestroy?: unknown }).onModuleDestroy,
    ).toBeUndefined();
  });

  it('never lets a stuck connection abort the rest of the shutdown', async () => {
    const close = jest.fn().mockRejectedValue(new Error('connection is closed'));
    await expect(
      new AnalyticsCacheLifecycle(cacheWith({ close })).onApplicationShutdown(),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Analytics cache shutdown failed'),
    );
  });

  it('is a no-op for a cache implementation with nothing to close', async () => {
    // `close` is optional so an in-memory or mocked cache satisfies the
    // contract without inventing a teardown it does not need.
    await expect(
      new AnalyticsCacheLifecycle(cacheWith()).onApplicationShutdown(),
    ).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('RedisAnalyticsCache.close', () => {
  it('quits gracefully when Redis answers', async () => {
    const quit = jest.fn().mockResolvedValue('OK');
    const disconnect = jest.fn();
    await new RedisAnalyticsCache({ quit, disconnect } as unknown as Redis).close();

    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('forces the socket down when QUIT rejects', async () => {
    const disconnect = jest.fn();
    await new RedisAnalyticsCache({
      quit: jest.fn().mockRejectedValue(new Error('already closed')),
      disconnect,
    } as unknown as Redis).close();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for a QUIT that never answers', async () => {
    // If Redis is *why* the process is restarting, the answer never arrives —
    // and `quit` is not covered by maxRetriesPerRequest. An unbounded await
    // here hangs shutdown until the supervisor SIGKILLs the process.
    jest.useFakeTimers();
    try {
      const disconnect = jest.fn();
      const closing = new RedisAnalyticsCache({
        quit: jest.fn().mockReturnValue(new Promise(() => undefined)),
        disconnect,
      } as unknown as Redis).close();

      jest.advanceTimersByTime(ANALYTICS_CACHE_QUIT_TIMEOUT_MS);
      await closing;

      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
