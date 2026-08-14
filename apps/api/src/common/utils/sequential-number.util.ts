import { Prisma } from '@prisma/client';

/**
 * How many times a create may be retried when its generated human-readable
 * number collides with one another request just took.
 *
 * Each retry re-reads the highest number currently stored, so it converges: the
 * only way to exhaust the attempts is that many requests racing on the same
 * business in the same instant, which is far past what a small-business tenant
 * generates. Failing after that is deliberate — an unbounded retry against a
 * genuinely stuck sequence would spin instead of surfacing.
 */
export const SEQUENCE_COLLISION_MAX_ATTEMPTS = 8;

/**
 * Upper bound (ms) on the random pause before a retry.
 *
 * Retrying immediately makes contention worse rather than better: every loser
 * of a collision re-derives at the same instant, derives the same next number
 * as the other losers, and collides again — so with N simultaneous requests the
 * last one needs N attempts and runs out. A short random pause breaks the
 * lockstep, which is the difference between the attempt ceiling being a
 * formality and being reachable.
 *
 * Deliberately tiny. This is a contended insert, not a backoff against a
 * failing dependency, and the caller is a customer waiting on an order.
 */
export const SEQUENCE_RETRY_JITTER_MS = 25;

/** Random pause used between retries. Injectable so tests stay deterministic. */
export type DelayFn = (ms: number) => Promise<void>;

const defaultDelay: DelayFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Whether a thrown error is Postgres' unique-constraint violation, optionally
 * narrowed to a constraint covering a particular column.
 *
 * Prisma reports the offending columns in `meta.target`, which is a string[] on
 * PostgreSQL and a string on some other providers — both shapes are handled so
 * a provider quirk cannot silently turn this into "no collision, rethrow".
 */
export function isUniqueViolation(err: unknown, column?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  if (!column) return true;

  const target = (err.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.includes(column);
  if (typeof target === 'string') return target.includes(column);
  // No usable target detail: treat a P2002 as a possible collision rather than
  // rethrowing a retryable failure as a 500.
  return true;
}

/**
 * Create a record whose human-readable sequential number is derived from what
 * is already stored, retrying on a collision.
 *
 * Numbers like `ORD-2026-00042` cannot be allocated by reading the current
 * maximum and adding one: two requests that read at the same moment compute the
 * same number, and the unique constraint on the column then fails the second
 * one outright. For orders that surfaces as a customer's order simply erroring
 * — after stock has already been reserved for it.
 *
 * There is no lock to take that would be cheaper than this: the number has to
 * be unique per business per year, so a global sequence would produce gaps
 * across tenants, and a per-tenant sequence would mean DDL per tenant. Letting
 * the unique constraint arbitrate and re-deriving on the loser's side keeps the
 * database as the single source of truth for what has been issued.
 *
 * @param generate  Derives the next number from current state. Called again on
 *                  every retry, so it must re-read rather than close over a
 *                  previously computed value.
 * @param create    Performs the insert with the generated number.
 * @param column    Column name the unique constraint covers, so an unrelated
 *                  unique violation from the same insert is not retried.
 */
export async function createWithSequentialNumber<T>(
  generate: () => Promise<string>,
  create: (numberValue: string) => Promise<T>,
  column: string,
  maxAttempts: number = SEQUENCE_COLLISION_MAX_ATTEMPTS,
  delay: DelayFn = defaultDelay,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const numberValue = await generate();
    try {
      return await create(numberValue);
    } catch (err) {
      if (!isUniqueViolation(err, column)) throw err;
      lastError = err;
      if (attempt < maxAttempts) {
        // Stagger the losers so they do not all re-derive the same next number
        // in lockstep and collide again on the retry.
        await delay(Math.floor(Math.random() * SEQUENCE_RETRY_JITTER_MS));
      }
    }
  }

  throw lastError;
}
