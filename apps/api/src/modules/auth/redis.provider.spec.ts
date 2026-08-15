/**
 * redis.provider unit tests.
 *
 * The factory's own wiring (host/port/password resolution) and the lifecycle
 * hook that closes the socket. The hook is the part with teeth: `main.ts` calls
 * `enableShutdownHooks()`, so anything that throws or hangs in here stalls
 * every shutdown behind it.
 */

import { ConfigService } from '@nestjs/config';
import {
  redisProvider,
  RedisClient,
  RedisLifecycle,
  REDIS_CLIENT,
  REDIS_MAX_RETRIES_PER_REQUEST,
  REDIS_QUIT_TIMEOUT_MS,
} from './redis.provider';

const mockRedisCtor = jest.fn();
jest.mock('ioredis', () => ({
  __esModule: true,
  default: class {
    on = jest.fn();
    constructor(opts: unknown) {
      mockRedisCtor(opts);
    }
  },
}));

function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => values[key] ?? fallback,
  } as unknown as ConfigService;
}

type Factory = (config: ConfigService) => RedisClient;

describe('redisProvider', () => {
  beforeEach(() => mockRedisCtor.mockClear());

  it('is registered under the REDIS_CLIENT token', () => {
    expect((redisProvider as { provide: symbol }).provide).toBe(REDIS_CLIENT);
  });

  it('builds the client from config, not from raw env', () => {
    const factory = (redisProvider as unknown as { useFactory: Factory }).useFactory;
    factory(
      configWith({
        'app.redis.host': 'redis.internal',
        'app.redis.port': 6380,
        'app.redis.password': 'hunter2',
      }),
    );

    expect(mockRedisCtor).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'redis.internal', port: 6380, password: 'hunter2' }),
    );
  });

  it('falls back to localhost:6379 and omits an unset password', () => {
    const factory = (redisProvider as unknown as { useFactory: Factory }).useFactory;
    factory(configWith({}));

    const opts = mockRedisCtor.mock.calls[0]![0] as Record<string, unknown>;
    expect(opts).toEqual(expect.objectContaining({ host: 'localhost', port: 6379 }));
    // Passing `password: undefined` makes ioredis send an empty AUTH, which a
    // server with no password configured rejects outright.
    expect('password' in opts).toBe(false);
  });

  describe('behaviour when Redis is unreachable', () => {
    const optsFor = (values: Record<string, unknown> = {}) => {
      const factory = (redisProvider as unknown as { useFactory: Factory }).useFactory;
      factory(configWith(values));
      return mockRedisCtor.mock.calls[0]![0] as Record<string, unknown>;
    };

    it('bounds the per-command retries so an outage fails instead of hanging', () => {
      // `null` here means retry forever. With Redis down, every session lookup
      // and every login rate-limit check sat in the offline queue and never
      // settled: no error to catch, no timeout to trip, and the request hung
      // holding its connection. A bounded count turns the outage into an error
      // the callers can act on.
      expect(optsFor().maxRetriesPerRequest).toBe(REDIS_MAX_RETRIES_PER_REQUEST);
    });

    it('does not disable the retry limit', () => {
      const value = optsFor().maxRetriesPerRequest;
      expect(value).not.toBeNull();
      expect(typeof value).toBe('number');
      expect(value as number).toBeGreaterThan(0);
    });

    it('keeps the limit small enough to fail inside a request', () => {
      // ioredis backs off between retries; a large ceiling would leave the
      // caller waiting long enough that the hang is back in all but name.
      expect(REDIS_MAX_RETRIES_PER_REQUEST).toBeLessThanOrEqual(5);
    });
  });
});

describe('RedisLifecycle', () => {
  let quit: jest.Mock;
  let disconnect: jest.Mock;

  const clientWith = (over: Partial<Record<'quit' | 'disconnect', unknown>> = {}) =>
    ({ quit, disconnect, ...over }) as unknown as RedisClient;

  beforeEach(() => {
    quit = jest.fn().mockResolvedValue('OK');
    disconnect = jest.fn();
  });

  it('closes the connection on shutdown', async () => {
    // Without this hook nothing ever closed the socket: every restart left the
    // old connection for the server to reap on its own timeout, against a
    // connection ceiling this deployment shares with another service.
    await new RedisLifecycle(clientWith()).onApplicationShutdown();

    expect(quit).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  /**
   * Sessions, the auth throttle and the login lockout all read this connection
   * on the request path, and requests are still draining two phases after
   * `onModuleDestroy`. Closing there gave every one of them a Redis error
   * instead of an answer for the length of the drain.
   */
  it('closes in the last shutdown phase, not the first', () => {
    const lifecycle = new RedisLifecycle(clientWith());
    expect(typeof lifecycle.onApplicationShutdown).toBe('function');
    expect(
      (lifecycle as unknown as { onModuleDestroy?: unknown }).onModuleDestroy,
    ).toBeUndefined();
  });

  it('forces a disconnect when QUIT rejects', async () => {
    quit.mockRejectedValue(new Error('Connection is closed.'));

    await new RedisLifecycle(clientWith()).onApplicationShutdown();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not throw when QUIT rejects', async () => {
    // A failure here must not abort the shutdown of everything registered
    // after it — Prisma's pool and the BullMQ workers are behind this.
    quit.mockRejectedValue(new Error('nope'));

    await expect(new RedisLifecycle(clientWith()).onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('does not throw when the forced disconnect also fails', async () => {
    quit.mockRejectedValue(new Error('nope'));
    disconnect.mockImplementation(() => {
      throw new Error('already gone');
    });

    await expect(new RedisLifecycle(clientWith()).onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('tolerates a client with no disconnect method', async () => {
    quit.mockRejectedValue(new Error('nope'));

    await expect(
      new RedisLifecycle(clientWith({ disconnect: undefined })).onApplicationShutdown(),
    ).resolves.toBeUndefined();
  });

  it('gives up on a QUIT that never settles and tears the socket down', async () => {
    // `maxRetriesPerRequest: null` means ioredis retries a command forever, so
    // if Redis is *why* we are restarting, an unbounded await here would hang
    // shutdown until the supervisor's kill timer fires.
    jest.useFakeTimers();
    try {
      quit.mockReturnValue(new Promise(() => {}));
      const lifecycle = new RedisLifecycle(clientWith());

      const done = lifecycle.onApplicationShutdown();
      jest.advanceTimersByTime(REDIS_QUIT_TIMEOUT_MS + 1);
      await done;

      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not tear down a QUIT that completes inside the timeout', async () => {
    jest.useFakeTimers();
    try {
      const lifecycle = new RedisLifecycle(clientWith());

      const done = lifecycle.onApplicationShutdown();
      jest.advanceTimersByTime(REDIS_QUIT_TIMEOUT_MS - 1);
      await done;

      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
