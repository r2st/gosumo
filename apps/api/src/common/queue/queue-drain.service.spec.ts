import { Logger } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import {
  QUEUE_DRAIN_TIMEOUT_MS,
  QueueDrainService,
  withDeadline,
} from './queue-drain.service';

interface FakeQueue {
  name: string;
  on: jest.Mock;
  getJobCounts: jest.Mock;
  pause: jest.Mock;
  whenCurrentJobsFinished: jest.Mock;
}

/** A queue whose active-job wait resolves when the returned `finish` is called. */
function fakeQueue(
  name: string,
  overrides: Partial<Pick<FakeQueue, 'pause' | 'whenCurrentJobsFinished'>> = {},
): { queue: FakeQueue; finish: () => void } {
  let release: () => void = () => undefined;
  const active = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queue: FakeQueue = {
    name,
    on: jest.fn(),
    getJobCounts: jest.fn().mockResolvedValue({}),
    pause: jest.fn().mockResolvedValue(undefined),
    whenCurrentJobsFinished: jest.fn().mockReturnValue(active),
    ...overrides,
  };

  return { queue, finish: release };
}

function discovery(queues: FakeQueue[], extra: unknown[] = []): DiscoveryService {
  return {
    getProviders: () => [
      ...queues.map((q) => ({ name: `BullQueue_${q.name}`, instance: q })),
      // Noise the discovery filter has to skip: right prefix, wrong shape.
      { name: 'BullQueue_broken', instance: { name: 'broken' } },
      { name: 'ConversationService', instance: { name: 'not-a-queue' } },
      ...extra,
    ],
  } as unknown as DiscoveryService;
}

describe('withDeadline', () => {
  it('reports the work finishing before the deadline', async () => {
    await expect(withDeadline(Promise.resolve('done'), 1_000)).resolves.toEqual({
      timedOut: false,
    });
  });

  it('reports a timeout without waiting for the work', async () => {
    jest.useFakeTimers();
    try {
      const pending = new Promise<void>(() => undefined); // never settles
      const raced = withDeadline(pending, 50);
      jest.advanceTimersByTime(50);
      await expect(raced).resolves.toEqual({ timedOut: true });
    } finally {
      jest.useRealTimers();
    }
  });

  it('unrefs the deadline timer so a finished drain cannot hold the process open', async () => {
    const unref = jest.fn();
    const spy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation((() => ({ unref })) as unknown as typeof setTimeout);
    try {
      await withDeadline(Promise.resolve(), 1_000);
      expect(unref).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('QueueDrainService', () => {
  let logs: string[];
  let warns: string[];

  beforeEach(() => {
    logs = [];
    warns = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m) => logs.push(String(m)));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => warns.push(String(m)));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('pauses every discovered queue locally, without waiting inside pause', async () => {
    const a = fakeQueue('notifications');
    const b = fakeQueue('bookings');
    a.finish();
    b.finish();

    const service = new QueueDrainService(discovery([a.queue, b.queue]));
    await service.beforeApplicationShutdown('SIGTERM');

    // `true, true` = local pause (never a global one, which would outlive this
    // process) and do not block inside pause (the wait below has the deadline).
    expect(a.queue.pause).toHaveBeenCalledWith(true, true);
    expect(b.queue.pause).toHaveBeenCalledWith(true, true);
  });

  it('waits for active jobs to finish before returning', async () => {
    const { queue, finish } = fakeQueue('notifications');
    const service = new QueueDrainService(discovery([queue]));

    let settled = false;
    const draining = service.beforeApplicationShutdown('SIGTERM').then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false); // still holding an active job

    finish();
    await draining;
    expect(settled).toBe(true);
    expect(logs).toContain('Queue notifications drained');
  });

  it('gives up on a job that outlives the deadline and says so', async () => {
    jest.useFakeTimers();
    try {
      const { queue } = fakeQueue('notifications'); // never finished
      const service = new QueueDrainService(discovery([queue]));

      const draining = service.beforeApplicationShutdown('SIGTERM');
      await Promise.resolve();
      jest.advanceTimersByTime(QUEUE_DRAIN_TIMEOUT_MS);
      await draining;

      expect(warns.some((w) => /still had active job\(s\)/.test(w))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still waits for active jobs when the pause itself fails', async () => {
    const { queue, finish } = fakeQueue('notifications', {
      pause: jest.fn().mockRejectedValue(new Error('redis gone')),
    });
    finish();

    const service = new QueueDrainService(discovery([queue]));
    await service.beforeApplicationShutdown('SIGTERM');

    expect(warns.some((w) => w.includes('Could not pause queue notifications'))).toBe(true);
    expect(queue.whenCurrentJobsFinished).toHaveBeenCalled();
  });

  it('never lets one broken queue stop the others from draining', async () => {
    const broken = fakeQueue('broken', {
      whenCurrentJobsFinished: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const healthy = fakeQueue('bookings');
    healthy.finish();

    const service = new QueueDrainService(discovery([broken.queue, healthy.queue]));
    await expect(service.beforeApplicationShutdown('SIGTERM')).resolves.toBeUndefined();

    expect(healthy.queue.pause).toHaveBeenCalled();
    expect(logs).toContain('Queue bookings drained');
    expect(warns.some((w) => w.includes('Could not drain queue broken'))).toBe(true);
  });

  it('is a no-op when no queues are registered', async () => {
    const service = new QueueDrainService(discovery([]));
    await expect(service.beforeApplicationShutdown('SIGTERM')).resolves.toBeUndefined();
    expect(logs).toHaveLength(0);
  });

  it('drains queues in parallel, so shutdown is bounded by the slowest not their sum', async () => {
    const a = fakeQueue('a');
    const b = fakeQueue('b');
    const service = new QueueDrainService(discovery([a.queue, b.queue]));

    const draining = service.beforeApplicationShutdown('SIGTERM');
    await Promise.resolve();

    // Both waits were started before either was finished — a sequential drain
    // would not have touched `b` yet.
    expect(a.queue.whenCurrentJobsFinished).toHaveBeenCalled();
    expect(b.queue.whenCurrentJobsFinished).toHaveBeenCalled();

    a.finish();
    b.finish();
    await draining;
  });

  it('tolerates a queue with no whenCurrentJobsFinished', async () => {
    const queue = {
      name: 'legacy',
      on: jest.fn(),
      getJobCounts: jest.fn(),
      pause: jest.fn().mockResolvedValue(undefined),
    } as unknown as FakeQueue;

    const service = new QueueDrainService(discovery([queue]));
    await service.beforeApplicationShutdown('SIGTERM');

    expect(queue.pause).toHaveBeenCalledWith(true, true);
    expect(logs).toContain('Queue legacy paused (no active-job wait available)');
  });
});
