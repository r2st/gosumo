/**
 * Sequential human-readable numbers (ORD-2026-00042, INV-2026-000042).
 *
 * These are derived by reading what is already stored, which means two
 * requests that read at the same moment derive the same number. Both columns
 * carry a unique constraint, so the loser's insert simply failed — a customer's
 * order erroring out, after its stock had already been reserved and not rolled
 * back. The whole point of this helper is that the second request re-derives
 * and succeeds instead.
 *
 * Nothing here mocks the collision away: `create` is driven by a fake store
 * that enforces uniqueness the same way the database does.
 */

import { Prisma } from '@prisma/client';

import {
  createWithSequentialNumber,
  isUniqueViolation,
  SEQUENCE_COLLISION_MAX_ATTEMPTS,
} from './sequential-number.util';

function uniqueViolation(target: string[] | string = ['business_id', 'order_number']) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.0.0',
    meta: { target },
  });
}

/**
 * A store that behaves like the unique index: it rejects a number already
 * taken, and hands out the next one above the highest it holds.
 */
function makeStore(existing: number[] = []) {
  const taken = new Set(existing.map((n) => `ORD-2026-${String(n).padStart(5, '0')}`));

  return {
    taken,
    next: async (): Promise<string> => {
      const highest = [...taken].reduce((max, n) => Math.max(max, Number(n.slice(9))), 0);
      return `ORD-2026-${String(highest + 1).padStart(5, '0')}`;
    },
    create: async (n: string): Promise<{ order_number: string }> => {
      if (taken.has(n)) throw uniqueViolation();
      taken.add(n);
      return { order_number: n };
    },
  };
}

describe('isUniqueViolation', () => {
  it('recognises a P2002 on the named column', () => {
    expect(isUniqueViolation(uniqueViolation(), 'order_number')).toBe(true);
  });

  it('ignores a P2002 on a different column', () => {
    // The same insert can violate an unrelated constraint. Retrying that would
    // loop pointlessly and then surface the wrong failure.
    expect(isUniqueViolation(uniqueViolation(['business_id', 'email']), 'order_number')).toBe(
      false,
    );
  });

  it('handles a string target, as non-Postgres providers report it', () => {
    expect(isUniqueViolation(uniqueViolation('order_number'), 'order_number')).toBe(true);
  });

  it('treats a P2002 with no usable target as a possible collision', () => {
    // Better to retry once and re-derive than to turn a retryable collision
    // into a 500 because the driver did not name the column.
    expect(isUniqueViolation(uniqueViolation(undefined as unknown as string[]), 'order_number')).toBe(
      true,
    );
  });

  it('is not fooled by other Prisma errors', () => {
    const notFound = new Prisma.PrismaClientKnownRequestError('Not found', {
      code: 'P2025',
      clientVersion: '5.0.0',
    });
    expect(isUniqueViolation(notFound, 'order_number')).toBe(false);
  });

  it('is not fooled by a plain Error', () => {
    expect(isUniqueViolation(new Error('P2002'), 'order_number')).toBe(false);
  });
});

describe('createWithSequentialNumber', () => {
  it('creates on the first attempt when nothing collides', async () => {
    const store = makeStore();
    const create = jest.fn(store.create);

    const result = await createWithSequentialNumber(store.next, create, 'order_number');

    expect(result).toEqual({ order_number: 'ORD-2026-00001' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('re-derives and succeeds when another request took the number first', async () => {
    const store = makeStore();
    let raced = false;

    const result = await createWithSequentialNumber(
      store.next,
      async (n) => {
        // Simulate the other request committing between our derive and write.
        if (!raced) {
          raced = true;
          store.taken.add(n);
        }
        return store.create(n);
      },
      'order_number',
    );

    // The winner kept 00001; this one moved up rather than failing.
    expect(result).toEqual({ order_number: 'ORD-2026-00002' });
  });

  it('re-derives on every retry rather than reusing the first number', async () => {
    const store = makeStore();
    const seen: string[] = [];

    await createWithSequentialNumber(
      store.next,
      async (n) => {
        seen.push(n);
        // Two consecutive losses before the third attempt lands.
        if (seen.length < 3) {
          store.taken.add(n);
          throw uniqueViolation();
        }
        return store.create(n);
      },
      'order_number',
    );

    // Closing over a single generated value would retry the same doomed number
    // until the attempts ran out.
    expect(seen).toEqual(['ORD-2026-00001', 'ORD-2026-00002', 'ORD-2026-00003']);
  });

  it('rethrows a unique violation on an unrelated column without retrying', async () => {
    const create = jest.fn().mockRejectedValue(uniqueViolation(['business_id', 'email']));

    await expect(
      createWithSequentialNumber(makeStore().next, create, 'order_number'),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rethrows any non-collision failure immediately', async () => {
    const create = jest.fn().mockRejectedValue(new Error('connection reset'));

    await expect(
      createWithSequentialNumber(makeStore().next, create, 'order_number'),
    ).rejects.toThrow('connection reset');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt ceiling rather than spinning', async () => {
    // A sequence that never yields is a bug, not congestion; retrying it
    // forever would hold a request open instead of surfacing.
    const create = jest.fn().mockRejectedValue(uniqueViolation());

    await expect(
      createWithSequentialNumber(makeStore().next, create, 'order_number'),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(create).toHaveBeenCalledTimes(SEQUENCE_COLLISION_MAX_ATTEMPTS);
  });

  describe('under concurrency', () => {
    /**
     * A delay that actually staggers, standing in for the real jitter without
     * the randomness. Racers resume in call order, which is what a random pause
     * achieves in aggregate and what a bare `await Promise.resolve()` does not.
     */
    function staggeredDelay() {
      let slot = 0;
      return () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, (slot += 1));
        });
    }

    it('gives every racer a distinct number', async () => {
      // Ten simultaneous orders on one business. The failure this replaces is
      // nine of them erroring, each having already taken stock.
      const store = makeStore();

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          createWithSequentialNumber(
            store.next,
            store.create,
            'order_number',
            SEQUENCE_COLLISION_MAX_ATTEMPTS,
            staggeredDelay(),
          ),
        ),
      );

      expect(new Set(results.map((r) => r.order_number)).size).toBe(10);
    });

    it('never issues a duplicate, even when it runs out of attempts', async () => {
      // The hard invariant. Losing a create to exhaustion is a bad day; two
      // orders sharing a number is a wrong invoice and an ambiguous lookup, and
      // it must not be reachable no matter how contended the sequence is.
      const store = makeStore();
      const noDelay: () => Promise<void> = () => Promise.resolve();

      const settled = await Promise.allSettled(
        Array.from({ length: 40 }, () =>
          createWithSequentialNumber(store.next, store.create, 'order_number', 2, noDelay),
        ),
      );

      const issued = settled
        .filter((s): s is PromiseFulfilledResult<{ order_number: string }> =>
          s.status === 'fulfilled',
        )
        .map((s) => s.value.order_number);

      expect(new Set(issued).size).toBe(issued.length);
      // Some had to lose with only two attempts against forty racers — the
      // point is that they lost loudly rather than duplicating.
      expect(settled.some((s) => s.status === 'rejected')).toBe(true);
    });

    it('does not pause after the final attempt', async () => {
      // A sleep whose result nobody waits on is pure added latency on the
      // request that is already about to fail.
      const delay = jest.fn().mockResolvedValue(undefined);
      const create = jest.fn().mockRejectedValue(uniqueViolation());

      await createWithSequentialNumber(
        makeStore().next,
        create,
        'order_number',
        3,
        delay,
      ).catch(() => undefined);

      expect(create).toHaveBeenCalledTimes(3);
      expect(delay).toHaveBeenCalledTimes(2);
    });
  });
});
