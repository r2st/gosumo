import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { REDIS_CLIENT, RedisClient } from '../auth/redis.provider';
import {
  QueueTelemetryService,
  type QueueDepthBreach,
} from '../../common/queue/queue-telemetry.service';

/** How long a dependency probe may hang before it is called a failure. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * How long a readiness result is reused before the dependencies are probed
 * again.
 *
 * `GET /health/ready` is `@Public()` — a load balancer carries no JWT — and it
 * is the one anonymous route in this API that does real work on every call: a
 * Postgres round-trip, a Redis PING, and a `getJobCounts` per registered queue.
 * Unthrottled, that makes a well-known URL into a dependency amplifier, and
 * this deployment shares a 50-connection Postgres with another service, so
 * saturating it is not a theoretical concern.
 *
 * Caching is the right control here rather than a rate limit. A 429 to a load
 * balancer reads as "this instance is unhealthy" and pulls it out of rotation —
 * a mitigation that causes the outage it was meant to prevent. A cache bounds
 * the work instead: any number of callers per second costs one probe.
 *
 * One second is well under every probe interval a balancer uses (typically 5s
 * or more), so a real health check still gets a fresh answer every time, while
 * a flood collapses onto a single probe.
 */
const READINESS_CACHE_MS = 1_000;

export type DependencyStatus = 'up' | 'down';

/**
 * Why a probe failed, in a fixed vocabulary.
 *
 * Deliberately *not* the driver's own message. This route is `@Public()` and
 * reachable by anyone on the internet, and the two clients probed here are the
 * two whose failure text describes the deployment:
 *
 *   - Prisma: ``Can't reach database server at `127.0.0.1`:`5433` `` — internal
 *     host, port, and (on other codes) the database and schema names.
 *   - ioredis: `connect ECONNREFUSED 127.0.0.1:6379`, or a DNS failure that
 *     names the internal hostname (`getaddrinfo ENOTFOUND redis.internal`).
 *
 * An outage is exactly when that string gets published, so the disclosure fires
 * precisely when the operator is least able to notice it. The distinction a
 * balancer or an on-call dashboard actually reads is "did it hang or did it
 * refuse" — that survives here; the address does not, and the full text goes to
 * the log next to the dependency name.
 */
export type DependencyFailure = 'timeout' | 'unreachable';

export interface DependencyReport {
  status: DependencyStatus;
  latencyMs: number;
  error?: DependencyFailure;
}

export interface LivenessReport {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  timestamp: string;
  dependencies: {
    database: DependencyReport;
    redis: DependencyReport;
  };
  /**
   * Queues whose waiting backlog is over the alert threshold. Empty in normal
   * operation, and reported *without* changing `status`: a backlog means work
   * is piling up, not that this instance should stop being sent traffic —
   * pulling it out of rotation would remove one of the workers draining it.
   */
  queueBacklog?: QueueDepthBreach[];
}

/**
 * HealthService — the probes a load balancer and an uptime monitor read.
 *
 * The split matters operationally:
 *
 *   liveness  — "is this process alive?" Touches nothing external, so a
 *               database blip never gets the container killed and restarted
 *               into the same blip.
 *   readiness — "should traffic be routed here?" Actually probes Postgres and
 *               Redis, because a process that cannot reach either will fail
 *               every request it is handed.
 *
 * Every probe is bounded: an unreachable dependency usually hangs rather than
 * refusing, and a health check that hangs is worse than one that fails — the
 * balancer learns nothing and keeps sending traffic.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  /** Last readiness result, reused until `expiresAt`. */
  private cachedReadiness: { report: ReadinessReport; expiresAt: number } | null = null;

  /** The probe currently running, so concurrent callers share one. */
  private inFlightReadiness: Promise<ReadinessReport> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    /**
     * Optional so a test (or a deployment with no queues registered) can build
     * this service without the whole Bull graph. Absent simply means no
     * backlog is reported.
     */
    @Optional() private readonly queues?: QueueTelemetryService,
  ) {}

  /** Cheap liveness signal — deliberately touches no dependency. */
  liveness(): LivenessReport {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness — probes every dependency a request needs, concurrently.
   *
   * Bounded by {@link READINESS_CACHE_MS} in two ways: a result younger than
   * the window is reused, and callers arriving while a probe is already in
   * flight join that one instead of starting their own. The second half is
   * what a plain TTL cache would miss — a burst against a cold cache would
   * otherwise fire one probe per request, which is the exact case worth
   * defending against.
   */
  async readiness(): Promise<ReadinessReport> {
    const now = Date.now();

    if (this.cachedReadiness && now < this.cachedReadiness.expiresAt) {
      return this.cachedReadiness.report;
    }
    if (this.inFlightReadiness) return this.inFlightReadiness;

    this.inFlightReadiness = this.probeReadiness()
      .then((report) => {
        this.cachedReadiness = { report, expiresAt: Date.now() + READINESS_CACHE_MS };
        return report;
      })
      .finally(() => {
        // Cleared whatever happened: holding a rejected promise here would
        // serve one failed probe to every later caller forever.
        this.inFlightReadiness = null;
      });

    return this.inFlightReadiness;
  }

  /** The actual dependency probes, run concurrently under their own timeouts. */
  private async probeReadiness(): Promise<ReadinessReport> {
    const [database, redis, queueBacklog] = await Promise.all([
      this.probe('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.probe('redis', () => this.redis.ping()),
      this.backlog(),
    ]);

    const status =
      database.status === 'up' && redis.status === 'up' ? 'ok' : 'degraded';

    if (status === 'degraded') {
      this.logger.warn(
        `Readiness degraded — database: ${database.status}, redis: ${redis.status}`,
      );
    }

    if (queueBacklog.length > 0) {
      this.logger.warn(
        `Queue backlog over threshold — ${queueBacklog
          .map((q) => `${q.name}: ${q.waiting} waiting (>${q.threshold})`)
          .join(', ')}`,
      );
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      dependencies: { database, redis },
      queueBacklog,
    };
  }

  /**
   * Queues over the depth threshold, or nothing if the telemetry service is
   * not wired. Never throws — a readiness endpoint that 500s because Redis
   * would not answer a `getJobCounts` tells a balancer strictly less than one
   * that reports the dependency probes it did manage.
   */
  private async backlog(): Promise<QueueDepthBreach[]> {
    if (!this.queues) return [];
    try {
      return await this.queues.depthBreaches();
    } catch (err) {
      this.logger.warn(
        `Queue depth probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Run one dependency probe under a timeout, converting any outcome into a
   * report. Never throws: a readiness endpoint that 500s tells the balancer
   * far less than one that names which dependency is down.
   *
   * The failure is reported as a {@link DependencyFailure} and the driver's own
   * message is logged rather than returned — see that type for why.
   */
  private async probe(
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<DependencyReport> {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    /**
     * Read synchronously in the `catch` below, so it can only be true when the
     * timer is what rejected the race: a `fn` that rejects first gets there
     * while this is still false, and the `finally` then clears the timer.
     */
    let timedOut = false;
    try {
      await Promise.race([
        fn(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`${name} probe timed out after ${PROBE_TIMEOUT_MS}ms`));
          }, PROBE_TIMEOUT_MS);
        }),
      ]);
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (err) {
      // The detail an operator needs, on the side of the wire that is already
      // trusted with it.
      this.logger.error(
        `Readiness probe "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: timedOut ? 'timeout' : 'unreachable',
      };
    } finally {
      // Without this the losing timer keeps the event loop alive for its full
      // duration on every healthy probe.
      if (timer) clearTimeout(timer);
    }
  }
}
