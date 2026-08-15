/**
 * `GET /v1/health/ready` is `@Public()`, so whatever it returns is public.
 *
 * The probes it runs are the two clients whose failure text describes the
 * deployment: Prisma names the host, port, database and schema it could not
 * reach, and ioredis names the address it could not connect to. Returning those
 * verbatim published the internal topology to anonymous callers, and did it
 * precisely during an outage — the moment nobody is watching the endpoint's
 * response body.
 *
 * What survives is the distinction an operator actually reads off a readiness
 * check: which dependency broke, and whether it hung or refused.
 */
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import type { RedisClient } from '../auth/redis.provider';
import { HealthService } from './health.service';

/** The real shape of a Prisma connection failure — host, port, database. */
const PRISMA_MESSAGE =
  "Can't reach database server at `127.0.0.1`:`5433`\n\nPlease make sure your " +
  'database server is running at `127.0.0.1`:`5433`.';

/** The real shape of an ioredis connection failure. */
const IOREDIS_MESSAGE = 'connect ECONNREFUSED 10.0.0.7:6379';

function makeService(overrides: { query?: jest.Mock; ping?: jest.Mock } = {}) {
  const query = overrides.query ?? jest.fn().mockResolvedValue([{ '?column?': 1 }]);
  const ping = overrides.ping ?? jest.fn().mockResolvedValue('PONG');
  return new HealthService(
    { $queryRaw: query } as unknown as PrismaService,
    { ping } as unknown as RedisClient,
  );
}

/** Everything a caller receives, as they receive it. */
const wire = (report: unknown): string => JSON.stringify(report);

describe('readiness never publishes what the dependency said', () => {
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the database host and port out of the response', async () => {
    const service = makeService({ query: jest.fn().mockRejectedValue(new Error(PRISMA_MESSAGE)) });

    const body = wire(await service.readiness());

    expect(body).not.toContain('127.0.0.1');
    expect(body).not.toContain('5433');
    expect(body).not.toContain("Can't reach database server");
  });

  it('keeps the Redis address out of the response', async () => {
    const service = makeService({ ping: jest.fn().mockRejectedValue(new Error(IOREDIS_MESSAGE)) });

    const body = wire(await service.readiness());

    expect(body).not.toContain('10.0.0.7');
    expect(body).not.toContain('6379');
    expect(body).not.toContain('ECONNREFUSED');
  });

  it('keeps an internal hostname out of the response', async () => {
    // The DNS-failure shape, which names the private hostname rather than an IP.
    const service = makeService({
      ping: jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND redis.gosumo.internal')),
    });

    const body = wire(await service.readiness());

    expect(body).not.toContain('redis.gosumo.internal');
  });

  it('still says which dependency is down, and that it refused', async () => {
    // The mitigation must not cost the endpoint its job.
    const service = makeService({ query: jest.fn().mockRejectedValue(new Error(PRISMA_MESSAGE)) });

    const report = await service.readiness();

    expect(report.status).toBe('degraded');
    expect(report.dependencies.database).toMatchObject({ status: 'down', error: 'unreachable' });
    expect(report.dependencies.redis.status).toBe('up');
  });

  it('distinguishes a hang from a refusal', async () => {
    jest.useFakeTimers();
    try {
      const service = makeService({ ping: jest.fn(() => new Promise<string>(() => {})) });

      const pending = service.readiness();
      await jest.advanceTimersByTimeAsync(2_500);
      const report = await pending;

      expect(report.dependencies.redis.error).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  it('confines the error field to the fixed vocabulary', async () => {
    // Anything outside this set is, by construction, text that came from a
    // driver — which is how the leak got there the first time.
    const service = makeService({
      query: jest.fn().mockRejectedValue(new Error(PRISMA_MESSAGE)),
      ping: jest.fn().mockRejectedValue(IOREDIS_MESSAGE),
    });

    const report = await service.readiness();

    for (const dep of [report.dependencies.database, report.dependencies.redis]) {
      expect(['timeout', 'unreachable']).toContain(dep.error);
    }
  });

  it('logs the detail it refuses to return', async () => {
    // Redacting is only acceptable because the operator still gets the whole
    // message on the side of the wire already trusted with it.
    const service = makeService({ query: jest.fn().mockRejectedValue(new Error(PRISMA_MESSAGE)) });

    await service.readiness();

    const logged = errorLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('database');
    expect(logged).toContain("Can't reach database server");
  });

  it('says nothing at all about a healthy dependency', async () => {
    const service = makeService();

    const report = await service.readiness();

    expect(report.dependencies.database.error).toBeUndefined();
    expect(report.dependencies.redis.error).toBeUndefined();
  });
});
