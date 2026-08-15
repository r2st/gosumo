import { Prisma } from '@prisma/client';
import {
  createSequencedMessage,
  type SequencedMessageClient,
  type SequencedMessageData,
} from './message-sequence';
import {
  MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST,
  MESSAGE_ORDER_IN_CONVERSATION_OLDEST_FIRST,
  MESSAGE_ORDER_NEWEST_FIRST,
  MESSAGE_ORDER_OLDEST_FIRST,
} from './message-order';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const CONVERSATION_ID = '00000000-0000-4000-b000-000000000001';
const ACCOUNT_ID = '00000000-0000-4000-c000-000000000001';

function data(overrides: Partial<SequencedMessageData> = {}): SequencedMessageData {
  return {
    business_id: BUSINESS_ID,
    conversation_id: CONVERSATION_ID,
    channel_account_id: ACCOUNT_ID,
    direction: 'INBOUND',
    sender_type: 'CLIENT',
    content: { type: 'TEXT', text: 'hello' },
    external_id: 'wamid.ABC',
    ...overrides,
  } as SequencedMessageData;
}

function uniqueViolation(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { target },
  });
}

/**
 * A Prisma double that behaves like the real allocator: `conversations.update`
 * hands out 1, 2, 3… and `messages.create` records what it was asked to store.
 */
function makeClient(options: { createImpl?: jest.Mock; existing?: unknown } = {}) {
  let seq = 0;
  const conversationsUpdate = jest.fn(async (_args: unknown) => ({
    message_seq: ++seq,
  }));
  const messagesCreate =
    options.createImpl ?? jest.fn(async (args: { data: { sequence: number } }) => ({
      id: `msg-${args.data.sequence}`,
      ...args.data,
    }));
  const messagesFindFirst = jest.fn(async () => options.existing ?? null);

  const tx = {
    conversations: { update: conversationsUpdate },
    messages: { create: messagesCreate },
  };

  const client = {
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    messages: { findFirst: messagesFindFirst },
  } as unknown as SequencedMessageClient;

  return { client, conversationsUpdate, messagesCreate, messagesFindFirst };
}

describe('createSequencedMessage', () => {
  describe('sequence allocation', () => {
    it('claims the next sequence and stores the message with it', async () => {
      const { client, messagesCreate } = makeClient();

      const result = await createSequencedMessage(client, data());

      expect(result.duplicate).toBe(false);
      expect(messagesCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ sequence: 1 }),
      });
    });

    it('hands out strictly increasing sequences across writes', async () => {
      const { client, messagesCreate } = makeClient();

      await createSequencedMessage(client, data({ external_id: 'a' }));
      await createSequencedMessage(client, data({ external_id: 'b' }));
      await createSequencedMessage(client, data({ external_id: 'c' }));

      const claimed = messagesCreate.mock.calls.map(
        ([args]: [{ data: { sequence: number } }]) => args.data.sequence,
      );
      expect(claimed).toEqual([1, 2, 3]);
    });

    it('claims under the conversation row, scoped to the tenant', async () => {
      // The `business_id` in this WHERE is what stops a conversation id from
      // another tenant advancing a counter it does not own — and, because the
      // update is the first statement in the transaction, what makes such a
      // write fail before the message row exists rather than after.
      const { client, conversationsUpdate } = makeClient();

      await createSequencedMessage(client, data());

      expect(conversationsUpdate).toHaveBeenCalledWith({
        where: { id: CONVERSATION_ID, business_id: BUSINESS_ID },
        data: { message_seq: { increment: 1 } },
        select: { message_seq: true },
      });
    });

    it('claims and inserts inside one transaction', async () => {
      // Two statements outside a transaction is a counter that advances for a
      // message that was never stored — a permanent gap, and worse, a second
      // writer reading past it.
      const { client } = makeClient();

      await createSequencedMessage(client, data());

      expect(client.$transaction).toHaveBeenCalledTimes(1);
    });

    it('increments by a database-side expression, never a read-then-write', async () => {
      // `{ increment: 1 }` compiles to `SET message_seq = message_seq + 1`,
      // which takes the row lock that serializes concurrent writers. Reading
      // the value and writing back `n + 1` is the race this exists to close.
      const { client, conversationsUpdate } = makeClient();

      await createSequencedMessage(client, data());

      const args = conversationsUpdate.mock.calls[0]?.[0] as
        | { data: { message_seq: unknown } }
        | undefined;
      expect(args?.data.message_seq).toEqual({ increment: 1 });
    });
  });

  describe('duplicate suppression', () => {
    it('returns the stored row instead of throwing when the message already exists', async () => {
      const existing = { id: 'msg-original', sequence: 4 };
      const createImpl = jest.fn(async () => {
        throw uniqueViolation(['business_id', 'channel_account_id', 'external_id']);
      });
      const { client, messagesFindFirst } = makeClient({ createImpl, existing });

      const result = await createSequencedMessage(client, data());

      expect(result.duplicate).toBe(true);
      expect(result.message).toBe(existing);
      expect(messagesFindFirst).toHaveBeenCalledWith({
        where: {
          business_id: BUSINESS_ID,
          channel_account_id: ACCOUNT_ID,
          external_id: 'wamid.ABC',
        },
      });
    });

    it('rethrows a unique violation when the message has no external id to match on', async () => {
      // An outbound or system message has no channel-assigned identity, so a
      // P2002 on its insert is some other constraint and not ours to swallow.
      const createImpl = jest.fn(async () => {
        throw uniqueViolation(['conversation_id', 'sequence']);
      });
      const { client } = makeClient({ createImpl });

      await expect(
        createSequencedMessage(client, data({ external_id: null })),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('rethrows when the violation was on some other constraint', async () => {
      // The lookup finds nothing, which means the row the constraint complained
      // about is not the one we were told about. Swallowing that would report
      // success for a write that did not happen.
      const createImpl = jest.fn(async () => {
        throw uniqueViolation(['conversation_id', 'sequence']);
      });
      const { client } = makeClient({ createImpl, existing: null });

      await expect(createSequencedMessage(client, data())).rejects.toMatchObject({
        code: 'P2002',
      });
    });

    it('does not swallow a non-duplicate failure', async () => {
      const createImpl = jest.fn(async () => {
        throw new Error('connection reset');
      });
      const { client } = makeClient({ createImpl });

      await expect(createSequencedMessage(client, data())).rejects.toThrow(
        'connection reset',
      );
    });

    it('propagates a missing or cross-tenant conversation rather than inventing one', async () => {
      const client = {
        $transaction: jest.fn(async (fn: (t: unknown) => unknown) =>
          fn({
            conversations: {
              update: jest.fn(async () => {
                throw new Prisma.PrismaClientKnownRequestError('Record not found', {
                  code: 'P2025',
                  clientVersion: Prisma.prismaVersion.client,
                });
              }),
            },
            messages: { create: jest.fn() },
          }),
        ),
        messages: { findFirst: jest.fn() },
      } as unknown as SequencedMessageClient;

      await expect(createSequencedMessage(client, data())).rejects.toMatchObject({
        code: 'P2025',
      });
    });
  });
});

describe('message read orderings', () => {
  it('leads with sequence only in the conversation-scoped pair', () => {
    expect(MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST[0]).toEqual({ sequence: 'desc' });
    expect(MESSAGE_ORDER_IN_CONVERSATION_OLDEST_FIRST[0]).toEqual({ sequence: 'asc' });

    // The tenant-wide pair must NOT: every conversation has a message 1, so
    // sorting by sequence across conversations orders by position-in-thread
    // while claiming to order by recency.
    for (const key of [...MESSAGE_ORDER_NEWEST_FIRST, ...MESSAGE_ORDER_OLDEST_FIRST]) {
      expect(key).not.toHaveProperty('sequence');
    }
  });

  it('sorts every key of an ordering in the same direction', () => {
    // A tie-break running counter to the primary key inverts tied pairs
    // relative to every other reader, which is worse than having none.
    for (const ordering of [
      MESSAGE_ORDER_NEWEST_FIRST,
      MESSAGE_ORDER_OLDEST_FIRST,
      MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST,
      MESSAGE_ORDER_IN_CONVERSATION_OLDEST_FIRST,
    ]) {
      const directions = new Set(ordering.map((key) => Object.values(key)[0]));
      expect(directions.size).toBe(1);
    }
  });

  it('keeps the old keys as tie-breaks behind sequence', () => {
    // Unreachable while the unique index holds, and kept precisely so that an
    // order which somehow does tie is still not arbitrary.
    expect(MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST).toEqual([
      { sequence: 'desc' },
      { created_at: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('never orders by a channel-supplied timestamp', () => {
    // `sent_at` is whatever the provider or the customer's handset claimed. A
    // skewed clock would otherwise insert a message into the middle of a
    // conversation, or ahead of its first line.
    for (const ordering of [
      MESSAGE_ORDER_NEWEST_FIRST,
      MESSAGE_ORDER_OLDEST_FIRST,
      MESSAGE_ORDER_IN_CONVERSATION_NEWEST_FIRST,
      MESSAGE_ORDER_IN_CONVERSATION_OLDEST_FIRST,
    ]) {
      for (const key of ordering) {
        expect(key).not.toHaveProperty('sent_at');
      }
    }
  });
});
