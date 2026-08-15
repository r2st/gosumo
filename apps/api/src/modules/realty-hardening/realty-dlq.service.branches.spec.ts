/**
 * RealtyDlqService — the degradation branches.
 *
 * The DLQ is the thing that catches everything else's failures, so its own
 * failure modes are what matter here: a thrown non-Error (a string, an object,
 * `undefined`), an Error with no stack, and a persistence layer that is itself
 * down. In every one of those the service must still not throw out of
 * `capture` — a DLQ write failure that propagated would turn a recoverable
 * background failure into a request failure.
 *
 * Also covered: the state-machine rejections in `replay`/`resolve`, and the
 * optional arguments that the main spec always passes explicitly.
 */

import { DeadLetterStatus } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RealtyDlqService } from './realty-dlq.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const DL_ID = '00000000-0000-4000-a000-0000000000aa';

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: DL_ID,
    business_id: BIZ,
    source: 'realty-sitevisits',
    operation: 'realty.visit.reminder',
    payload: { visitId: 'v1' },
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

describe('RealtyDlqService — branches', () => {
  let repo: {
    create: jest.Mock;
    findById: jest.Mock;
    list: jest.Mock;
    countByStatus: jest.Mock;
    countPendingGlobal: jest.Mock;
    update: jest.Mock;
    claimForReplay: jest.Mock;
  };
  let emitter: { emit: jest.Mock };
  let service: RealtyDlqService;

  const meta = {
    source: 'realty-sitevisits',
    operation: 'realty.visit.reminder',
    payload: { visitId: 'v1' },
  };

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue(makeEntry()),
      findById: jest.fn().mockResolvedValue(makeEntry()),
      list: jest.fn().mockResolvedValue([]),
      countByStatus: jest.fn().mockResolvedValue(0),
      countPendingGlobal: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockImplementation((_b, _id, data) => makeEntry(data)),
      claimForReplay: jest.fn().mockResolvedValue(true),
    };
    emitter = { emit: jest.fn() };
    service = new RealtyDlqService(repo as never, emitter as never);
  });

  describe('capture — non-Error failures', () => {
    it('stringifies a thrown string and records no stack', async () => {
      await service.capture(BIZ, meta, 'plain string failure', 3);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: 'plain string failure',
          errorStack: null,
        }),
      );
    });

    it('stringifies a thrown non-Error object', async () => {
      await service.capture(BIZ, meta, { code: 'E_WEIRD' }, 1);

      const { errorMessage } = repo.create.mock.calls[0]![0];
      expect(errorMessage).toBe('[object Object]');
    });

    it('stringifies a thrown undefined', async () => {
      await service.capture(BIZ, meta, undefined, 1);

      expect(repo.create.mock.calls[0]![0].errorMessage).toBe('undefined');
    });

    it('records a null stack for an Error whose stack was stripped', async () => {
      const err = new Error('no stack here');
      delete (err as { stack?: string }).stack;

      await service.capture(BIZ, meta, err, 1);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: 'no stack here',
          errorStack: null,
        }),
      );
    });

    it('defaults an absent payload to an empty object', async () => {
      await service.capture(
        BIZ,
        { source: 's', operation: 'o' } as never,
        new Error('x'),
        1,
      );

      expect(repo.create.mock.calls[0]![0].payload).toEqual({});
    });
  });

  describe('capture — the persistence layer is itself down', () => {
    it('swallows a repository Error and returns null', async () => {
      repo.create.mockRejectedValue(new Error('db unreachable'));

      await expect(
        service.capture(BIZ, meta, new Error('original'), 3),
      ).resolves.toBeNull();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('swallows a repository non-Error rejection too', async () => {
      repo.create.mockRejectedValue('connection reset');

      await expect(
        service.capture(BIZ, meta, new Error('original'), 3),
      ).resolves.toBeNull();
    });

    it('does not let a capture failure escape runWithRetry with swallow set', async () => {
      repo.create.mockRejectedValue(new Error('db unreachable'));

      await expect(
        service.runWithRetry(BIZ, meta, () => Promise.reject(new Error('op')), {
          policy: { attempts: 1 },
          sleepFn: () => Promise.resolve(),
          swallow: true,
        }),
      ).resolves.toBeNull();
    });
  });

  describe('runWithRetry — default options', () => {
    it('succeeds on the first attempt without touching the DLQ', async () => {
      const result = await service.runWithRetry(BIZ, meta, async () => 'ok');

      expect(result).toBe('ok');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('uses the real sleeper when no injectable one is given', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce('recovered');

      // No sleepFn — this exercises the real setTimeout path. The backoff is
      // pinned to 1ms so the suite still does not wait on anything real.
      const result = await service.runWithRetry(BIZ, meta, fn, {
        policy: { attempts: 2, backoffMs: 1, maxBackoffMs: 1 },
      });

      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('logs a non-Error failure between retries without crashing', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce('string failure')
        .mockResolvedValueOnce('recovered');

      const result = await service.runWithRetry(BIZ, meta, fn, {
        policy: { attempts: 2 },
        sleepFn: () => Promise.resolve(),
      });

      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('list — default filter', () => {
    it('passes an empty filter through when none is supplied', async () => {
      await service.list(BIZ);

      expect(repo.list).toHaveBeenCalledWith(BIZ, {});
    });
  });

  describe('replay — non-replayable states', () => {
    it('refuses to replay a RESOLVED entry', async () => {
      repo.findById.mockResolvedValue(
        makeEntry({ status: DeadLetterStatus.RESOLVED }),
      );

      await expect(service.replay(BIZ, DL_ID)).rejects.toThrow(NotFoundException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('refuses to replay a DISCARDED entry', async () => {
      repo.findById.mockResolvedValue(
        makeEntry({ status: DeadLetterStatus.DISCARDED }),
      );

      await expect(service.replay(BIZ, DL_ID)).rejects.toThrow(
        /is DISCARDED, not replayable/,
      );
    });

    it('records a non-Error replay failure as a string', async () => {
      service.registerReplayer('realty.visit.reminder', () =>
        Promise.reject('replayer blew up'),
      );

      await service.replay(BIZ, DL_ID);

      expect(repo.update.mock.calls[0]![2]).toMatchObject({
        error_message: 'replayer blew up',
      });
    });

    it('falls back to an empty payload when the stored payload is an array', async () => {
      repo.findById.mockResolvedValue(makeEntry({ payload: ['not', 'a', 'map'] }));
      const handler = jest.fn().mockResolvedValue(undefined);
      service.registerReplayer('realty.visit.reminder', handler);

      await service.replay(BIZ, DL_ID);

      expect(handler).toHaveBeenCalledWith(BIZ, {}, expect.anything());
    });

    it('falls back to an empty payload when the stored payload is null', async () => {
      repo.findById.mockResolvedValue(makeEntry({ payload: null }));
      const handler = jest.fn().mockResolvedValue(undefined);
      service.registerReplayer('realty.visit.reminder', handler);

      await service.replay(BIZ, DL_ID);

      expect(handler).toHaveBeenCalledWith(BIZ, {}, expect.anything());
    });
  });

  describe('resolve', () => {
    it('rejects a status that is neither RESOLVED nor DISCARDED', async () => {
      await expect(
        service.resolve(BIZ, DL_ID, DeadLetterStatus.PENDING),
      ).rejects.toThrow(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('rejects REPLAYED as a manual resolution status', async () => {
      await expect(
        service.resolve(BIZ, DL_ID, DeadLetterStatus.REPLAYED),
      ).rejects.toThrow(BadRequestException);
    });

    it('stores a null resolution when no note is supplied', async () => {
      await service.resolve(BIZ, DL_ID, DeadLetterStatus.RESOLVED);

      expect(repo.update.mock.calls[0]![2]).toMatchObject({
        status: DeadLetterStatus.RESOLVED,
        resolution: null,
      });
    });

    it('stores the supplied note', async () => {
      await service.resolve(
        BIZ,
        DL_ID,
        DeadLetterStatus.DISCARDED,
        'duplicate of #42',
      );

      expect(repo.update.mock.calls[0]![2]).toMatchObject({
        resolution: 'duplicate of #42',
      });
    });
  });
});
