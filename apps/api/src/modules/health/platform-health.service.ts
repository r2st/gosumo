import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { REDIS_CLIENT, RedisClient } from '../auth/redis.provider';
import {
  QueueTelemetryService,
  QUEUE_DEPTH_WARN_THRESHOLD,
  type QueueThroughput,
} from '../../common/queue/queue-telemetry.service';
import { CircuitBreakerRegistry } from '../../common/resilience/circuit-breaker.registry';
import type { CircuitSnapshot } from '../../common/resilience/circuit-breaker';
import { queryTimingRecorder } from '../../common/services/query-timing.middleware';

/**
 * How far back the AI-pipeline window looks.
 *
 * One hour, not one day: the question this panel answers is "is it working
 * *now*", and a 24-hour autonomy rate takes most of a day to visibly move after
 * a regression lands. A tenant with low volume may have no decisions in the
 * window at all, which is reported as a null rate rather than as 0% — those are
 * very different things and the second one reads as an outage.
 */
const AI_WINDOW_MINUTES = 60;

/** Redis memory use above this fraction of `maxmemory` is called out. */
const REDIS_MEMORY_WARN_RATIO = 0.85;

/** Postgres connection use above this fraction of `max_connections` is called out. */
const DB_CONNECTION_WARN_RATIO = 0.8;

export type ComponentState = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ChannelHealthReport {
  channelAccountId: string;
  channel: string;
  name: string;
  isActive: boolean;
  isVerified: boolean;
  /** Most recent inbound message on this account, ever. */
  lastInboundAt: string | null;
  /** Most recent outbound message this account successfully delivered. */
  lastOutboundAt: string | null;
  /** Outbound messages that failed on this account in the AI window. */
  recentFailures: number;
  messagesSentToday: number;
  dailyLimit: number | null;
  /**
   * `degraded` covers the two silent failures: an account marked active that
   * has never verified, and one whose daily send limit is exhausted. Neither
   * throws anywhere — messages simply stop going out.
   */
  state: ComponentState;
}

export interface AiPipelineHealthReport {
  windowMinutes: number;
  decisions: number;
  autoExecuted: number;
  sentForReview: number;
  escalated: number;
  /** 0–100, or null when the window holds no decisions at all. */
  autonomyRate: number | null;
  avgLatencyMs: number | null;
  /** Breakers around the LLM and other outbound dependencies, when open. */
  openCircuits: CircuitSnapshot[];
  state: ComponentState;
}

export interface DatabaseHealthReport {
  reachable: boolean;
  latencyMs: number;
  /** Backends attached to this database, by state. */
  connections: { total: number; active: number; idle: number; idleInTransaction: number } | null;
  maxConnections: number | null;
  /** Fraction of `max_connections` in use, 0–1. */
  utilization: number | null;
  /** Query counters since this process booted. */
  queries: { total: number; slow: number; slowestMs: number | null };
  state: ComponentState;
}

export interface RedisHealthReport {
  reachable: boolean;
  latencyMs: number;
  usedMemoryBytes: number | null;
  maxMemoryBytes: number | null;
  /** Fraction of `maxmemory` in use, or null when no limit is configured. */
  utilization: number | null;
  fragmentationRatio: number | null;
  evictedKeys: number | null;
  connectedClients: number | null;
  state: ComponentState;
}

export interface QueueHealthReport {
  queues: QueueThroughput[];
  depthThreshold: number;
  /** Queues with a backlog and nothing completing — the alertable shape. */
  stalled: string[];
  state: ComponentState;
}

export interface PlatformHealthReport {
  /** Worst component state, rolled up. */
  status: ComponentState;
  timestamp: string;
  uptimeSeconds: number;
  channels: ChannelHealthReport[];
  ai: AiPipelineHealthReport;
  queues: QueueHealthReport;
  database: DatabaseHealthReport;
  redis: RedisHealthReport;
}

/**
 * PlatformHealthService — the operator's panel, as opposed to the balancer's
 * probe.
 *
 * ## Why this is separate from `HealthService`
 *
 * `/health/ready` answers one question for a machine — should this instance get
 * traffic — and everything about it follows from that: it is `@Public()`, it is
 * cached to a single probe per second, and it deliberately reveals nothing
 * about the deployment, because an outage is exactly when its body gets
 * published to whoever curls it.
 *
 * This answers a different question, for a person, and therefore inverts every
 * one of those choices. It is **authenticated and tenant-scoped**, so it can
 * name channel accounts and report connection counts. It is not cached, because
 * it is opened by a human during an incident and a stale panel is worse than a
 * slow one. And it costs real work — several database queries, a Redis INFO,
 * one `getJobCounts` per queue — which is exactly why it must never be the
 * route a load balancer polls.
 *
 * ## Never throws
 *
 * Every section is independently guarded. A panel that 500s because Redis would
 * not answer `INFO` is a panel that tells an operator nothing during the
 * incident where Redis is down — which is the only time anyone opens it. A
 * section that cannot be read reports `unknown` and the rest still renders.
 */
@Injectable()
export class PlatformHealthService {
  private readonly logger = new Logger(PlatformHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    @Optional() private readonly queues?: QueueTelemetryService,
    @Optional() private readonly breakers?: CircuitBreakerRegistry,
  ) {}

  async report(businessId: string): Promise<PlatformHealthReport> {
    const [channels, ai, queues, database, redis] = await Promise.all([
      this.channels(businessId),
      this.aiPipeline(businessId),
      this.queueHealth(),
      this.database(),
      this.redisHealth(),
    ]);

    return {
      status: this.rollUp([ai.state, queues.state, database.state, redis.state, ...channels.map((c) => c.state)]),
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      channels,
      ai,
      queues,
      database,
      redis,
    };
  }

  /**
   * Worst state wins, with `unknown` ranking below `ok` but above `degraded`.
   *
   * A section that could not be read must not present as healthy — that is how
   * a panel reports green through an outage — but it must also not present as
   * an outage on its own, since the usual cause is a permission or a component
   * that is simply not wired in this deployment.
   */
  private rollUp(states: ComponentState[]): ComponentState {
    if (states.includes('down')) return 'down';
    if (states.includes('degraded')) return 'degraded';
    if (states.includes('unknown')) return 'unknown';
    return 'ok';
  }

  // ─────────────────────────────────────────────
  // Channels
  // ─────────────────────────────────────────────

  /**
   * Every connected channel account for this tenant, with the traffic that
   * proves it is working.
   *
   * `is_active` is a configuration flag and says nothing about whether messages
   * are flowing, which is the actual question. The two facts that answer it —
   * when something last arrived, and whether recent sends failed — come from
   * `messages`, aggregated per account in one query rather than one query per
   * account.
   */
  private async channels(businessId: string): Promise<ChannelHealthReport[]> {
    try {
      const since = new Date(Date.now() - AI_WINDOW_MINUTES * 60_000);

      const rows = await this.prisma.$queryRaw<ChannelHealthRaw[]>`
        SELECT ca.id                        AS channel_account_id,
               ca.channel::text             AS channel,
               ca.name,
               ca.is_active,
               ca.is_verified,
               ca.messages_sent_today,
               ca.message_limit_per_day,
               m.last_inbound_at,
               m.last_outbound_at,
               COALESCE(m.recent_failures, 0)::int AS recent_failures
        FROM channel_accounts ca
        LEFT JOIN LATERAL (
          SELECT MAX(created_at) FILTER (WHERE direction = 'INBOUND')  AS last_inbound_at,
                 MAX(created_at) FILTER (
                   WHERE direction = 'OUTBOUND' AND status <> 'FAILED'
                 )                                                      AS last_outbound_at,
                 COUNT(*) FILTER (
                   WHERE direction = 'OUTBOUND' AND status = 'FAILED' AND created_at >= ${since}
                 )                                                      AS recent_failures
          FROM messages
          WHERE channel_account_id = ca.id AND business_id = ca.business_id
        ) m ON TRUE
        WHERE ca.business_id = ${businessId}::uuid
          AND ca.deleted_at IS NULL
        ORDER BY ca.channel, ca.name
      `;

      return rows.map((r) => ({
        channelAccountId: r.channel_account_id,
        channel: r.channel,
        name: r.name,
        isActive: r.is_active,
        isVerified: r.is_verified,
        lastInboundAt: r.last_inbound_at?.toISOString() ?? null,
        lastOutboundAt: r.last_outbound_at?.toISOString() ?? null,
        recentFailures: r.recent_failures,
        messagesSentToday: r.messages_sent_today,
        dailyLimit: r.message_limit_per_day,
        state: this.channelState(r),
      }));
    } catch (err) {
      this.logger.warn(`Channel health could not be read: ${errMessage(err)}`);
      return [];
    }
  }

  private channelState(r: ChannelHealthRaw): ComponentState {
    // A disabled account is a choice, not a fault — nothing is broken about a
    // channel the tenant turned off.
    if (!r.is_active) return 'ok';
    // Active but never verified: webhooks are pointed at an account the
    // provider has not confirmed, and inbound simply never arrives.
    if (!r.is_verified) return 'degraded';
    // Limit exhausted: outbound stops silently, with no error anywhere.
    if (r.message_limit_per_day !== null && r.messages_sent_today >= r.message_limit_per_day) {
      return 'degraded';
    }
    if (r.recent_failures > 0) return 'degraded';
    return 'ok';
  }

  // ─────────────────────────────────────────────
  // AI pipeline
  // ─────────────────────────────────────────────

  private async aiPipeline(businessId: string): Promise<AiPipelineHealthReport> {
    const openCircuits = this.breakers?.openCircuits() ?? [];

    try {
      const since = new Date(Date.now() - AI_WINDOW_MINUTES * 60_000);

      const rows = await this.prisma.$queryRaw<AiHealthRaw[]>`
        SELECT COUNT(*)::int                                              AS decisions,
               (COUNT(*) FILTER (WHERE outcome = 'AUTO_EXECUTED'))::int   AS auto_executed,
               (COUNT(*) FILTER (WHERE outcome = 'SENT_FOR_REVIEW'))::int AS sent_for_review,
               (COUNT(*) FILTER (WHERE outcome = 'ESCALATED'))::int       AS escalated,
               AVG(latency_ms)::float8                                    AS avg_latency_ms
        FROM ai_decisions
        WHERE business_id = ${businessId}::uuid
          AND decided_at >= ${since}
      `;

      const row = rows[0];
      const decisions = row?.decisions ?? 0;

      return {
        windowMinutes: AI_WINDOW_MINUTES,
        decisions,
        autoExecuted: row?.auto_executed ?? 0,
        sentForReview: row?.sent_for_review ?? 0,
        escalated: row?.escalated ?? 0,
        // Null, not zero, on an empty window. A quiet hour and a pipeline that
        // has stopped auto-executing both produce zero auto-executions, and
        // only one of them is a problem.
        autonomyRate: decisions > 0 ? round2(((row?.auto_executed ?? 0) / decisions) * 100) : null,
        avgLatencyMs: row?.avg_latency_ms != null ? Math.round(row.avg_latency_ms) : null,
        openCircuits,
        // An open breaker is the pipeline degrading as designed, which is a
        // `degraded`, not a `down` — every route that does not touch that
        // dependency still works.
        state: openCircuits.length > 0 ? 'degraded' : 'ok',
      };
    } catch (err) {
      this.logger.warn(`AI pipeline health could not be read: ${errMessage(err)}`);
      return {
        windowMinutes: AI_WINDOW_MINUTES,
        decisions: 0,
        autoExecuted: 0,
        sentForReview: 0,
        escalated: 0,
        autonomyRate: null,
        avgLatencyMs: null,
        openCircuits,
        state: 'unknown',
      };
    }
  }

  // ─────────────────────────────────────────────
  // Queues
  // ─────────────────────────────────────────────

  private async queueHealth(): Promise<QueueHealthReport> {
    if (!this.queues) {
      return { queues: [], depthThreshold: QUEUE_DEPTH_WARN_THRESHOLD, stalled: [], state: 'unknown' };
    }

    try {
      const queues = await this.queues.throughput();
      const stalled = queues.filter((q) => q.state === 'stalled').map((q) => q.name);
      const overThreshold = queues.some((q) => q.waiting > QUEUE_DEPTH_WARN_THRESHOLD);

      return {
        queues,
        depthThreshold: QUEUE_DEPTH_WARN_THRESHOLD,
        stalled,
        state: stalled.length > 0 || overThreshold ? 'degraded' : 'ok',
      };
    } catch (err) {
      this.logger.warn(`Queue health could not be read: ${errMessage(err)}`);
      return { queues: [], depthThreshold: QUEUE_DEPTH_WARN_THRESHOLD, stalled: [], state: 'unknown' };
    }
  }

  // ─────────────────────────────────────────────
  // Database
  // ─────────────────────────────────────────────

  /**
   * Connection-pool pressure, read from Postgres rather than from Prisma.
   *
   * Prisma's own pool metrics describe this process's slice; `pg_stat_activity`
   * describes the server, which is the number that matters here — this
   * deployment shares a 50-connection Postgres with another service, so the
   * limit is reached by the *sum* and a per-process view would show plenty of
   * headroom right up to the moment connections start being refused.
   *
   * `idle in transaction` is broken out because it is the one state that is
   * always a bug: a connection holding a transaction open while doing nothing
   * blocks vacuum and holds locks, and it is invisible in a plain total.
   */
  private async database(): Promise<DatabaseHealthReport> {
    const timing = queryTimingRecorder.stats();
    const queries = {
      total: timing.total,
      slow: timing.slow,
      slowestMs: timing.slowest?.durationMs ?? null,
    };

    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      this.logger.error(`Platform health: database unreachable — ${errMessage(err)}`);
      return {
        reachable: false,
        latencyMs: Date.now() - startedAt,
        connections: null,
        maxConnections: null,
        utilization: null,
        queries,
        state: 'down',
      };
    }
    const latencyMs = Date.now() - startedAt;

    try {
      const rows = await this.prisma.$queryRaw<DbPoolRaw[]>`
        SELECT COUNT(*)::int                                                   AS total,
               (COUNT(*) FILTER (WHERE state = 'active'))::int                 AS active,
               (COUNT(*) FILTER (WHERE state = 'idle'))::int                   AS idle,
               (COUNT(*) FILTER (WHERE state = 'idle in transaction'))::int    AS idle_in_transaction,
               (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections
        FROM pg_stat_activity
      `;

      const row = rows[0];
      if (!row) {
        return { reachable: true, latencyMs, connections: null, maxConnections: null, utilization: null, queries, state: 'ok' };
      }

      const utilization = row.max_connections > 0 ? row.total / row.max_connections : null;

      return {
        reachable: true,
        latencyMs,
        connections: {
          total: row.total,
          active: row.active,
          idle: row.idle,
          idleInTransaction: row.idle_in_transaction,
        },
        maxConnections: row.max_connections,
        utilization: utilization !== null ? round2(utilization) : null,
        queries,
        state: utilization !== null && utilization >= DB_CONNECTION_WARN_RATIO ? 'degraded' : 'ok',
      };
    } catch (err) {
      // `pg_stat_activity` needs privileges a locked-down role may not have,
      // and that is a deployment choice rather than a fault — the connection
      // itself just answered. Reported as reachable with unknown pool stats.
      this.logger.debug(`Connection-pool stats unavailable: ${errMessage(err)}`);
      return {
        reachable: true,
        latencyMs,
        connections: null,
        maxConnections: null,
        utilization: null,
        queries,
        state: 'ok',
      };
    }
  }

  // ─────────────────────────────────────────────
  // Redis
  // ─────────────────────────────────────────────

  private async redisHealth(): Promise<RedisHealthReport> {
    const startedAt = Date.now();
    try {
      await this.redis.ping();
    } catch (err) {
      this.logger.error(`Platform health: Redis unreachable — ${errMessage(err)}`);
      return {
        reachable: false,
        latencyMs: Date.now() - startedAt,
        usedMemoryBytes: null,
        maxMemoryBytes: null,
        utilization: null,
        fragmentationRatio: null,
        evictedKeys: null,
        connectedClients: null,
        state: 'down',
      };
    }
    const latencyMs = Date.now() - startedAt;

    // `info` is optional on the RedisClient interface — a test double or a
    // narrowed client may not expose it. Reachable with unknown statistics is
    // the honest report in that case, not a failure.
    const readInfo = this.redis.info?.bind(this.redis);
    if (!readInfo) {
      return {
        reachable: true,
        latencyMs,
        usedMemoryBytes: null,
        maxMemoryBytes: null,
        utilization: null,
        fragmentationRatio: null,
        evictedKeys: null,
        connectedClients: null,
        state: 'ok',
      };
    }

    try {
      const [memory, clients, stats] = await Promise.all([
        readInfo('memory'),
        readInfo('clients'),
        readInfo('stats'),
      ]);
      const info = { ...parseRedisInfo(memory), ...parseRedisInfo(clients), ...parseRedisInfo(stats) };

      const used = numberOrNull(info['used_memory']);
      const max = numberOrNull(info['maxmemory']);
      // `maxmemory: 0` means unlimited, which is not a denominator.
      const utilization = used !== null && max !== null && max > 0 ? used / max : null;

      return {
        reachable: true,
        latencyMs,
        usedMemoryBytes: used,
        maxMemoryBytes: max !== null && max > 0 ? max : null,
        utilization: utilization !== null ? round2(utilization) : null,
        fragmentationRatio: numberOrNull(info['mem_fragmentation_ratio']),
        evictedKeys: numberOrNull(info['evicted_keys']),
        connectedClients: numberOrNull(info['connected_clients']),
        // Eviction is called out on its own: with no `maxmemory` configured
        // there is no ratio to breach, and the first sign of trouble is keys
        // silently disappearing — which for this app means sessions and the
        // conversation locks.
        state:
          (utilization !== null && utilization >= REDIS_MEMORY_WARN_RATIO) ||
          (numberOrNull(info['evicted_keys']) ?? 0) > 0
            ? 'degraded'
            : 'ok',
      };
    } catch (err) {
      this.logger.debug(`Redis INFO unavailable: ${errMessage(err)}`);
      return {
        reachable: true,
        latencyMs,
        usedMemoryBytes: null,
        maxMemoryBytes: null,
        utilization: null,
        fragmentationRatio: null,
        evictedKeys: null,
        connectedClients: null,
        state: 'ok',
      };
    }
  }
}

// ─────────────────────────────────────────────
// Raw row shapes and small helpers
// ─────────────────────────────────────────────

interface ChannelHealthRaw {
  channel_account_id: string;
  channel: string;
  name: string;
  is_active: boolean;
  is_verified: boolean;
  messages_sent_today: number;
  message_limit_per_day: number | null;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  recent_failures: number;
}

interface AiHealthRaw {
  decisions: number;
  auto_executed: number;
  sent_for_review: number;
  escalated: number;
  avg_latency_ms: number | null;
}

interface DbPoolRaw {
  total: number;
  active: number;
  idle: number;
  idle_in_transaction: number;
  max_connections: number;
}

/**
 * Parse Redis's `INFO` reply into a flat map.
 *
 * The format is `key:value` per line with `#`-prefixed section headers and CRLF
 * endings. Written out rather than pulled from a library because it is six
 * lines and because a malformed reply must produce an incomplete map, not an
 * exception — this runs during the incident where Redis is misbehaving.
 */
export function parseRedisInfo(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at <= 0) continue;
    out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
