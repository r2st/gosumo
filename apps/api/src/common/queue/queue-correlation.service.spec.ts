import type { DiscoveryService } from '@nestjs/core';
import { getCorrelationId, runWithRequestContext } from '../context/request-context';
import {
  CORRELATION_JOB_KEY,
  QueueCorrelationService,
} from './queue-correlation.service';

interface FakeQueue {
  name: string;
  on: jest.Mock;
  getJobCounts: jest.Mock;
  add: jest.Mock;
  handlers: Record<string, unknown>;
  /**
   * The `add` the service wrapped, kept aside because after bootstrap
   * `queue.add` *is* the wrapper — asserting on it would only prove the
   * wrapper was called, never what it passed through to Bull.
   */
  originalAdd: jest.Mock;
}

function fakeQueue(name: string, handlers: Record<string, unknown> = {}): FakeQueue {
  const add = jest.fn().mockResolvedValue({ id: '1' });
  return {
    name,
    on: jest.fn(),
    getJobCounts: jest.fn().mockResolvedValue({}),
    add,
    handlers,
    originalAdd: add,
  };
}

function discovery(queues: FakeQueue[]): DiscoveryService {
  return {
    getProviders: () => [
      ...queues.map((q) => ({ name: `BullQueue_${q.name}`, instance: q })),
      // Right prefix, wrong shape — the discovery filter has to skip it.
      { name: 'BullQueue_broken', instance: { name: 'broken' } },
      { name: 'ConversationService', instance: { name: 'not-a-queue' } },
    ],
  } as unknown as DiscoveryService;
}

function bootstrap(queues: FakeQueue[]): QueueCorrelationService {
  const service = new QueueCorrelationService(discovery(queues));
  service.onApplicationBootstrap();
  return service;
}

describe('QueueCorrelationService — producer', () => {
  it('stamps the active correlation id onto an enqueued job', () => {
    const queue = fakeQueue('conversation');
    bootstrap([queue]);

    runWithRequestContext({ correlationId: 'req-1' }, () => {
      queue.add('process', { messageId: 'm1' });
    });

    expect(queue.originalAdd).toHaveBeenCalledWith('process', {
      [CORRELATION_JOB_KEY]: 'req-1',
      messageId: 'm1',
    });
  });

  it('handles the unnamed add(data, opts) overload', () => {
    // Bull accepts both shapes and this codebase uses both, so the data
    // argument is located by shape rather than by assuming a position.
    const queue = fakeQueue('notifications');
    bootstrap([queue]);

    runWithRequestContext({ correlationId: 'req-2' }, () => {
      queue.add({ to: 'x' }, { attempts: 3 });
    });

    expect(queue.originalAdd).toHaveBeenCalledWith(
      { [CORRELATION_JOB_KEY]: 'req-2', to: 'x' },
      { attempts: 3 },
    );
  });

  it('passes job options through untouched', () => {
    const queue = fakeQueue('booking');
    bootstrap([queue]);

    runWithRequestContext({ correlationId: 'req-3' }, () => {
      queue.add('reminder', { id: 'b1' }, { delay: 5_000, jobId: 'dedupe-key' });
    });

    expect(queue.originalAdd).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { delay: 5_000, jobId: 'dedupe-key' },
    );
  });

  it('does not mutate the object the caller passed', () => {
    // The caller may still hold and reuse it.
    const queue = fakeQueue('conversation');
    bootstrap([queue]);
    const payload = { messageId: 'm1' };

    runWithRequestContext({ correlationId: 'req-4' }, () => {
      queue.add('process', payload);
    });

    expect(payload).toEqual({ messageId: 'm1' });
  });

  it('keeps an id the payload already carries', () => {
    // A retry re-enqueues the job; it must keep the id of the request that
    // originally caused it, not the one that happened to trigger the retry.
    const queue = fakeQueue('webhook-dlq');
    bootstrap([queue]);

    runWithRequestContext({ correlationId: 'retrying-request' }, () => {
      queue.add('recover', { [CORRELATION_JOB_KEY]: 'original-request', id: 'w1' });
    });

    expect(queue.originalAdd).toHaveBeenCalledWith('recover', {
      [CORRELATION_JOB_KEY]: 'original-request',
      id: 'w1',
    });
  });

  it('enqueues unstamped outside a request', () => {
    // A cron registration at boot has nothing to inherit. The consumer mints
    // its own id instead — an id invented here would join nothing.
    const queue = fakeQueue('compliance');
    bootstrap([queue]);

    queue.add('sweep', { weekly: true });

    expect(queue.originalAdd).toHaveBeenCalledWith('sweep', { weekly: true });
  });

  it('leaves a non-object payload alone', () => {
    const queue = fakeQueue('conversation');
    bootstrap([queue]);

    runWithRequestContext({ correlationId: 'req-5' }, () => {
      queue.add('process', 'a-string-payload');
    });

    expect(queue.originalAdd).toHaveBeenCalledWith('process', 'a-string-payload');
  });

  it('returns whatever the underlying add returns', () => {
    // Callers await this; swallowing the promise would break every producer.
    const queue = fakeQueue('conversation');
    bootstrap([queue]);

    return runWithRequestContext({ correlationId: 'req-6' }, async () => {
      await expect(queue.add('process', {})).resolves.toEqual({ id: '1' });
    });
  });
});

describe('QueueCorrelationService — consumer', () => {
  /** Invoke a queue's registered handler the way Bull does. */
  const runJob = (queue: FakeQueue, name: string, data: unknown) =>
    (queue.handlers[name] as (job: unknown) => unknown)({ data });

  it('re-enters the originating request context inside the handler', async () => {
    // The whole point: a job that ran minutes later, in a different tick, logs
    // under the id of the request that caused it.
    let seen: string | undefined;
    const queue = fakeQueue('conversation', {
      process: async () => {
        seen = getCorrelationId();
      },
    });
    bootstrap([queue]);

    await runJob(queue, 'process', { [CORRELATION_JOB_KEY]: 'req-1', messageId: 'm1' });

    expect(seen).toBe('req-1');
  });

  it('holds the context across awaits inside the handler', async () => {
    let seen: string | undefined;
    const queue = fakeQueue('conversation', {
      process: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        seen = getCorrelationId();
      },
    });
    bootstrap([queue]);

    await runJob(queue, 'process', { [CORRELATION_JOB_KEY]: 'req-2' });

    expect(seen).toBe('req-2');
  });

  it('mints an id for a job that carries none', async () => {
    // Cron-triggered work, and jobs already in Redis at deploy time. Their
    // lines still join each other even though they join no request.
    let seen: string | undefined;
    const queue = fakeQueue('compliance', {
      sweep: async () => {
        seen = getCorrelationId();
      },
    });
    bootstrap([queue]);

    await runJob(queue, 'sweep', { weekly: true });

    expect(seen).toBeDefined();
  });

  it('gives two unstamped jobs different ids', async () => {
    const seen: (string | undefined)[] = [];
    const queue = fakeQueue('compliance', {
      sweep: async () => {
        seen.push(getCorrelationId());
      },
    });
    bootstrap([queue]);

    await runJob(queue, 'sweep', {});
    await runJob(queue, 'sweep', {});

    expect(seen[0]).not.toBe(seen[1]);
  });

  it('preserves the handler result', async () => {
    const queue = fakeQueue('conversation', { process: async () => 'done' });
    bootstrap([queue]);

    await expect(runJob(queue, 'process', {})).resolves.toBe('done');
  });

  it('lets a handler rejection through', async () => {
    // Bull's retry and the exhausted-retry ERROR line are the error boundary.
    // Swallowing here would mark a failed job complete and lose the work.
    const queue = fakeQueue('conversation', {
      process: async () => {
        throw new Error('handler blew up');
      },
    });
    bootstrap([queue]);

    await expect(runJob(queue, 'process', {})).rejects.toThrow('handler blew up');
  });

  it('wraps the catch-all handler too', async () => {
    let seen: string | undefined;
    const queue = fakeQueue('realty-dlq', {
      '*': async () => {
        seen = getCorrelationId();
      },
    });
    bootstrap([queue]);

    await runJob(queue, '*', { [CORRELATION_JOB_KEY]: 'req-3' });

    expect(seen).toBe('req-3');
  });

  it('ignores a stamp that is not a usable string', async () => {
    let seen: string | undefined;
    const queue = fakeQueue('conversation', {
      process: async () => {
        seen = getCorrelationId();
      },
    });
    bootstrap([queue]);

    await runJob(queue, 'process', { [CORRELATION_JOB_KEY]: { nested: true } });

    expect(typeof seen).toBe('string');
  });
});

describe('QueueCorrelationService — bootstrap', () => {
  it('covers every discovered queue', () => {
    const a = fakeQueue('one');
    const b = fakeQueue('two');
    bootstrap([a, b]);

    runWithRequestContext({ correlationId: 'req-1' }, () => {
      a.add('x', {});
      b.add('y', {});
    });

    expect(a.originalAdd).toHaveBeenCalledWith('x', { [CORRELATION_JOB_KEY]: 'req-1' });
    expect(b.originalAdd).toHaveBeenCalledWith('y', { [CORRELATION_JOB_KEY]: 'req-1' });
  });

  it('does not double-wrap on a second bootstrap', () => {
    // Two passes stamping the same payload must not nest or duplicate work.
    const queue = fakeQueue('conversation');
    const service = new QueueCorrelationService(discovery([queue]));
    service.onApplicationBootstrap();
    service.onApplicationBootstrap();

    runWithRequestContext({ correlationId: 'req-1' }, () => {
      queue.add('process', { a: 1 });
    });

    expect(queue.originalAdd).toHaveBeenCalledWith('process', {
      [CORRELATION_JOB_KEY]: 'req-1',
      a: 1,
    });
  });

  it('survives a queue that exposes no handler table', () => {
    /**
     * `handlers` is Bull's internal field. If a future version renames it, the
     * cost must be a degraded log — not a failed bootstrap, which is an
     * outage. The producer half must still be wrapped.
     */
    const queue = fakeQueue('conversation');
    delete (queue as Partial<FakeQueue>).handlers;

    expect(() => bootstrap([queue])).not.toThrow();

    runWithRequestContext({ correlationId: 'req-1' }, () => {
      queue.add('process', {});
    });
    expect(queue.originalAdd).toHaveBeenCalledWith('process', {
      [CORRELATION_JOB_KEY]: 'req-1',
    });
  });

  it('skips a non-function entry in the handler table', () => {
    const queue = fakeQueue('conversation', { bogus: 'not-a-function' });
    expect(() => bootstrap([queue])).not.toThrow();
    expect(queue.handlers.bogus).toBe('not-a-function');
  });

  it('tolerates a container with no queues at all', () => {
    expect(() => bootstrap([])).not.toThrow();
  });
});
