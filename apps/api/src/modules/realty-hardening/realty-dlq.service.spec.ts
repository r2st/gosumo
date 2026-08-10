/**
 * RealtyDlqService unit tests — Phase 7 hardening (retries + dead-letter queue).
 *
 * Repository + EventEmitter2 are mocked; retries use a no-op sleeper so the
 * suite never waits real time. Covers: retry-then-succeed, exhaustion → capture
 * (rethrow vs swallow), capture persistence + event, replay (success / retry /
 * auto-discard / idempotency / missing replayer), resolve, and stats.
 */

import { DeadLetterStatus } from '@prisma/client';
import { RealtyDlqService } from './realty-dlq.service';
import { REALTY_HARDENING_EVENTS } from './realty-hardening.constants';

const BIZ = '00000000-0000-4000-a000-000000000001';
const DL_ID = '00000000-0000-4000-a000-0000000000aa';
const noSleep = () => Promise.resolve();

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: DL_ID,
    business_id: BIZ,
    source: 'realty-sitevisits',
    operation: 'realty.visit.reminder',
    payload: { visitId: 'v1', minutesBefore: 120 },
    error_message: 'boom',
    error_stack: null,
    attempts: 3,
    status: DeadLetterStatus.PENDING,
    resolution: null,
    correlation_id: null,
    lead_id: null,
    conversation_id: null,
    replayed_at: null,
    resolved_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('RealtyDlqService', () => {
  let repo: {
    create: jest.Mock;
    findById: jest.Mock;
    list: jest.Mock;
    countByStatus: jest.Mock;
    countPendingGlobal: jest.Mock;
    update: jest.Mock;
  };
  let emitter: { emit: jest.Mock };
  let service: RealtyDlqService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue(makeEntry()),
      findById: jest.fn().mockResolvedValue(makeEntry()),
      list: jest.fn().mockResolvedValue([]),
      countByStatus: jest.fn().mockResolvedValue(0),
      countPendingGlobal: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockImplementation((_b, _id, data) => makeEntry(data)),
    };
    emitter = { emit: jest.fn() };
    service = new RealtyDlqService(repo as never, emitter as never);
  });

  const meta = {
    source: 'realty-sitevisits',
    operation: 'realty.visit.reminder',
    payload: { visitId: 'v1', minutesBefore: 120 },
  };

  describe('runWithRetry', () => {
    it('returns the value without capturing on first-try success', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const res = await service.runWithRetry(BIZ, meta, fn, { sleepFn: noSleep });
      expect(res).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('retries transient failures then succeeds', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('flaky'))
        .mockRejectedValueOnce(new Error('flaky'))
        .mockResolvedValue('recovered');
      const res = await service.runWithRetry(BIZ, meta, fn, {
        sleepFn: noSleep,
        policy: { attempts: 3 },
      });
      expect(res).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(3);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('captures and rethrows after exhausting retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('permanent'));
      await expect(
        service.runWithRetry(BIZ, meta, fn, { sleepFn: noSleep, policy: { attempts: 2 } }),
      ).rejects.toThrow('permanent');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.create.mock.calls[0][0]).toMatchObject({
        businessId: BIZ,
        operation: 'realty.visit.reminder',
        attempts: 2,
        errorMessage: 'permanent',
      });
    });

    it('captures and swallows (returns null) when swallow is set', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('permanent'));
      const res = await service.runWithRetry(BIZ, meta, fn, {
        sleepFn: noSleep,
        policy: { attempts: 1 },
        swallow: true,
      });
      expect(res).toBeNull();
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        REALTY_HARDENING_EVENTS.DEAD_LETTER_CAPTURED,
        expect.objectContaining({ businessId: BIZ }),
      );
    });
  });

  describe('capture', () => {
    it('never throws even if persistence fails', async () => {
      repo.create.mockRejectedValueOnce(new Error('db down'));
      const res = await service.capture(BIZ, meta, new Error('x'), 3);
      expect(res).toBeNull();
    });
  });

  describe('replay', () => {
    it('runs the registered replayer and marks REPLAYED', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      service.registerReplayer('realty.visit.reminder', handler);
      const res = await service.replay(BIZ, DL_ID);
      expect(handler).toHaveBeenCalledWith(BIZ, expect.objectContaining({ visitId: 'v1' }), expect.any(Object));
      expect(repo.update).toHaveBeenCalledWith(
        BIZ,
        DL_ID,
        expect.objectContaining({ status: DeadLetterStatus.REPLAYED }),
      );
      expect(res.status).toBe(DeadLetterStatus.REPLAYED);
      expect(emitter.emit).toHaveBeenCalledWith(
        REALTY_HARDENING_EVENTS.DEAD_LETTER_REPLAYED,
        expect.objectContaining({ deadLetterId: DL_ID }),
      );
    });

    it('throws when no replayer is registered for the operation', async () => {
      await expect(service.replay(BIZ, DL_ID)).rejects.toThrow(/No replayer/);
    });

    it('bumps attempts and stays PENDING when replay fails but is not exhausted', async () => {
      repo.findById.mockResolvedValue(makeEntry({ attempts: 3 }));
      service.registerReplayer('realty.visit.reminder', jest.fn().mockRejectedValue(new Error('still failing')));
      const res = await service.replay(BIZ, DL_ID);
      expect(res.status).toBe(DeadLetterStatus.PENDING);
      expect(res.attempts).toBe(4);
    });

    it('auto-discards after exhausting max replays', async () => {
      repo.findById.mockResolvedValue(makeEntry({ attempts: 7 }));
      service.registerReplayer('realty.visit.reminder', jest.fn().mockRejectedValue(new Error('nope')));
      const res = await service.replay(BIZ, DL_ID);
      expect(res.status).toBe(DeadLetterStatus.DISCARDED);
    });

    it('is idempotent when the entry was already replayed', async () => {
      repo.findById.mockResolvedValue(makeEntry({ status: DeadLetterStatus.REPLAYED }));
      const res = await service.replay(BIZ, DL_ID);
      expect(res.status).toBe(DeadLetterStatus.REPLAYED);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('throws NotFound for a missing dead letter', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.replay(BIZ, DL_ID)).rejects.toThrow(/not found/i);
    });
  });

  describe('resolve + stats', () => {
    it('marks an entry RESOLVED with a note and emits', async () => {
      await service.resolve(BIZ, DL_ID, DeadLetterStatus.RESOLVED, 'handled manually');
      expect(repo.update).toHaveBeenCalledWith(
        BIZ,
        DL_ID,
        expect.objectContaining({ status: DeadLetterStatus.RESOLVED, resolution: 'handled manually' }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        REALTY_HARDENING_EVENTS.DEAD_LETTER_RESOLVED,
        expect.objectContaining({ status: DeadLetterStatus.RESOLVED }),
      );
    });

    it('aggregates counts per status', async () => {
      repo.countByStatus
        .mockResolvedValueOnce(2) // pending
        .mockResolvedValueOnce(5) // replayed
        .mockResolvedValueOnce(1) // resolved
        .mockResolvedValueOnce(3); // discarded
      const stats = await service.stats(BIZ);
      expect(stats).toEqual({ pending: 2, replayed: 5, resolved: 1, discarded: 3 });
    });
  });
});
