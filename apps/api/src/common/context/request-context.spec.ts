import { EventEmitter } from 'node:events';
import {
  correlationTag,
  getCorrelationId,
  getRequestContext,
  runWithRequestContext,
  setContextBusinessId,
} from './request-context';

describe('request context', () => {
  it('exposes the id to code running inside it', () => {
    runWithRequestContext({ correlationId: 'abc' }, () => {
      expect(getCorrelationId()).toBe('abc');
    });
  });

  it('reports no context outside a request', () => {
    // The normal answer at startup, on a cron tick, and in a unit test.
    expect(getRequestContext()).toBeUndefined();
    expect(getCorrelationId()).toBeUndefined();
  });

  it('survives await boundaries', async () => {
    // The property the whole design rests on: a service that awaits Prisma and
    // then logs must still see the id, or the middle of every request is
    // untraceable — which was the bug this replaced.
    await runWithRequestContext({ correlationId: 'across-await' }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getCorrelationId()).toBe('across-await');
    });
  });

  it('survives an event-emitter callback', async () => {
    // This app's modules talk over `EventEmitter`. A listener invoked during a
    // request has to inherit the id or every event-driven path goes dark.
    const bus = new EventEmitter();
    const seen: (string | undefined)[] = [];
    bus.on('ping', () => seen.push(getCorrelationId()));

    runWithRequestContext({ correlationId: 'via-event' }, () => {
      bus.emit('ping');
    });

    expect(seen).toEqual(['via-event']);
  });

  it('keeps concurrent requests apart', async () => {
    // The failure mode a module-level variable would have: two interleaved
    // requests reading each other's id.
    const observe = async (id: string, delay: number) =>
      runWithRequestContext({ correlationId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return getCorrelationId();
      });

    await expect(Promise.all([observe('first', 5), observe('second', 1)])).resolves.toEqual([
      'first',
      'second',
    ]);
  });

  it('does not leak out of the callback', async () => {
    await runWithRequestContext({ correlationId: 'scoped' }, async () => undefined);
    expect(getCorrelationId()).toBeUndefined();
  });

  it('returns the callback result', () => {
    expect(runWithRequestContext({ correlationId: 'x' }, () => 42)).toBe(42);
  });

  describe('setContextBusinessId', () => {
    it('attaches the tenant to a context already in flight', () => {
      runWithRequestContext({ correlationId: 'x' }, () => {
        setContextBusinessId('biz-1');
        expect(getRequestContext()?.businessId).toBe('biz-1');
      });
    });

    it('is a no-op outside a context rather than throwing', () => {
      expect(() => setContextBusinessId('biz-1')).not.toThrow();
    });
  });

  describe('correlationTag', () => {
    it('formats the id for the front of a log line', () => {
      runWithRequestContext({ correlationId: 'abc' }, () => {
        expect(correlationTag()).toBe('[abc] ');
      });
    });

    it('is empty rather than "[undefined]" with no context', () => {
      // `[undefined]` reads as a captured id that came out wrong, which is
      // worse than no prefix at all.
      expect(correlationTag()).toBe('');
    });
  });
});
