import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

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
}

/**
 * Redis-backed implementation of {@link AnalyticsCache}.
 */
class RedisAnalyticsCache implements AnalyticsCache {
  constructor(private readonly client: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }
}

export const analyticsCacheProvider: Provider = {
  provide: ANALYTICS_CACHE,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): AnalyticsCache => {
    const logger = new Logger('AnalyticsCache');
    const host = configService.get<string>('app.redis.host', 'localhost');
    const port = configService.get<number>('app.redis.port', 6379);

    const client = new Redis({
      host,
      port,
      maxRetriesPerRequest: null,
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
