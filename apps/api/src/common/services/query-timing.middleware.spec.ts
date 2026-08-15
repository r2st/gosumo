import { Logger } from '@nestjs/common';

import { runWithRequestContext, setContextBusinessId } from '../context/request-context';
import {
  CRITICAL_QUERY_MS,
  DEFAULT_SLOW_QUERY_MS,
  QueryTimingRecorder,
  configuredSlowQueryMs,
  createQueryTimingMiddleware,
} from './query-timing.middleware';

/**
 * The slow-query log.
 *
 * The clock is injected, so nothing here sleeps and nothing here is timing
 * dependent — the durations are stated, not waited for.
 */
describe('query timing middleware', () => {
  let logger: Logger;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let recorder: QueryTimingRecorder;

  /**
   * A middleware whose clock reports exactly `durationMs` across one query:
   * the first read is the start stamp, the second is the one in the `finally`.
   */
  const middlewareWith = (durationMs: number, thresholdMs = DEFAULT_SLOW_QUERY_MS) => {
    let calls = 0;
    return createQueryTimingMiddleware({
      logger,
      recorder,
      thresholdMs,
      now: () => (calls++ === 0 ? 1_000 : 1_000 + durationMs),
    });
  };

  beforeEach(() => {
    logger = new Logger('test');
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    recorder = new QueryTimingRecorder();
  });

  afterEach(() => jest.restoreAllMocks());

  describe('the threshold', () => {
    it('defaults to 500ms', () => {
      expect(configuredSlowQueryMs(undefined)).toBe(DEFAULT_SLOW_QUERY_MS);
      expect(configuredSlowQueryMs('')).toBe(DEFAULT_SLOW_QUERY_MS);
    });

    it('takes an override from the environment', () => {
      expect(configuredSlowQueryMs('250')).toBe(250);
    });

    it.each(['nonsense', '0', '-5'])('ignores %s rather than disabling the log', (raw) => {
      expect(configuredSlowQueryMs(raw)).toBe(DEFAULT_SLOW_QUERY_MS);
    });
  });

  describe('logging', () => {
    const run = async (middleware: ReturnType<typeof createQueryTimingMiddleware>) =>
      middleware({ model: 'clients', action: 'findMany', args: {} } as never, (async () =>
        'rows') as never);

    it('says nothing about a fast query', async () => {
      await run(middlewareWith(12));
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });

    it('warns over the threshold, naming the model, the action and the duration', async () => {
      await run(middlewareWith(812));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('clients.findMany');
      expect(warn.mock.calls[0]?.[0]).toContain('812ms');
      expect(warn.mock.calls[0]?.[0]).toContain('threshold 500ms');
    });

    it('logs exactly at the threshold, not just above it', async () => {
      await run(middlewareWith(DEFAULT_SLOW_QUERY_MS));
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('escalates to error past the critical mark', async () => {
      await run(middlewareWith(CRITICAL_QUERY_MS + 1));
      expect(error).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('carries the correlation id and the tenant', async () => {
      await runWithRequestContext({ correlationId: 'corr-1' }, async () => {
        setContextBusinessId('biz-9');
        await run(middlewareWith(900));
      });

      expect(warn.mock.calls[0]?.[0]).toContain('[corr-1]');
      expect(warn.mock.calls[0]?.[0]).toContain('business biz-9');
    });

    it('omits the tenant rather than writing undefined when there is none', async () => {
      await run(middlewareWith(900));
      expect(warn.mock.calls[0]?.[0]).not.toContain('undefined');
    });

    it('names a raw query $raw rather than leaving the shape ragged', async () => {
      const middleware = middlewareWith(900);
      await middleware({ action: 'queryRaw', args: {} } as never, (async () => []) as never);
      expect(warn.mock.calls[0]?.[0]).toContain('$raw.queryRaw');
    });
  });

  describe('failures', () => {
    it('times a query that throws — the slowest query in a process usually did', async () => {
      const middleware = middlewareWith(9_000);
      await expect(
        middleware({ model: 'orders', action: 'findMany', args: {} } as never, (async () => {
          throw new Error('connection terminated');
        }) as never),
      ).rejects.toThrow('connection terminated');

      expect(error).toHaveBeenCalledTimes(1);
      expect(recorder.stats().slow).toBe(1);
    });

    it('does not swallow or rewrite the error', async () => {
      const middleware = middlewareWith(1);
      const thrown = new Error('P2002');
      await expect(
        middleware({ model: 'orders', action: 'create', args: {} } as never, (async () => {
          throw thrown;
        }) as never),
      ).rejects.toBe(thrown);
    });

    it('passes the result through untouched', async () => {
      const middleware = middlewareWith(1);
      await expect(
        middleware({ model: 'orders', action: 'findMany', args: {} } as never, (async () => [
          { id: 'o1' },
        ]) as never),
      ).resolves.toEqual([{ id: 'o1' }]);
    });
  });

  describe('the recorder', () => {
    it('counts every query and only the slow ones as slow', async () => {
      await middlewareWith(10)({ model: 'clients', action: 'findMany' } as never, (async () =>
        [])as never);
      await middlewareWith(700)({ model: 'clients', action: 'count' } as never, (async () =>
        0) as never);

      expect(recorder.stats()).toEqual({
        total: 2,
        slow: 1,
        slowest: { model: 'clients', action: 'count', durationMs: 700 },
      });
    });

    it('keeps the slowest, not the latest', async () => {
      await middlewareWith(2_000)({ model: 'orders', action: 'findMany' } as never, (async () =>
        [])as never);
      await middlewareWith(600)({ model: 'clients', action: 'findMany' } as never, (async () =>
        [])as never);

      expect(recorder.stats().slowest).toEqual({
        model: 'orders',
        action: 'findMany',
        durationMs: 2_000,
      });
    });

    it('starts empty and can be reset', () => {
      expect(recorder.stats()).toEqual({ total: 0, slow: 0, slowest: null });
      recorder.record('clients', 'findMany', 900, 500);
      recorder.reset();
      expect(recorder.stats()).toEqual({ total: 0, slow: 0, slowest: null });
    });

    it('hands out a copy, so a reader cannot mutate the counters', () => {
      recorder.record('clients', 'findMany', 900, 500);
      const stats = recorder.stats();
      stats.slowest!.durationMs = 1;
      expect(recorder.stats().slowest?.durationMs).toBe(900);
    });
  });
});
