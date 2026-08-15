import { Logger } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import {
  QUEUE_DEPTH_WARN_THRESHOLD,
  QueueTelemetryService,
} from './queue-telemetry.service';

type Handler = (...args: unknown[]) => void;

interface FakeQueue {
  name: string;
  on: jest.Mock;
  getJobCounts: jest.Mock;
  handlers: Record<string, Handler>;
  fire: (event: string, ...args: unknown[]) => void;
}

function fakeQueue(name: string, counts: Record<string, number> = {}): FakeQueue {
  const handlers: Record<string, Handler> = {};
  const queue: FakeQueue = {
    name,
    handlers,
    on: jest.fn((event: string, handler: Handler) => {
      handlers[event] = handler;
      return queue;
    }),
    getJobCounts: jest.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      ...counts,
    }),
    fire: (event, ...args) => handlers[event]?.(...args),
  };
  return queue;
}

/** A DiscoveryService whose providers are the given queues, plus some noise. */
function discovery(queues: FakeQueue[], extra: unknown[] = []): DiscoveryService {
  const providers = [
    ...queues.map((q) => ({ name: `BullQueue_${q.name}`, instance: q })),
    { name: 'ConversationService', instance: { name: 'not-a-queue' } },
    ...extra,
  ];
  return { getProviders: () => providers } as unknown as DiscoveryService;
}

function job(overrides: Record<string, unknown> = {}): unknown {
  return { id: 'job-1', name: 'send', attemptsMade: 1, opts: { attempts: 3 }, ...overrides };
}

describe('QueueTelemetryService', () => {
  let errors: string[];
  let warns: string[];

  beforeEach(() => {
    errors = [];
    warns = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m) => errors.push(String(m)));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => warns.push(String(m)));
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('discovery', () => {
    it('finds every registered Bull queue and skips everything else', () => {
      const a = fakeQueue('notification');
      const b = fakeQueue('conversation');
      const service = new QueueTelemetryService(discovery([a, b]));

      service.onApplicationBootstrap();

      expect(a.on).toHaveBeenCalled();
      expect(b.on).toHaveBeenCalled();
    });

    it('ignores a same-prefix provider that is not actually a queue', async () => {
      const service = new QueueTelemetryService(
        discovery([], [{ name: 'BullQueue_broken', instance: { name: 'broken' } }]),
      );

      service.onApplicationBootstrap();

      await expect(service.depths()).resolves.toEqual([]);
    });

    it('copes with no queues at all', () => {
      const service = new QueueTelemetryService(discovery([]));
      expect(() => service.onApplicationBootstrap()).not.toThrow();
    });
  });

  describe('failed jobs', () => {
    /**
     * The regression this whole service exists for: before it, a job that
     * burned all three attempts left no trace anywhere a human looks.
     */
    it('logs an ERROR when a job exhausts its retries', () => {
      const queue = fakeQueue('notification');
      new QueueTelemetryService(discovery([queue])).onApplicationBootstrap();

      queue.fire('failed', job({ attemptsMade: 3 }), new Error('SMTP refused'));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('exhausted its retries');
      expect(errors[0]).toContain('queue=notification');
      expect(errors[0]).toContain('job=job-1');
      expect(errors[0]).toContain('attempt=3/3');
      expect(errors[0]).toContain('SMTP refused');
    });

    it('logs only a WARN for an attempt that will be retried', () => {
      const queue = fakeQueue('notification');
      new QueueTelemetryService(discovery([queue])).onApplicationBootstrap();

      queue.fire('failed', job({ attemptsMade: 1 }), new Error('transient'));

      expect(errors).toHaveLength(0);
      expect(warns[0]).toContain('will retry');
    });

    it('treats a job with no attempts configured as single-shot', () => {
      const queue = fakeQueue('notification');
      new QueueTelemetryService(discovery([queue])).onApplicationBootstrap();

      queue.fire('failed', job({ attemptsMade: 1, opts: {} }), new Error('boom'));

      expect(errors[0]).toContain('exhausted its retries');
    });

    it('survives a failure event with no job and a non-Error reason', () => {
      const queue = fakeQueue('notification');
      new QueueTelemetryService(discovery([queue])).onApplicationBootstrap();

      expect(() => queue.fire('failed', undefined, 'redis went away')).not.toThrow();
      expect(errors[0]).toContain('redis went away');
    });
  });

  it('warns on a stalled job, which Bull silently re-runs', () => {
    const queue = fakeQueue('conversation');
    new QueueTelemetryService(discovery([queue])).onApplicationBootstrap();

    queue.fire('stalled', job());

    expect(warns[0]).toContain('stalled and will be re-run');
  });

  it('logs a queue-level error separately from any one job', () => {
    const queue = fakeQueue('conversation');
    new QueueTelemetryService(discovery([queue])).onApplicationBootstrap();

    queue.fire('error', new Error('ECONNRESET'));

    expect(errors[0]).toContain('Queue error');
    expect(errors[0]).toContain('ECONNRESET');
  });

  describe('depth', () => {
    it('reports the counts of every watched queue', async () => {
      const service = new QueueTelemetryService(
        discovery([fakeQueue('a', { waiting: 3, active: 1 }), fakeQueue('b', { failed: 7 })]),
      );
      service.onApplicationBootstrap();

      await expect(service.depths()).resolves.toEqual([
        { name: 'a', waiting: 3, active: 1, delayed: 0, failed: 0 },
        { name: 'b', waiting: 0, active: 0, delayed: 0, failed: 7 },
      ]);
    });

    it('degrades to zeroes rather than throwing when Redis will not answer', async () => {
      const queue = fakeQueue('a');
      queue.getJobCounts.mockRejectedValue(new Error('redis down'));
      const service = new QueueTelemetryService(discovery([queue]));
      service.onApplicationBootstrap();

      await expect(service.depths()).resolves.toEqual([
        { name: 'a', waiting: 0, active: 0, delayed: 0, failed: 0 },
      ]);
    });

    it('flags a queue whose waiting backlog is over the threshold', async () => {
      const service = new QueueTelemetryService(
        discovery([fakeQueue('busy', { waiting: QUEUE_DEPTH_WARN_THRESHOLD + 1 })]),
      );
      service.onApplicationBootstrap();

      const breaches = await service.depthBreaches();

      expect(breaches).toHaveLength(1);
      expect(breaches[0]).toMatchObject({ name: 'busy', threshold: QUEUE_DEPTH_WARN_THRESHOLD });
    });

    it('does not flag a queue sitting exactly on the threshold', async () => {
      const service = new QueueTelemetryService(
        discovery([fakeQueue('busy', { waiting: QUEUE_DEPTH_WARN_THRESHOLD })]),
      );
      service.onApplicationBootstrap();

      await expect(service.depthBreaches()).resolves.toEqual([]);
    });

    it('ignores delayed jobs — a snooze scheduled for next week is not a backlog', async () => {
      const service = new QueueTelemetryService(
        discovery([fakeQueue('conversation', { waiting: 2, delayed: 50_000 })]),
      );
      service.onApplicationBootstrap();

      await expect(service.depthBreaches()).resolves.toEqual([]);
    });

    it('honours an explicit threshold', async () => {
      const service = new QueueTelemetryService(discovery([fakeQueue('a', { waiting: 5 })]));
      service.onApplicationBootstrap();

      await expect(service.depthBreaches(4)).resolves.toHaveLength(1);
      await expect(service.depthBreaches(5)).resolves.toHaveLength(0);
    });
  });
});
