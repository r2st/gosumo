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

/** Depth plus how fast this process is actually working the queue. */
export interface QueueThroughput extends QueueDepth {
  completedInWindow: number;
  failedInWindow: number;
  /** How much of the window has actually elapsed — see {@link RollingCounter}. */
  windowMinutes: number;
  completedPerMinute: number;
  failedPerMinute: number;
  /** `stalled` means backlog with nothing moving — the one worth alerting on. */
  state: 'draining' | 'stalled' | 'idle';
}

/** How far back throughput is measured. */
export const THROUGHPUT_WINDOW_MINUTES = 5;

/** Two decimals, so a rate reads as a rate and not as float dust. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A count over a sliding window, kept as one bucket per minute.
 *
 * Buckets rather than timestamps because the thing being counted is every job
 * this process completes — at a few hundred a minute, retaining a timestamp
 * each would be an unbounded array in a long-lived process, which is the
 * memory leak this class exists to not be. Fixed buckets cost
 * {@link THROUGHPUT_WINDOW_MINUTES} numbers per queue, forever.
 *
 * Deliberately not backed by Redis or Bull's own metrics: this counts what
 * *this* process did, which is the number that distinguishes "the cluster is
 * busy" from "this instance's workers are dead".
 */
class RollingCounter {
  private readonly completedBuckets: number[];
  private readonly failedBuckets: number[];
  private lastMinute: number;
  private readonly startedAtMs: number;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowSize: number = THROUGHPUT_WINDOW_MINUTES,
  ) {
    this.completedBuckets = new Array<number>(windowSize).fill(0);
    this.failedBuckets = new Array<number>(windowSize).fill(0);
    this.startedAtMs = now();
    this.lastMinute = Math.floor(this.startedAtMs / 60_000);
  }

  recordCompleted(): void {
    this.roll();
    this.completedBuckets[this.index()] = (this.completedBuckets[this.index()] ?? 0) + 1;
  }

  recordFailed(): void {
    this.roll();
    this.failedBuckets[this.index()] = (this.failedBuckets[this.index()] ?? 0) + 1;
  }

  completed(): number {
    this.roll();
    return this.completedBuckets.reduce((a, b) => a + b, 0);
  }

  failed(): number {
    this.roll();
    return this.failedBuckets.reduce((a, b) => a + b, 0);
  }

  /**
   * The window actually covered so far, in minutes.
   *
   * A process up for 40 seconds has not observed five minutes of queue
   * behaviour, and dividing its two completed jobs by five would report a rate
   * four times lower than reality — right after a restart, which is exactly
   * when someone is watching. Capped at the window size once the process is
   * older than it.
   */
  windowMinutes(): number {
    const elapsed = (this.now() - this.startedAtMs) / 60_000;
    return Math.max(0, Math.min(this.windowSize, elapsed));
  }

  private index(): number {
    return this.lastMinute % this.windowSize;
  }

  /** Zero every bucket the clock has passed since the last write. */
  private roll(): void {
    const minute = Math.floor(this.now() / 60_000);
    if (minute === this.lastMinute) return;

    const elapsed = Math.min(minute - this.lastMinute, this.windowSize);
    for (let i = 1; i <= elapsed; i++) {
      const slot = (this.lastMinute + i) % this.windowSize;
      this.completedBuckets[slot] = 0;
      this.failedBuckets[slot] = 0;
    }
    this.lastMinute = minute;
  }
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
  /** Per-queue throughput, by queue name. */
  private readonly counters = new Map<string, RollingCounter>();

  constructor(private readonly discovery: DiscoveryService) {}

  onApplicationBootstrap(): void {
    for (const queue of discoverQueues(this.discovery)) {
      this.queues.push(queue);
      this.counters.set(queue.name, new RollingCounter());
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
    // Counted, not logged. A completed job is the ordinary case and logging it
    // would bury every line that matters; the count is what turns a queue depth
    // into a verdict — see `throughput()`.
    queue.on('completed', () => {
      this.counters.get(queue.name)?.recordCompleted();
    });

    queue.on('failed', (job, err) => {
      this.counters.get(queue.name)?.recordFailed();
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

  /**
   * Depth plus **throughput** for every watched queue.
   *
   * Depth alone cannot distinguish the two situations an operator most needs
   * to tell apart. A queue sitting at 400 waiting while completing 60 jobs a
   * minute is a busy system that will drain; a queue sitting at 400 while
   * completing zero is a dead worker. The counts are identical and the
   * verdicts are opposite, so the backlog number on its own has never been
   * enough to act on.
   *
   * Rates come from this process only, and the report says so — with several
   * instances behind a load balancer, each sees the jobs it personally ran.
   * That is the honest number and also the useful one: "this instance is
   * processing nothing while the queue is deep" is precisely the fault that a
   * cluster-wide average would hide.
   */
  async throughput(): Promise<QueueThroughput[]> {
    const depths = await this.depths();
    return depths.map((depth) => {
      const counter = this.counters.get(depth.name);
      const windowMinutes = counter ? counter.windowMinutes() : 0;
      const completed = counter?.completed() ?? 0;
      const failed = counter?.failed() ?? 0;

      return {
        ...depth,
        completedInWindow: completed,
        failedInWindow: failed,
        windowMinutes,
        // Guarded rather than divided by a possibly-zero window: a process that
        // booted a second ago has no rate, and reporting one computed over
        // milliseconds of uptime would read as a wildly busy queue.
        completedPerMinute: windowMinutes > 0 ? round2(completed / windowMinutes) : 0,
        failedPerMinute: windowMinutes > 0 ? round2(failed / windowMinutes) : 0,
        /**
         * Draining, stalled, or idle.
         *
         * "stalled" is the one worth alerting on and is deliberately narrow: a
         * backlog *and* nothing completing. Either alone is normal — a deep
         * queue that is moving will drain, and an idle worker with an empty
         * queue is a Tuesday.
         */
        state:
          depth.waiting + depth.active === 0
            ? ('idle' as const)
            : completed > 0 || depth.active > 0
              ? ('draining' as const)
              : ('stalled' as const),
      };
    });
  }
}
