import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Injection token for the shared ioredis client used by the auth module
 * (sessions, refresh-token store, login rate limiting, password-reset tokens).
 */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * A narrow view of the ioredis surface the auth module actually uses.
 * Keeping it explicit makes the contract easy to mock in unit tests.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  incr(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  zadd(key: string, score: number, member: string): Promise<number | string>;
  zrem(key: string, ...members: string[]): Promise<number>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  quit(): Promise<'OK'>;
}

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): RedisClient => {
    const logger = new Logger('RedisClient');
    const host = configService.get<string>('app.redis.host', 'localhost');
    const password = configService.get<string>('app.redis.password');
    const port = configService.get<number>('app.redis.port', 6379);

    const client = new Redis({
      ...(password && { password }),
      host,
      port,
      // Required by ioredis when used with BullMQ-style blocking commands;
      // also avoids unbounded retries hanging requests in this module.
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });

    client.on('error', (err: Error) => {
      logger.error(`Redis connection error: ${err.message}`);
    });

    return client as unknown as RedisClient;
  },
};
