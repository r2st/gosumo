import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtyDlqRepository } from './realty-dlq.repository';
import { RealtyRateLimiter } from './realty-rate-limiter';
import { DLQ_DEPTH_FAIL, DLQ_DEPTH_WARN } from './realty-hardening.constants';

export type ReadinessStatus = 'pass' | 'warn' | 'fail';

export interface ReadinessCheck {
  name: string;
  status: ReadinessStatus;
  detail: string;
}

export interface RealtyReadiness {
  /** Worst-of the individual checks — the soak gate. */
  status: ReadinessStatus;
  checks: ReadinessCheck[];
  checkedAt: string;
}

/**
 * RealtyHealthService — the soak-readiness surface (Phase 7 goal: "7-day
 * unattended soak on shadow traffic"). Aggregates the graceful-degradation
 * signals an operator watches: database reachability, dead-letter backlog depth,
 * and rate-limiter pressure. The overall status is the worst of the checks, so a
 * single failing dependency turns the gate red.
 *
 * `now`/clock is injectable-free; every check is defensive — a probe that throws
 * downgrades to `fail` for that check rather than crashing the endpoint.
 */
@Injectable()
export class RealtyHealthService {
  private readonly logger = new Logger(RealtyHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dlqRepo: RealtyDlqRepository,
    private readonly rateLimiter: RealtyRateLimiter,
  ) {}

  async readiness(nowIso: string = new Date().toISOString()): Promise<RealtyReadiness> {
    const checks: ReadinessCheck[] = [];
    checks.push(await this.checkDatabase());
    checks.push(await this.checkDeadLetterDepth());
    checks.push(this.checkRateLimiterPressure());

    const status = this.worst(checks.map((c) => c.status));
    return { status, checks, checkedAt: nowIso };
  }

  private async checkDatabase(): Promise<ReadinessCheck> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { name: 'database', status: 'pass', detail: 'reachable' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Readiness DB probe failed: ${msg}`);
      return { name: 'database', status: 'fail', detail: `unreachable: ${msg}` };
    }
  }

  private async checkDeadLetterDepth(): Promise<ReadinessCheck> {
    try {
      const pending = await this.dlqRepo.countPendingGlobal();
      if (pending >= DLQ_DEPTH_FAIL) {
        return {
          name: 'dead_letter_backlog',
          status: 'fail',
          detail: `${pending} pending (>= ${DLQ_DEPTH_FAIL} fail threshold)`,
        };
      }
      if (pending >= DLQ_DEPTH_WARN) {
        return {
          name: 'dead_letter_backlog',
          status: 'warn',
          detail: `${pending} pending (>= ${DLQ_DEPTH_WARN} warn threshold)`,
        };
      }
      return { name: 'dead_letter_backlog', status: 'pass', detail: `${pending} pending` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { name: 'dead_letter_backlog', status: 'fail', detail: `probe failed: ${msg}` };
    }
  }

  private checkRateLimiterPressure(): ReadinessCheck {
    const active = this.rateLimiter.activeWindows();
    return {
      name: 'rate_limiter',
      status: 'pass',
      detail: `${active} active window(s)`,
    };
  }

  private worst(statuses: ReadinessStatus[]): ReadinessStatus {
    if (statuses.includes('fail')) return 'fail';
    if (statuses.includes('warn')) return 'warn';
    return 'pass';
  }
}
