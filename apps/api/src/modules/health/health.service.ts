import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { REDIS_CLIENT, RedisClient } from '../auth/redis.provider';

/** How long a dependency probe may hang before it is called a failure. */
const PROBE_TIMEOUT_MS = 2_000;

export type DependencyStatus = 'up' | 'down';

export interface DependencyReport {
  status: DependencyStatus;
  latencyMs: number;
  error?: string;
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

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  /** Cheap liveness signal — deliberately touches no dependency. */
  liveness(): LivenessReport {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness — probes every dependency a request needs, concurrently. */
  async readiness(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([
      this.probe('database', () => this.prisma.$queryRaw`SELECT 1`),
      this.probe('redis', () => this.redis.ping()),
    ]);

    const status =
      database.status === 'up' && redis.status === 'up' ? 'ok' : 'degraded';

    if (status === 'degraded') {
      this.logger.warn(
        `Readiness degraded — database: ${database.status}, redis: ${redis.status}`,
      );
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      dependencies: { database, redis },
    };
  }

  /**
   * Run one dependency probe under a timeout, converting any outcome into a
   * report. Never throws: a readiness endpoint that 500s tells the balancer
   * far less than one that names which dependency is down.
   */
  private async probe(
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<DependencyReport> {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${name} probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
            PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      return { status: 'up', latencyMs: Date.now() - startedAt };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // Without this the losing timer keeps the event loop alive for its full
      // duration on every healthy probe.
      if (timer) clearTimeout(timer);
    }
  }
}
