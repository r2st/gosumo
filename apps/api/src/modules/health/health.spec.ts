/**
 * Health probe tests.
 *
 * The behaviour that matters here is what a load balancer sees: liveness must
 * not depend on anything external, readiness must actually fail (with a 503)
 * when a dependency is down, and neither may hang.
 */
import { HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../common/services/prisma.service';
import type { RedisClient } from '../auth/redis.provider';
import { HealthService } from './health.service';
import { HealthController } from './health.controller';
import type { QueueTelemetryService } from '../../common/queue/queue-telemetry.service';
import type { QdrantClient } from '../ai-engine/rag/qdrant.client';

function makeService(overrides: {
  query?: jest.Mock;
  ping?: jest.Mock;
  depthBreaches?: jest.Mock;
  /**
   * Omitted means no `QdrantClient` in the container at all, which is the
   * shape most of these tests want — and, as it happens, the shape production
   * currently runs in.
   */
  isReachable?: jest.Mock;
} = {}) {
  const query = overrides.query ?? jest.fn().mockResolvedValue([{ '?column?': 1 }]);
  const ping = overrides.ping ?? jest.fn().mockResolvedValue('PONG');
  const prisma = { $queryRaw: query } as unknown as PrismaService;
  const redis = { ping } as unknown as RedisClient;
  const queues = overrides.depthBreaches
    ? ({ depthBreaches: overrides.depthBreaches } as unknown as QueueTelemetryService)
    : undefined;
  const isReachable = overrides.isReachable;
  const qdrant = isReachable
    ? ({ isReachable } as unknown as QdrantClient)
    : undefined;
  return {
    service: new HealthService(prisma, redis, queues, qdrant),
    query,
    ping,
    isReachable,
  };
}

/** Minimal Express response double capturing only the status code. */
function makeResponse(): Response & { statusCode: number } {
  const res = {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number };
}

describe('HealthService — liveness', () => {
  it('reports ok without touching any dependency', () => {
    // A database blip must not make the orchestrator kill and restart the
    // container straight back into the same blip.
    const { service, query, ping } = makeService();

    const report = service.liveness();

    expect(report.status).toBe('ok');
    expect(query).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it('reports a whole-second uptime and an ISO timestamp', () => {
    const { service } = makeService();

    const report = service.liveness();

    expect(Number.isInteger(report.uptimeSeconds)).toBe(true);
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
  });

  it('stays ok even when both dependencies are unreachable', () => {
    const { service } = makeService({
      query: jest.fn().mockRejectedValue(new Error('down')),
      ping: jest.fn().mockRejectedValue(new Error('down')),
    });

    expect(service.liveness().status).toBe('ok');
  });
});

describe('HealthService — readiness', () => {
  it('reports ok with both dependencies up', async () => {
    const { service, query, ping } = makeService();

    const report = await service.readiness();

    expect(report.status).toBe('ok');
    expect(report.dependencies.database.status).toBe('up');
    expect(report.dependencies.redis.status).toBe('up');
    expect(query).toHaveBeenCalled();
    expect(ping).toHaveBeenCalled();
  });

  it('degrades and names the database when Postgres is down', async () => {
    const { service } = makeService({
      query: jest.fn().mockRejectedValue(new Error('connection refused')),
    });

    const report = await service.readiness();

    expect(report.status).toBe('degraded');
    expect(report.dependencies.database).toMatchObject({
      status: 'down',
      error: 'unreachable',
    });
    // The healthy dependency is still reported as healthy — the point of the
    // per-dependency shape is telling an operator *which* one broke.
    expect(report.dependencies.redis.status).toBe('up');
  });

  it('degrades and names Redis when Redis is down', async () => {
    const { service } = makeService({
      ping: jest.fn().mockRejectedValue(new Error('READONLY')),
    });

    const report = await service.readiness();

    expect(report.status).toBe('degraded');
    expect(report.dependencies.redis).toMatchObject({ status: 'down', error: 'unreachable' });
    expect(report.dependencies.database.status).toBe('up');
  });

  it('reports both as down when everything is down', async () => {
    const { service } = makeService({
      query: jest.fn().mockRejectedValue(new Error('pg down')),
      ping: jest.fn().mockRejectedValue(new Error('redis down')),
    });

    const report = await service.readiness();

    expect(report.status).toBe('degraded');
    expect(report.dependencies.database.status).toBe('down');
    expect(report.dependencies.redis.status).toBe('down');
  });

  it('classifies a non-Error rejection rather than reporting "undefined"', async () => {
    const { service } = makeService({ ping: jest.fn().mockRejectedValue('ECONNRESET') });

    const report = await service.readiness();

    expect(report.dependencies.redis.error).toBe('unreachable');
  });

  it('never throws — it reports', async () => {
    // A readiness endpoint that 500s tells the balancer far less than one that
    // answers with which dependency is down.
    const { service } = makeService({
      query: jest.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(service.readiness()).resolves.toBeDefined();
  });

  it('records a latency for every probe', async () => {
    const { service } = makeService();

    const report = await service.readiness();

    expect(report.dependencies.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.dependencies.redis.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('probes both dependencies concurrently, not one after the other', async () => {
    // Serial probes make the timeout budget additive, so a health check on a
    // fully-down stack takes twice as long as it should.
    const order: string[] = [];
    const { service } = makeService({
      query: jest.fn(async () => {
        order.push('db:start');
        await new Promise((r) => setTimeout(r, 10));
        order.push('db:end');
      }),
      ping: jest.fn(async () => {
        order.push('redis:start');
        await new Promise((r) => setTimeout(r, 10));
        order.push('redis:end');
        return 'PONG';
      }),
    });

    await service.readiness();

    expect(order.slice(0, 2)).toEqual(['db:start', 'redis:start']);
  });

  it('gives up on a hanging dependency instead of hanging with it', async () => {
    jest.useFakeTimers();
    try {
      const { service } = makeService({
        // Never settles — an unreachable host usually hangs rather than refusing.
        ping: jest.fn(() => new Promise<string>(() => {})),
      });

      const pending = service.readiness();
      await jest.advanceTimersByTimeAsync(2_500);
      const report = await pending;

      expect(report.status).toBe('degraded');
      expect(report.dependencies.redis.status).toBe('down');
      expect(report.dependencies.redis.error).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves no pending timer behind on a healthy probe', async () => {
    // The losing race timer would otherwise hold the event loop open for its
    // full duration on every single health check.
    jest.useFakeTimers();
    try {
      const { service } = makeService();
      await service.readiness();

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('HealthService — queue backlog', () => {
  const breach = { name: 'notification', waiting: 900, active: 2, delayed: 0, failed: 4, threshold: 500 };

  it('reports a backing-up queue', async () => {
    const { service } = makeService({
      depthBreaches: jest.fn().mockResolvedValue([breach]),
    });

    await expect(service.readiness()).resolves.toMatchObject({
      queueBacklog: [breach],
    });
  });

  it('stays "ok" while a queue is backed up', async () => {
    // A backlog means work is piling up, not that this instance should be
    // pulled from rotation — doing that removes one of the workers draining it.
    const { service } = makeService({
      depthBreaches: jest.fn().mockResolvedValue([breach]),
    });

    await expect(service.readiness()).resolves.toMatchObject({ status: 'ok' });
  });

  it('reports an empty backlog when every queue is healthy', async () => {
    const { service } = makeService({ depthBreaches: jest.fn().mockResolvedValue([]) });

    await expect(service.readiness()).resolves.toMatchObject({ queueBacklog: [] });
  });

  it('still answers when the depth probe itself fails', async () => {
    const { service } = makeService({
      depthBreaches: jest.fn().mockRejectedValue(new Error('redis down')),
    });

    const report = await service.readiness();

    expect(report.queueBacklog).toEqual([]);
    expect(report.dependencies.database.status).toBe('up');
  });

  it('omits nothing when no telemetry service is wired at all', async () => {
    const { service } = makeService();

    await expect(service.readiness()).resolves.toMatchObject({ queueBacklog: [] });
  });
});

describe('HealthController', () => {
  it('returns the liveness report', () => {
    const { service } = makeService();
    const controller = new HealthController(service);

    expect(controller.liveness().status).toBe('ok');
  });

  it('answers 200 when ready', async () => {
    const { service } = makeService();
    const controller = new HealthController(service);
    const res = makeResponse();

    const report = await controller.readiness(res);

    expect(res.statusCode).toBe(HttpStatus.OK);
    expect(report.status).toBe('ok');
  });

  it('answers 503 when degraded so a balancer stops routing here', async () => {
    // The balancer reads the status code, not the body — a degraded instance
    // answering 200 keeps taking traffic it cannot serve.
    const { service } = makeService({
      query: jest.fn().mockRejectedValue(new Error('pg down')),
    });
    const controller = new HealthController(service);
    const res = makeResponse();

    const report = await controller.readiness(res);

    expect(res.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(report.status).toBe('degraded');
    expect(report.dependencies.database.status).toBe('down');
  });
});

/**
 * `GET /health/ready` is `@Public()`, so it is reachable by anyone, and it does
 * real work per call: a Postgres round-trip, a Redis PING, and a queue-depth
 * read. That combination — no authentication, no ceiling, a well-known URL, and
 * a dependency touched on every request — is what turns a health probe into an
 * amplifier against a database this deployment shares with another service.
 *
 * The bound is a cache rather than a rate limit on purpose: a 429 reads to a
 * load balancer as an unhealthy instance and pulls it from rotation, causing
 * the outage the limit was meant to prevent. A cache costs a flood nothing and
 * costs a real probe nothing either.
 */
describe('HealthService — readiness is bounded', () => {
  afterEach(() => jest.restoreAllMocks());

  it('probes the dependencies once for a burst of callers', async () => {
    const { service, query, ping } = makeService();

    await Promise.all(Array.from({ length: 50 }, () => service.readiness()));

    expect(query).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
  });

  /**
   * The single-flight half, isolated. A TTL cache alone does nothing here:
   * with a cold cache and 25 concurrent requests, none of them finds a stored
   * result, so every one starts its own probe — which is precisely the burst
   * worth defending against.
   */
  it('collapses concurrent callers onto one in-flight probe', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = jest.fn().mockImplementation(() => gate.then(() => [{ ok: 1 }]));
    const { service, ping } = makeService({ query });

    const inFlight = Array.from({ length: 25 }, () => service.readiness());
    // Every caller is now waiting on a probe that has not resolved.
    expect(query).toHaveBeenCalledTimes(1);

    release();
    const reports = await Promise.all(inFlight);

    expect(query).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
    // They all get the same answer, not a half-filled one.
    for (const r of reports) expect(r.status).toBe('ok');
  });

  it('serves a second caller from cache without re-probing', async () => {
    const { service, query } = makeService();

    const first = await service.readiness();
    const second = await service.readiness();

    expect(query).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  /**
   * A cache that outlived its window would be worse than none: a balancer would
   * keep being told an instance is healthy after its database went away.
   */
  it('re-probes once the cache window has elapsed', async () => {
    const { service, query } = makeService();
    const realNow = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(realNow);

    await service.readiness();
    expect(query).toHaveBeenCalledTimes(1);

    now.mockReturnValue(realNow + 1_001);
    await service.readiness();

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reflects a dependency that went down after the window', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ ok: 1 }])
      .mockRejectedValue(new Error('pg down'));
    const { service } = makeService({ query });
    const realNow = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(realNow);

    expect((await service.readiness()).status).toBe('ok');

    now.mockReturnValue(realNow + 1_001);

    expect((await service.readiness()).status).toBe('degraded');
  });

  /**
   * A rejected probe must not be cached. `probeReadiness` converts every
   * dependency outcome into a report rather than throwing, so this is about the
   * in-flight promise: holding a rejected one would serve one failed probe to
   * every later caller for the life of the process.
   */
  it('does not pin a failed probe for later callers', async () => {
    const depthBreaches = jest
      .fn()
      .mockRejectedValueOnce(new Error('redis gone'))
      .mockResolvedValue([]);
    const { service } = makeService({ depthBreaches });
    const realNow = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(realNow);

    await expect(service.readiness()).resolves.toMatchObject({ status: 'ok' });

    now.mockReturnValue(realNow + 1_001);

    await expect(service.readiness()).resolves.toMatchObject({ status: 'ok' });
    expect(depthBreaches).toHaveBeenCalledTimes(2);
  });
});

/**
 * The vector store is the one dependency that is probed but deliberately
 * cannot make an instance unready.
 *
 * That is the whole design: the AI pipeline is built to run without Qdrant
 * (answers are produced with no RAG context and the confidence calculator
 * penalizes `dataAvailability`, routing the turn to a human), while every
 * other route in the API never touches it. Since all instances share one
 * vector store, letting it set `status` would 503 every instance at once and
 * convert a supported partial degradation into a total outage.
 *
 * Production currently runs with no Qdrant at all, so these are not
 * hypotheticals — the `down` arms are the live configuration.
 */
describe('HealthService — vector store never gates readiness', () => {
  it('stays ok when the vector store is unreachable', async () => {
    const { service } = makeService({ isReachable: jest.fn().mockResolvedValue(false) });

    const report = await service.readiness();

    expect(report.status).toBe('ok');
    expect(report.dependencies.vector).toMatchObject({ status: 'down' });
  });

  it('stays ok when no vector client is wired at all', async () => {
    // The production shape today. Reporting `up` here would be a lie a
    // dashboard would believe.
    const report = await makeService().service.readiness();

    expect(report.status).toBe('ok');
    expect(report.dependencies.vector.status).toBe('down');
  });

  it('reports the vector store up when it answers', async () => {
    const { service } = makeService({ isReachable: jest.fn().mockResolvedValue(true) });

    const report = await service.readiness();

    expect(report.dependencies.vector).toMatchObject({ status: 'up' });
    expect(report.status).toBe('ok');
  });

  it('still degrades on a real dependency while the vector store is up', async () => {
    // Proves the exemption is scoped to the vector store and has not been
    // widened into "nothing sets status".
    const { service } = makeService({
      ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
      isReachable: jest.fn().mockResolvedValue(true),
    });

    const report = await service.readiness();

    expect(report.status).toBe('degraded');
  });

  it('does not let a hanging vector store hang the probe', async () => {
    // An unreachable dependency usually hangs rather than refusing, and a
    // health check that hangs tells a balancer nothing.
    const { service } = makeService({
      isReachable: jest.fn().mockImplementation(() => new Promise(() => undefined)),
    });

    const report = await service.readiness();

    expect(report.status).toBe('ok');
    expect(report.dependencies.vector).toMatchObject({ status: 'down', error: 'timeout' });
  }, 10_000);

  it('never publishes what the vector store said went wrong', async () => {
    // Same rule as the other probes: the failure text names internal topology
    // (`http://localhost:6333`), and this route is public.
    const { service } = makeService({
      isReachable: jest.fn().mockRejectedValue(
        new Error('fetch failed: connect ECONNREFUSED http://10.0.0.4:6333/collections'),
      ),
    });

    const report = await service.readiness();
    const body = JSON.stringify(report);

    expect(body).not.toContain('6333');
    expect(body).not.toContain('10.0.0.4');
    expect(body).not.toContain('ECONNREFUSED');
    expect(report.dependencies.vector.error).toBe('unreachable');
  });

  it('answers 200 from the controller with the vector store down', async () => {
    // The end-to-end statement of the rule: a balancer keeps routing here.
    const { service } = makeService({ isReachable: jest.fn().mockResolvedValue(false) });
    const res = makeResponse();

    await new HealthController(service).readiness(res);

    expect(res.statusCode).toBe(HttpStatus.OK);
  });
});
