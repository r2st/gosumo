/**
 * RealtyHealthService unit tests — Phase 7 soak-readiness gate.
 *
 * Covers: all-pass, DLQ backlog warn/fail thresholds, DB-probe failure → fail,
 * and worst-of aggregation.
 */

import { RealtyHealthService } from './realty-health.service';
import { DLQ_DEPTH_FAIL, DLQ_DEPTH_WARN } from './realty-hardening.constants';

describe('RealtyHealthService', () => {
  let prisma: { $queryRaw: jest.Mock };
  let dlqRepo: { countPendingGlobal: jest.Mock };
  let rateLimiter: { activeWindows: jest.Mock };
  let service: RealtyHealthService;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    dlqRepo = { countPendingGlobal: jest.fn().mockResolvedValue(0) };
    rateLimiter = { activeWindows: jest.fn().mockReturnValue(3) };
    service = new RealtyHealthService(prisma as never, dlqRepo as never, rateLimiter as never);
  });

  it('passes when DB is reachable and the DLQ is drained', async () => {
    const res = await service.readiness('2026-07-03T00:00:00.000Z');
    expect(res.status).toBe('pass');
    expect(res.checkedAt).toBe('2026-07-03T00:00:00.000Z');
    expect(res.checks.map((c) => c.name)).toEqual([
      'database',
      'dead_letter_backlog',
      'rate_limiter',
    ]);
  });

  it('warns when the DLQ backlog crosses the warn threshold', async () => {
    dlqRepo.countPendingGlobal.mockResolvedValue(DLQ_DEPTH_WARN);
    const res = await service.readiness();
    expect(res.status).toBe('warn');
    expect(res.checks.find((c) => c.name === 'dead_letter_backlog')?.status).toBe('warn');
  });

  it('fails when the DLQ backlog crosses the fail threshold', async () => {
    dlqRepo.countPendingGlobal.mockResolvedValue(DLQ_DEPTH_FAIL);
    const res = await service.readiness();
    expect(res.status).toBe('fail');
  });

  it('fails (does not throw) when the DB probe errors', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));
    const res = await service.readiness();
    expect(res.status).toBe('fail');
    expect(res.checks.find((c) => c.name === 'database')?.status).toBe('fail');
  });

  it('degrades to fail if the DLQ probe itself throws', async () => {
    dlqRepo.countPendingGlobal.mockRejectedValue(new Error('db down'));
    const res = await service.readiness();
    expect(res.status).toBe('fail');
    expect(res.checks.find((c) => c.name === 'dead_letter_backlog')?.status).toBe('fail');
  });
});
