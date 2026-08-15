/**
 * Test support for `createSequencedMessage`.
 *
 * Storing a message is now two statements in one transaction — claim the next
 * `conversations.message_seq`, then insert with it — so a Prisma double that
 * only stubs `messages.create` no longer describes a working database. This
 * teaches an existing double the two things the allocator needs, without
 * changing what any spec asserts.
 *
 * `$transaction` runs the callback against the *same* double, so
 * `tx.messages.create` and `prisma.messages.create` are one jest.fn and every
 * existing `expect(messages.create).toHaveBeenCalledWith(...)` keeps working —
 * with `sequence` now among the fields, which is the point.
 *
 * Not named `*.spec.ts`, so jest's `testRegex` leaves it alone.
 */

type Mock = jest.Mock;

interface SequenceableDouble {
  conversations?: { update?: Mock } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Make `double` usable by `createSequencedMessage`, and return it.
 *
 * Mutates in place so the destructured per-table references a spec already
 * holds (`const { messages, conversations } = makePrisma()`) still point at the
 * same mocks.
 *
 * `conversations.update` is replaced with an implementation that hands out
 * `message_seq` 1, 2, 3… — the allocator's contract. Call assertions on it are
 * unaffected; only its return value is now meaningful, and nothing in the
 * codebase reads that return except the allocator.
 */
export function withMessageSequence<T extends SequenceableDouble>(double: T): T {
  let nextSequence = 0;
  const writable = double as SequenceableDouble;

  writable['$transaction'] = jest.fn(
    async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(double),
  );

  if (writable.conversations) {
    writable.conversations.update = jest.fn(async () => ({
      message_seq: ++nextSequence,
    }));
  }

  return double;
}
