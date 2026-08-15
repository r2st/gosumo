/**
 * Stopping the workers before anything they depend on is taken away.
 *
 * Nest runs shutdown in four phases, in this order:
 *
 *   1. `onModuleDestroy`
 *   2. `beforeApplicationShutdown`   ← this service
 *   3. `dispose()`                   — HTTP server closed, in-flight requests drain
 *   4. `onApplicationShutdown`       — where `@nestjs/bull` closes each queue
 *
 * `queue.close()` in phase 4 does drain: it locally pauses the queue and waits
 * for whatever that worker has active. But phase 4 is the *end* of shutdown,
 * and until it is reached the workers are still pulling new jobs off Redis —
 * jobs picked up during phases 1–3, i.e. after the process has already been
 * told to die and while its HTTP server is closing. Each one then gets the
 * remainder of the supervisor's kill timer to finish, and the ones that do not
 * are left as stalled jobs for the next boot to re-run, halfway done.
 *
 * Pausing here is the fix: the moment SIGTERM lands, this worker stops taking
 * work, and what it already holds is given a bounded window to finish while
 * everything it needs — Postgres, Redis, the HTTP server — is still up. Jobs
 * still waiting in Redis are untouched and are picked up by another instance,
 * or by this one on restart.
 *
 * The pause is *local* (`pause(true, …)`): it stops this process's workers, not
 * the queue globally. A global pause would be a shared-state change made by one
 * instance restarting, and it would outlive the process that made it — every
 * other instance, and the next boot, would find the queue paused with nothing
 * to say why.
 */

import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Queue } from 'bull';
import { discoverQueues } from './queue-discovery.util';

/**
 * How long the drain waits for jobs already running on this worker.
 *
 * Bounded, and deliberately far below `JOB_TIMEOUT_MS` (5 min): a job is
 * allowed to run for five minutes, but shutdown is not allowed to *wait* five
 * minutes for one. systemd's default `TimeoutStopSec` is 90s and the HTTP
 * drain in phase 3 still has to happen after this, so the budget here is the
 * part of that window a queue may spend.
 *
 * A job still running when this elapses is not killed by us — it keeps going
 * until the process exits, and Bull's stall detection re-queues it for another
 * worker. The timeout bounds how long we *wait*, not how long the job gets.
 */
export const QUEUE_DRAIN_TIMEOUT_MS = 15_000;

/** The two methods this service calls beyond the shared `isQueue` shape. */
type DrainableQueue = Queue & {
  pause?: (isLocal?: boolean, doNotWaitActive?: boolean) => Promise<void>;
  whenCurrentJobsFinished?: () => Promise<void>;
};

/**
 * Resolve when `work` settles or when `ms` elapses, whichever is first.
 *
 * The timer is `unref`'d and cleared on the settled path: a drain that has
 * already finished must not be the reason the process sits waiting for a timer
 * that has nothing left to fire for.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });

  try {
    return await Promise.race([
      work.then(() => ({ timedOut: false as const })),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class QueueDrainService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(QueueDrainService.name);

  constructor(private readonly discovery: DiscoveryService) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    const queues = discoverQueues(this.discovery) as DrainableQueue[];
    if (queues.length === 0) return;

    this.logger.log(
      `${signal ?? 'shutdown'} — draining ${queues.length} queue(s) before teardown`,
    );

    // In parallel, so the whole drain is bounded by the slowest queue rather
    // than by their sum. A queue that throws is logged and skipped: one
    // unreachable Redis must not stop the others from being drained, and it
    // must never stop the shutdown itself.
    await Promise.all(queues.map((queue) => this.drain(queue)));
  }

  /** Stop taking new jobs, then wait — with a deadline — for the active ones. */
  private async drain(queue: DrainableQueue): Promise<void> {
    const name = queue.name;

    try {
      // `doNotWaitActive: true` — the wait is done below, where it has a
      // deadline. Bull's own wait inside `pause` has none, so leaving it to do
      // the waiting is how shutdown hangs until the supervisor SIGKILLs it.
      await queue.pause?.(true, true);
    } catch (err) {
      this.logger.warn(`Could not pause queue ${name}: ${describe(err)}`);
      // A queue that could not be paused may still have active jobs worth
      // waiting for, so fall through rather than returning.
    }

    if (typeof queue.whenCurrentJobsFinished !== 'function') {
      this.logger.log(`Queue ${name} paused (no active-job wait available)`);
      return;
    }

    try {
      const { timedOut } = await withDeadline(
        queue.whenCurrentJobsFinished(),
        QUEUE_DRAIN_TIMEOUT_MS,
      );
      if (timedOut) {
        // Named explicitly because this is the line that explains a duplicate:
        // the job is still running, the process is about to go, and Bull will
        // hand the same job to another worker once its lock expires.
        this.logger.warn(
          `Queue ${name} still had active job(s) after ${QUEUE_DRAIN_TIMEOUT_MS}ms — ` +
            'leaving them to stall detection; they will be re-run elsewhere',
        );
      } else {
        this.logger.log(`Queue ${name} drained`);
      }
    } catch (err) {
      this.logger.warn(`Could not drain queue ${name}: ${describe(err)}`);
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
