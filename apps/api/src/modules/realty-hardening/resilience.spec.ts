/**
 * Chaos / resilience drills — Phase 7 exit test ("graceful degradation").
 *
 * These simulate the dependency failures a 7-day unattended soak will hit and
 * assert the realty surface degrades — never crashes:
 *
 *  1. Audit DB down     → the audited operation still succeeds (best-effort).
 *  2. Worker job fails  → the reminder is dead-lettered + swallowed; the worker
 *                         is not wedged, and an operator can replay it later.
 *  3. DLQ store down    → even capture failing does not surface to the caller.
 *  4. Runaway AI loop   → the rate limiter blocks the flood.
 *  5. DB unreachable    → readiness reports `fail` without throwing.
 *  6. Bad BLTC data     → contradiction check catches it before it drives a match.
 */

import { DeadLetterStatus } from '@prisma/client';
import { AuditAction } from '@gosumo/database';
import { RealtyOperationsAuditService } from './realty-operations-audit.service';
import { RealtyDlqService } from './realty-dlq.service';
import { RealtyRateLimiter } from './realty-rate-limiter';
import { RealtyHealthService } from './realty-health.service';
import { validateBltcProfile } from './bltc-contradiction.util';
import { RealtyVisitsProcessor } from '../realty-sitevisits/realty-sitevisits.processor';

const BIZ = '00000000-0000-4000-a000-000000000001';
const noSleep = () => Promise.resolve();

describe('Phase 7 resilience drills', () => {
  it('drill 1: an audit-log DB failure never breaks the audited operation', async () => {
    const audit = new RealtyOperationsAuditService({
      audit_logs: { create: jest.fn().mockRejectedValue(new Error('audit db down')) },
    } as never);

    // Simulate a service that records an audit then returns its result.
    const businessOp = async () => {
      await audit.record({
        businessId: BIZ,
        actorType: 'AI',
        action: AuditAction.CREATE,
        resourceType: 'realty_lead',
      });
      return 'operation-result';
    };

    await expect(businessOp()).resolves.toBe('operation-result');
  });

  it('drill 2: a failing site-visit reminder is dead-lettered, swallowed, and replayable', async () => {
    const dlqRow = {
      id: 'dl-1',
      business_id: BIZ,
      operation: 'realty.visit.reminder',
      payload: { visitId: 'v1', minutesBefore: 120 },
      attempts: 3,
      status: DeadLetterStatus.PENDING,
    };
    const repo = {
      create: jest.fn().mockResolvedValue(dlqRow),
      findById: jest.fn().mockResolvedValue(dlqRow),
      update: jest.fn().mockImplementation((_b, _id, data) => ({ ...dlqRow, ...data })),
      claimForReplay: jest.fn().mockResolvedValue(true),
    };
    const dlq = new RealtyDlqService(repo as never, { emit: jest.fn() } as never);

    const fireReminder = jest
      .fn()
      .mockRejectedValueOnce(new Error('whatsapp 500'))
      .mockRejectedValueOnce(new Error('whatsapp 500'))
      .mockRejectedValueOnce(new Error('whatsapp 500'))
      .mockResolvedValue(undefined); // succeeds on replay
    const visitsService = { fireReminder } as never;
    const processor = new RealtyVisitsProcessor(visitsService, dlq);
    processor.onModuleInit(); // registers the replayer

    // The worker must NOT throw even though every attempt fails.
    await expect(
      processor.handleReminder({ data: { businessId: BIZ, visitId: 'v1', minutesBefore: 120 } } as never),
    ).resolves.toBeUndefined();
    expect(repo.create).toHaveBeenCalledTimes(1); // captured to the DLQ

    // An operator replays it; the underlying reminder now succeeds.
    const replayed = await dlq.replay(BIZ, 'dl-1');
    expect(replayed.status).toBe(DeadLetterStatus.REPLAYED);
    expect(fireReminder).toHaveBeenCalledTimes(4);
  });

  it('drill 3: even a DLQ persistence failure does not surface to the caller (swallow)', async () => {
    const repo = { create: jest.fn().mockRejectedValue(new Error('dlq db down')) };
    const dlq = new RealtyDlqService(repo as never, { emit: jest.fn() } as never);
    const res = await dlq.runWithRetry(
      BIZ,
      { source: 'realty-cadence', operation: 'cadence.step.send', payload: {} },
      jest.fn().mockRejectedValue(new Error('permanent')),
      { sleepFn: noSleep, policy: { attempts: 1 }, swallow: true },
    );
    expect(res).toBeNull();
  });

  it('drill 4: a runaway AI loop is throttled by the rate limiter', () => {
    const limiter = new RealtyRateLimiter();
    const { limit } = limiter.ruleFor('ai-turn');
    let blockedAt = -1;
    for (let i = 0; i < limit + 50; i += 1) {
      const d = limiter.tryConsume(BIZ, 'ai-turn', 1000);
      if (!d.allowed && blockedAt < 0) blockedAt = i;
    }
    expect(blockedAt).toBe(limit); // blocks exactly once the ceiling is hit
  });

  it('drill 5: readiness reports fail (not throw) when the DB is unreachable', async () => {
    const health = new RealtyHealthService(
      { $queryRaw: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as never,
      { countPendingGlobal: jest.fn().mockResolvedValue(0) } as never,
      { activeWindows: jest.fn().mockReturnValue(0) } as never,
    );
    const res = await health.readiness();
    expect(res.status).toBe('fail');
  });

  it('drill 6: contradiction check catches logically-impossible BLTC before matching', () => {
    const res = validateBltcProfile({
      budgetMinPaise: 90e5,
      budgetMaxPaise: 40e5, // floor above ceiling
      localities: [],
      timelineMonths: null,
      config: null,
      purpose: null,
      financing: null,
    });
    expect(res.hasErrors).toBe(true);
    expect(res.contradictions.map((c) => c.code)).toContain('budget_min_gt_max');
  });
});
