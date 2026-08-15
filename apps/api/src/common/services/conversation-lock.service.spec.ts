/**
 * ConversationLockService — the serialization primitive behind "one turn at a
 * time per conversation".
 *
 * The properties that matter are all about *concurrency*, so every test here
 * drives two or more overlapping callers and asserts on the interleaving, not
 * on a return value. A lock that merely returns the right answer while letting
 * both callers run at once is the bug.
 */
import {
  ConversationLockService,
  CONVERSATION_LOCK_TIMEOUT_MS,
} from './conversation-lock.service';

/** A promise plus the handles to settle it from the test body. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks drain, so chained `.then`s have actually run. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('ConversationLockService', () => {
  let locks: ConversationLockService;

  beforeEach(() => {
    locks = new ConversationLockService();
  });

  describe('mutual exclusion', () => {
    it('does not start the second holder until the first has finished', async () => {
      const first = deferred();
      const order: string[] = [];

      const a = locks.runExclusive('k', async () => {
        order.push('a:start');
        await first.promise;
        order.push('a:end');
      });
      const b = locks.runExclusive('k', async () => {
        order.push('b:start');
      });

      await flush();
      // The whole point: b has not begun while a is still in flight.
      expect(order).toEqual(['a:start']);

      first.resolve();
      await Promise.all([a, b]);
      expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    });

    it('lets different keys run concurrently', async () => {
      const held = deferred();
      const order: string[] = [];

      const a = locks.runExclusive('k1', async () => {
        order.push('a:start');
        await held.promise;
      });
      const b = locks.runExclusive('k2', async () => {
        order.push('b:start');
      });

      await flush();
      // Two different buyers must not queue behind each other.
      expect(order).toEqual(['a:start', 'b:start']);

      held.resolve();
      await Promise.all([a, b]);
    });

    it('runs waiters in the order they arrived, not the order they finish', async () => {
      // This is what keeps replies in order. A lock that only guarantees
      // exclusion would satisfy every test above and still deliver the answer
      // to message 3 before the answer to message 1.
      const gate = deferred();
      const finished: number[] = [];

      const runs = [1, 2, 3].map((n) =>
        locks.runExclusive('k', async () => {
          if (n === 1) await gate.promise;
          finished.push(n);
        }),
      );

      gate.resolve();
      await Promise.all(runs);
      expect(finished).toEqual([1, 2, 3]);
    });
  });

  describe('failure handling', () => {
    it('propagates the holder\'s rejection to its own caller', async () => {
      await expect(
        locks.runExclusive('k', async () => {
          throw new Error('turn failed');
        }),
      ).rejects.toThrow('turn failed');
    });

    it('hands the lock to the next waiter after a failed turn', async () => {
      // A poisoned chain would wedge the conversation for the life of the
      // process — every later message for that buyer silently never handled.
      const failing = locks.runExclusive('k', async () => {
        throw new Error('turn failed');
      });
      const next = locks.runExclusive('k', async () => 'ran');

      await expect(failing).rejects.toThrow('turn failed');
      await expect(next).resolves.toBe('ran');
    });

    it('does not report the predecessor\'s failure as the waiter\'s own', async () => {
      const failing = locks.runExclusive('k', async () => {
        throw new Error('first');
      });
      const next = locks.runExclusive('k', async () => 'clean');

      await expect(failing).rejects.toThrow('first');
      await expect(next).resolves.toBe('clean');
    });
  });

  describe('liveness', () => {
    it('gives up waiting on a holder that never finishes', async () => {
      jest.useFakeTimers();
      try {
        const stuck = deferred();
        let secondRan = false;

        void locks.runExclusive('k', () => stuck.promise);
        const waiter = locks.runExclusive('k', async () => {
          secondRan = true;
        });

        await Promise.resolve();
        expect(secondRan).toBe(false);

        // A handler hung on something with no deadline must degrade this one
        // conversation to concurrent processing, not freeze it forever.
        jest.advanceTimersByTime(CONVERSATION_LOCK_TIMEOUT_MS + 1);
        await waiter;
        expect(secondRan).toBe(true);

        stuck.resolve();
      } finally {
        jest.useRealTimers();
      }
    });

    it('honours a caller-supplied ceiling', async () => {
      jest.useFakeTimers();
      try {
        const stuck = deferred();
        let ran = false;

        void locks.runExclusive('k', () => stuck.promise);
        const waiter = locks.runExclusive(
          'k',
          async () => {
            ran = true;
          },
          50,
        );

        jest.advanceTimersByTime(51);
        await waiter;
        expect(ran).toBe(true);

        stuck.resolve();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('bookkeeping', () => {
    it('releases the key once nothing is queued behind it', async () => {
      // One retained entry per conversation would be an unbounded leak on a
      // long-lived process.
      await locks.runExclusive('k', async () => undefined);
      await flush();
      expect(locks.activeKeys).toBe(0);
    });

    it('releases the key after a failed turn too', async () => {
      await expect(
        locks.runExclusive('k', async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await flush();
      expect(locks.activeKeys).toBe(0);
    });

    it('keeps the key while waiters are still queued', async () => {
      const gate = deferred();
      const a = locks.runExclusive('k', () => gate.promise);
      const b = locks.runExclusive('k', async () => undefined);

      expect(locks.activeKeys).toBe(1);
      gate.resolve();
      await Promise.all([a, b]);
      await flush();
      expect(locks.activeKeys).toBe(0);
    });
  });

  describe('keys', () => {
    it('scopes a conversation key by tenant', () => {
      // Ids are only unique within a business; an unscoped key would let one
      // tenant's conversation block another's.
      expect(ConversationLockService.conversationKey('b1', 'c1')).not.toBe(
        ConversationLockService.conversationKey('b2', 'c1'),
      );
    });

    it('separates lead keys from conversation keys', () => {
      expect(ConversationLockService.leadKey('b1', 'x')).not.toBe(
        ConversationLockService.conversationKey('b1', 'x'),
      );
    });
  });
});
