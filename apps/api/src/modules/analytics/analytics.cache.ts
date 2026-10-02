import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_MAX_RETRIES_PER_REQUEST } from '../auth/redis.provider';

/**
 * Injection token for the analytics cache store. The dashboard summary is
 * cached here with a 5-minute TTL to absorb burst dashboard traffic.
 */
export const ANALYTICS_CACHE = Symbol('ANALYTICS_CACHE');

/**
 * Narrow cache contract the analytics module depends on. Keeping it small
 * makes it trivial to mock in unit tests and swappable for a non-Redis store.
 */
export interface AnalyticsCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /**
   * Release whatever the implementation is holding. Optional, so an in-memory
   * or mocked cache satisfies the contract without inventing a teardown it
   * does not need.
   */
  close?(): Promise<void>;
}

/**
 * Redis-backed implementation of {@link AnalyticsCache}.
 */
export class RedisAnalyticsCache implements AnalyticsCache {
  constructor(private readonly client: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  /**
   * Close the connection, and stop waiting after
   * {@link ANALYTICS_CACHE_QUIT_TIMEOUT_MS}.
   *
   * `quit()` drains the command queue and waits for the server to answer; if
   * Redis is why the process is restarting, that answer never comes. The
   * fallback `disconnect()` is what actually lets the process exit.
   */
  async close(): Promise<void> {
    try {
      await Promise.race([
        this.client.quit(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`QUIT did not complete in ${ANALYTICS_CACHE_QUIT_TIMEOUT_MS}ms`),
              ),
            ANALYTICS_CACHE_QUIT_TIMEOUT_MS,
          ).unref?.(),
        ),
      ]);
    } catch (err) {
      const logger = new Logger('RedisAnalyticsCache');
      logger.warn(
        `QUIT failed, forcing disconnect: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.client.disconnect?.();
    }
  }
}

/** Mirrors `REDIS_QUIT_TIMEOUT_MS` in the auth provider — same failure, same budget. */
export const ANALYTICS_CACHE_QUIT_TIMEOUT_MS = 5_000;

/**
 * AnalyticsCacheLifecycle — closes the cache's ioredis connection on shutdown.
 *
 * The provider below is a `useFactory` that constructs its *own* client, and
 * the value it returns is a plain object with no lifecycle hook, so nothing was
 * ever closing it: the auth module's connection was closed on every restart and
 * this second one was not, leaving a connection per restart for the server to
 * reap on its own timeout. It is the exact leak `RedisLifecycle` was written to
 * fix, in the one module that opens a connection outside `redisProvider`.
 *
 * Hooks `onApplicationShutdown` (the last phase) for the same reason
 * `RedisLifecycle` does: the dashboard is still being served while in-flight
 * requests drain.
 */
@Injectable()
export class AnalyticsCacheLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(AnalyticsCacheLifecycle.name);

  constructor(@Inject(ANALYTICS_CACHE) private readonly cache: AnalyticsCache) {}

  async onApplicationShutdown(): Promise<void> {
    if (typeof this.cache.close !== 'function') return;
    try {
      await this.cache.close();
      this.logger.log('Analytics cache connection closed');
    } catch (err) {
      // Best-effort, like every other teardown: a connection that will not
      // close must not abort the shutdown of whatever is registered after it.
      this.logger.warn(
        `Analytics cache shutdown failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export const analyticsCacheProvider: Provider = {
  provide: ANALYTICS_CACHE,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): AnalyticsCache => {
    const logger = new Logger('AnalyticsCache');
    const host = configService.get<string>('app.redis.host', 'localhost');
    const password = configService.get<string>('app.redis.password');
    const port = configService.get<number>('app.redis.port', 6379);

    const client = new Redis({
      ...(password && { password }),
      host,
      port,
      // Bounded rather than `null` (retry forever). A cache is the one
      // dependency that must fail rather than block: AnalyticsService wraps
      // every call here in a fail-open catch that falls back to the live query,
      // and that catch is unreachable if the command never settles.
      maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
      lazyConnect: false,
      // Namespaced so analytics cache keys never collide with other modules.
      keyPrefix: '',
    });

    client.on('error', (err: Error) => {
      logger.error(`Analytics cache Redis error: ${err.message}`);
    });

    return new RedisAnalyticsCache(client);
  },
};
