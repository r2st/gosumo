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

function makeService(overrides: {
  query?: jest.Mock;
  ping?: jest.Mock;
} = {}) {
  const query = overrides.query ?? jest.fn().mockResolvedValue([{ '?column?': 1 }]);
  const ping = overrides.ping ?? jest.fn().mockResolvedValue('PONG');
  const prisma = { $queryRaw: query } as unknown as PrismaService;
  const redis = { ping } as unknown as RedisClient;
  return { service: new HealthService(prisma, redis), query, ping };
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
      error: 'connection refused',
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
    expect(report.dependencies.redis).toMatchObject({ status: 'down', error: 'READONLY' });
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

  it('describes a non-Error rejection rather than reporting "undefined"', async () => {
    const { service } = makeService({ ping: jest.fn().mockRejectedValue('ECONNRESET') });

    const report = await service.readiness();

    expect(report.dependencies.redis.error).toBe('ECONNRESET');
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
      expect(report.dependencies.redis.error).toMatch(/timed out/);
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
