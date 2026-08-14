import { Inject, Injectable, Logger, OnModuleDestroy, Provider } from '@nestjs/common';
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
  /** Liveness probe for the readiness check. */
  ping(): Promise<string>;
  quit(): Promise<'OK'>;
  /** Hard socket teardown, used when a graceful `quit()` will not come back. */
  disconnect?(): void;
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

/**
 * How long to wait for a graceful `QUIT` before pulling the socket down.
 *
 * `quit()` waits for the command queue to drain and for the server to answer.
 * If Redis is the reason the process is being restarted, that answer never
 * arrives and — with `maxRetriesPerRequest: null` set above — ioredis will
 * keep retrying rather than failing, so an unbounded await here would hang
 * shutdown until the supervisor's kill timer fires.
 */
export const REDIS_QUIT_TIMEOUT_MS = 5_000;

/**
 * RedisLifecycle — closes the shared ioredis connection when Nest tears the
 * application down.
 *
 * `redisProvider` is a `useFactory`, and the value it returns is an ioredis
 * instance with no lifecycle hook of its own, so nothing was ever closing this
 * socket: on every `systemd` restart the old process exited with its Redis
 * connection still established, leaving the server to reap it on its own
 * timeout. This class is the hook — `main.ts` already calls
 * `enableShutdownHooks()`, so `onModuleDestroy` runs on SIGTERM.
 *
 * Shutdown is best-effort by design. A failure to close a connection cannot be
 * allowed to abort the shutdown of everything registered after it, so every
 * path here logs and returns rather than throwing.
 */
@Injectable()
export class RedisLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger(RedisLifecycle.name);

  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClient) {}

  async onModuleDestroy(): Promise<void> {
    try {
      await Promise.race([
        this.client.quit(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`QUIT did not complete in ${REDIS_QUIT_TIMEOUT_MS}ms`)),
            REDIS_QUIT_TIMEOUT_MS,
          ).unref?.(),
        ),
      ]);
      this.logger.log('Redis connection closed');
    } catch (err) {
      // Already-closed and never-connected both land here, as does the
      // timeout. None of them are worth failing a shutdown over — but the
      // socket still has to go, or the process will not exit on its own.
      this.logger.warn(
        `Graceful Redis shutdown failed (${(err as Error).message}); forcing disconnect`,
      );
      try {
        this.client.disconnect?.();
      } catch {
        // Nothing left to try, and nothing left that could care.
      }
    }
  }
}
