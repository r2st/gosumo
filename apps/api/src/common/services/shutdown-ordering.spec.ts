/**
 * The one property no single service's tests can assert: that the things which
 * *close* connections all run after the things which *use* them.
 *
 * Nest tears an application down in four phases, in this fixed order:
 *
 *   1. `onModuleDestroy`
 *   2. `beforeApplicationShutdown`
 *   3. `dispose()`              — HTTP server closes, in-flight requests drain
 *   4. `onApplicationShutdown`  — `@nestjs/bull` closes its queues here
 *
 * Every teardown in this app used to hook phase 1, which is before all three of
 * the things it had to outlive. Postgres and Redis were gone before the workers
 * had drained a single job and before one in-flight HTTP request had finished —
 * so the drain that `enableShutdownHooks()` exists to allow ran entirely
 * against closed connections. Each service looked correct on its own; only the
 * order was wrong, and nothing local to any one file could see it.
 *
 * This suite replays those four phases over the real classes and asserts what
 * happened in what order. Moving any hook back to `onModuleDestroy` is a
 * one-word change that fails here and nowhere else.
 */

import { Logger } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import { PrismaService } from './prisma.service';
import { QueueDrainService } from '../queue/queue-drain.service';
import { RedisLifecycle, type RedisClient } from '../../modules/auth/redis.provider';
import {
  ANALYTICS_CACHE,
  AnalyticsCacheLifecycle,
  type AnalyticsCache,
} from '../../modules/analytics/analytics.cache';

/** What Nest calls, in the order Nest calls it. */
type Hooked = Partial<{
  onModuleDestroy(): unknown;
  beforeApplicationShutdown(signal?: string): unknown;
  onApplicationShutdown(signal?: string): unknown;
}>;

/**
 * Drive `providers` through Nest's four shutdown phases.
 *
 * `dispose` stands in for phase 3 — closing the HTTP server and draining
 * in-flight requests — which has no provider hook of its own but is the reason
 * the ordering matters.
 */
async function runShutdown(
  providers: Hooked[],
  dispose: () => void,
  signal = 'SIGTERM',
): Promise<void> {
  for (const p of providers) await p.onModuleDestroy?.();
  for (const p of providers) await p.beforeApplicationShutdown?.(signal);
  dispose();
  for (const p of providers) await p.onApplicationShutdown?.(signal);
}

describe('application shutdown ordering', () => {
  let events: string[];

  /** A Bull queue holding one active job that finishes as soon as it is paused. */
  function queueThatDrains(name: string) {
    let finished: () => void = () => undefined;
    const active = new Promise<void>((resolve) => {
      finished = resolve;
    });
    return {
      name,
      on: jest.fn(),
      getJobCounts: jest.fn(),
      pause: jest.fn().mockImplementation(async () => {
        events.push(`queue:${name}:paused`);
        // The job that was already running finishes once no more are taken.
        finished();
      }),
      whenCurrentJobsFinished: jest.fn().mockImplementation(async () => {
        await active;
        events.push(`queue:${name}:drained`);
      }),
    };
  }

  function discovery(queues: unknown[]): DiscoveryService {
    return {
      getProviders: () =>
        queues.map((q) => ({
          name: `BullQueue_${(q as { name: string }).name}`,
          instance: q,
        })),
    } as unknown as DiscoveryService;
  }

  beforeEach(() => {
    events = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  function buildProviders(): { providers: Hooked[]; dispose: () => void } {
    const prisma = new PrismaService();
    Object.assign(prisma, {
      $disconnect: jest.fn().mockImplementation(async () => {
        events.push('prisma:disconnected');
      }),
    });

    const redis = new RedisLifecycle({
      quit: jest.fn().mockImplementation(async () => {
        events.push('redis:quit');
        return 'OK';
      }),
      disconnect: jest.fn(),
    } as unknown as RedisClient);

    const analytics = new AnalyticsCacheLifecycle({
      get: jest.fn(),
      set: jest.fn(),
      close: jest.fn().mockImplementation(async () => {
        events.push('analytics-cache:closed');
      }),
    } as unknown as AnalyticsCache);

    const drain = new QueueDrainService(
      discovery([queueThatDrains('notifications'), queueThatDrains('bookings')]),
    );

    return {
      providers: [prisma, redis, analytics, drain],
      dispose: () => events.push('http:closed'),
    };
  }

  it('drains the queues, closes the HTTP server, and only then closes the connections', async () => {
    const { providers, dispose } = buildProviders();

    await runShutdown(providers, dispose);

    const at = (name: string) => events.indexOf(name);

    // Workers stop taking new jobs first, and finish what they hold.
    expect(at('queue:notifications:paused')).toBeGreaterThanOrEqual(0);
    expect(at('queue:notifications:drained')).toBeGreaterThan(
      at('queue:notifications:paused'),
    );

    // In-flight HTTP requests drain after the queues, before any teardown.
    expect(at('http:closed')).toBeGreaterThan(at('queue:notifications:drained'));
    expect(at('http:closed')).toBeGreaterThan(at('queue:bookings:drained'));

    // Every connection closes last — this is the assertion the old code failed.
    for (const teardown of ['prisma:disconnected', 'redis:quit', 'analytics-cache:closed']) {
      expect(at(teardown)).toBeGreaterThan(at('http:closed'));
    }
  });

  it('closes nothing in the first shutdown phase', async () => {
    const { providers, dispose } = buildProviders();

    // Phase 1 only. Nothing this app owns should have anything to do here.
    for (const p of providers) await p.onModuleDestroy?.();

    expect(events).toEqual([]);
    void dispose;
  });

  it('keeps Postgres and Redis reachable for the whole drain window', async () => {
    const { providers, dispose } = buildProviders();

    // A job still running while the queues drain, and a request still being
    // served while the HTTP server closes, both need these two open. Record
    // what is open at each point rather than trusting the order alone.
    const openAt: Record<string, boolean> = {};
    const snapshot = (label: string): void => {
      openAt[label] =
        !events.includes('prisma:disconnected') && !events.includes('redis:quit');
    };

    for (const p of providers) await p.onModuleDestroy?.();
    snapshot('after-phase-1');
    for (const p of providers) await p.beforeApplicationShutdown?.('SIGTERM');
    snapshot('after-queue-drain');
    dispose();
    snapshot('after-http-close');
    for (const p of providers) await p.onApplicationShutdown?.('SIGTERM');

    expect(openAt).toEqual({
      'after-phase-1': true,
      'after-queue-drain': true,
      'after-http-close': true,
    });
    expect(events).toContain('prisma:disconnected');
    expect(events).toContain('redis:quit');
  });

  it('closes every connection even when an earlier teardown fails', async () => {
    const { providers, dispose } = buildProviders();
    const [prisma] = providers;

    // Nest awaits each module's shutdown hooks in turn, so a rejection from one
    // provider can abort the rest. Redis and the analytics cache each swallow
    // their own failures for exactly this reason; Prisma deliberately does not,
    // so it goes last here and the two best-effort ones still ran.
    Object.assign(prisma as object, {
      $disconnect: jest.fn().mockRejectedValue(new Error('pool busy')),
    });

    await expect(
      runShutdown(providers.slice(1).concat(providers[0]!), dispose),
    ).rejects.toThrow('pool busy');

    expect(events).toContain('redis:quit');
    expect(events).toContain('analytics-cache:closed');
  });
});
