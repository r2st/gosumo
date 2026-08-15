/**
 * The one thing that says a background job died.
 *
 * Ten processors are registered across this app and not one of them had a
 * `failed` listener. A job that exhausts its three attempts therefore left no
 * trace anywhere a human looks: it went into Redis's failed set, which
 * `removeOnFail: 50` trims, and nothing logged, alerted, or counted it. A
 * hot-lead alert that never reached a broker and a hot-lead alert that was
 * never queued were indistinguishable from outside the process — and the one
 * dead-letter probe that exists reads the realty `dead_letters` table, which a
 * failed notification job never reaches.
 *
 * Queues are discovered rather than listed. `@nestjs/bull` registers each one
 * under a `BullQueue_<name>` provider token, so walking the container finds
 * every queue any module registers, including ones added later — a
 * hand-maintained list is exactly the kind that goes stale and takes the
 * telemetry for one queue with it.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { Queue } from 'bull';
import { discoverQueues } from './queue-discovery.util';

/** Per-queue job counts, as an ops route or a health probe wants them. */
export interface QueueDepth {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

/** A queue whose backlog has grown past what a healthy system carries. */
export interface QueueDepthBreach extends QueueDepth {
  threshold: number;
}

/**
 * Backlog size that means work is arriving faster than it is being done.
 *
 * Chosen to be quiet in normal operation: these queues are driven by inbound
 * messages and scheduled sweeps, and a few hundred waiting jobs is a burst,
 * not a stall. What it catches is the shape that does not drain — a dead
 * worker, an exhausted Redis, a poison job blocking a concurrency slot.
 */
export const QUEUE_DEPTH_WARN_THRESHOLD = 500;

@Injectable()
export class QueueTelemetryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(QueueTelemetryService.name);
  private readonly queues: Queue[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    for (const queue of discoverQueues(this.discovery)) {
      this.queues.push(queue);
      this.attach(queue);
    }
    this.logger.log(
      this.queues.length > 0
        ? `Watching ${this.queues.length} queue(s): ${this.queues.map((q) => q.name).join(', ')}`
        : 'No Bull queues found to watch',
    );
  }

  /**
   * Listen for the three things a queue says when it is in trouble.
   *
   * `failed` fires on every attempt, not only the last, so the two are
   * separated: a retry that will be tried again is a warning, an exhausted job
   * is an error, because only the second one means work was lost.
   */
  private attach(queue: Queue): void {
    queue.on('failed', (job, err) => {
      const attempts = job?.attemptsMade ?? 0;
      const max = job?.opts?.attempts ?? 1;
      const detail =
        `queue=${queue.name} job=${job?.id ?? '?'} name=${job?.name ?? '?'} ` +
        `attempt=${attempts}/${max}: ${err instanceof Error ? err.message : String(err)}`;

      // No job on the event means the failure could not even be tied to one,
      // so there is nothing to say a retry is coming: report it as loud as a
      // terminal failure rather than as a reassuring "will retry".
      if (!job || attempts >= max) {
        // Terminal. Nothing downstream will retry this, and the payload is
        // about to age out of Redis — this line is the only record it existed.
        this.logger.error(`Job exhausted its retries and was dropped — ${detail}`);
      } else {
        this.logger.warn(`Job failed, will retry — ${detail}`);
      }
    });

    // A stalled job is one whose worker stopped renewing its lock: the process
    // died, or the handler blocked the event loop long enough to look dead.
    // Bull re-queues it, which means silent duplicate work if it was halfway.
    queue.on('stalled', (job) => {
      this.logger.warn(`Job stalled and will be re-run — queue=${queue.name} job=${job?.id ?? '?'}`);
    });

    // Queue-level (usually Redis) trouble, distinct from any one job.
    queue.on('error', (err: Error) => {
      this.logger.error(`Queue error — queue=${queue.name}: ${err.message}`);
    });
  }

  /** Current depth of every watched queue. Never throws — a probe that 500s says less. */
  async depths(): Promise<QueueDepth[]> {
    const reports = await Promise.all(
      this.queues.map(async (queue): Promise<QueueDepth> => {
        try {
          const counts = await queue.getJobCounts();
          return {
            name: queue.name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          };
        } catch (err) {
          this.logger.warn(
            `Could not read job counts for queue ${queue.name}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          return { name: queue.name, waiting: 0, active: 0, delayed: 0, failed: 0 };
        }
      }),
    );
    return reports;
  }

  /**
   * Queues whose waiting backlog is over the threshold.
   *
   * Counts `waiting` only. `delayed` is on purpose — a snooze-wake scheduled
   * for next week is a delayed job, and thousands of them are a healthy system
   * doing what it was told, not a backlog.
   */
  async depthBreaches(
    threshold: number = QUEUE_DEPTH_WARN_THRESHOLD,
  ): Promise<QueueDepthBreach[]> {
    const depths = await this.depths();
    return depths
      .filter((d) => d.waiting > threshold)
      .map((d) => ({ ...d, threshold }));
  }
}
