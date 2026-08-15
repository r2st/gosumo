import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { messages } from '@prisma/client';

/**
 * The one way a message row is written.
 *
 * ## Why an allocator exists at all
 *
 * `common/utils/message-order.ts` is the reading half of this story and states
 * the problem in full: `ORDER BY created_at DESC` is not a total order, because
 * `created_at` defaults to Postgres `now()` — the *transaction start* timestamp
 * — so two messages whose transactions begin in the same microsecond compare
 * equal, and the `(created_at, id)` tie-break resolves them by a v4 UUID that
 * carries no time information. Every reader agrees on the result, which is the
 * property that file set out to buy, but the order they agree on is not the
 * order the messages arrived in and nothing can recover that after the fact.
 *
 * `messages.sequence` records it at write time instead. The claim is
 *
 *     UPDATE conversations SET message_seq = message_seq + 1
 *      WHERE id = $1 AND business_id = $2
 *     RETURNING message_seq
 *
 * issued inside the same transaction as the insert. The row lock Postgres takes
 * for that UPDATE is the whole mechanism: a second writer targeting the same
 * conversation blocks there until the first commits, so the two sequences are
 * distinct and ordered by commit, and `messages_conversation_id_sequence_key`
 * makes a bug in this function a constraint violation rather than a quietly
 * scrambled transcript.
 *
 * This is deliberately not a Postgres `SEQUENCE`: those are global, gappy, and
 * lock-free, which is the opposite of every property wanted here. It is also
 * not `SELECT max(sequence) + 1`, which is the read-then-write race it exists
 * to close.
 *
 * ## Relationship to ConversationLockService
 *
 * They solve adjacent problems and neither replaces the other.
 * `ConversationLockService` serializes *processing* — one AI turn at a time per
 * conversation — and lives in process memory, so it holds for one instance.
 * This holds in the database, across every writer and every process, and
 * serializes *storage*. A message can be stored correctly and still be
 * processed out of order, and vice versa.
 *
 * ## Duplicate suppression
 *
 * `messages_business_id_channel_account_id_external_id_key` is the backstop
 * behind `webhook_events(source, external_id)`. Two paths walk around that
 * wall: a `webhook-dlq` replay skips it on purpose (a delivery parked *after*
 * its `webhook_events` row was written would otherwise be discarded as its own
 * duplicate — the exact loss the DLQ exists to prevent), and the web-chat
 * socket gateway never had one.
 *
 * A collision here is not an error. The message is already stored, which is the
 * outcome the caller wanted; the second write is the redundant one. So the
 * constraint violation is caught, the stored row is read back, and the result
 * says `duplicate: true` — callers that would otherwise emit `message.received`
 * a second time can check it and stay quiet. Re-announcing a message the
 * pipeline has already answered means answering the customer twice.
 */

const logger = new Logger('MessageSequence');

/** Prisma unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * The subset of `PrismaService` this needs. Declared structurally so the
 * function can be handed a transaction client, and so tests can supply a stub
 * without constructing a Prisma client.
 */
export interface SequencedMessageClient {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  messages: { findFirst(args: unknown): Promise<messages | null> };
}

/** Everything about a message row except the position this assigns it. */
export type SequencedMessageData = Omit<Prisma.messagesUncheckedCreateInput, 'sequence'>;

export interface SequencedMessageResult {
  message: messages;
  /**
   * True when this exact (business, channel account, external id) was already
   * stored and the row returned is the earlier one. Nothing new was written.
   */
  duplicate: boolean;
}

/**
 * Store a message at the next position in its conversation.
 *
 * Throws whatever the insert throws, except a duplicate — see the note above.
 * A conversation that does not exist (or belongs to another tenant) fails on
 * the allocator's UPDATE with Prisma's `P2025`, which is the correct outcome: a
 * message with no conversation has no position to hold.
 */
export async function createSequencedMessage(
  prisma: SequencedMessageClient,
  data: SequencedMessageData,
): Promise<SequencedMessageResult> {
  try {
    const message = await prisma.$transaction(async (tx) => {
      // Claim first. The lock this takes is held for the rest of the
      // transaction, which is what serializes concurrent writers.
      const conversation = await tx.conversations.update({
        where: { id: data.conversation_id, business_id: data.business_id },
        data: { message_seq: { increment: 1 } },
        select: { message_seq: true },
      });

      return tx.messages.create({
        // `business_id` is already in `data`; naming it again changes nothing
        // at runtime and is deliberate for two readers. A person sees the write
        // is tenant-scoped without resolving what `data` holds, and
        // `service-tenant-scoping.spec.ts` — which asks of every write to a
        // tenant table whether anyone thought about the tenant — can only see
        // what the call site names.
        data: {
          ...data,
          business_id: data.business_id,
          sequence: conversation.message_seq,
        },
      });
    });

    return { message, duplicate: false };
  } catch (err) {
    if (!isDuplicate(err) || !data.external_id) throw err;

    const existing = await prisma.messages.findFirst({
      where: {
        business_id: data.business_id,
        channel_account_id: data.channel_account_id,
        external_id: data.external_id,
      },
    });

    // The row has to be there — the constraint just said so. If it is not, the
    // violation was on some other unique index and this is not our case to
    // swallow.
    if (!existing) throw err;

    logger.log(
      `Message ${data.external_id} on channel account ${data.channel_account_id} ` +
        `is already stored as ${existing.id} — not storing it again`,
    );
    return { message: existing, duplicate: true };
  }
}

function isDuplicate(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === UNIQUE_VIOLATION
  );
}
