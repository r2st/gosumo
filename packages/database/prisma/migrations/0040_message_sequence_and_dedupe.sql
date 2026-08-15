-- Migration: 0040_message_sequence_and_dedupe
--
-- Gives every message a per-conversation arrival sequence, and makes a
-- duplicate inbound message impossible to store.
--
--
-- 1. messages.sequence — the total order
--
--   Reads are ordered `(created_at DESC, id DESC)` (see
--   `common/utils/message-order.ts`). That is a *stable* order but not the
--   *arrival* order: `created_at` defaults to `now()`, which in Postgres is the
--   transaction-start timestamp, so two inbound messages whose transactions
--   begin in the same microsecond compare equal — and the tie is then broken by
--   a v4 UUID, which carries no time information at all.
--
--   Concurrent inserts into one conversation are the ordinary case here, not
--   the pathological one: four channel adapters and a socket gateway all write
--   inbound messages, and a customer sending two lines in quick succession is
--   what people do. The consequences are documented at length in
--   `message-order.ts` — "book me for 2pm" / "no wait, 3pm" read backwards is a
--   different instruction, and a tie straddling the twentieth row silently
--   drops a message out of the AI context window.
--
--   `sequence` is claimed under a row lock (see 2) so it records the order the
--   writes actually committed in, and a gap in it is visible where a tie is not.
--
--
-- 2. conversations.message_seq — the allocator
--
--   A writer claims the next value with
--
--     UPDATE conversations SET message_seq = message_seq + 1
--      WHERE id = $1 AND business_id = $2
--     RETURNING message_seq
--
--   in the same transaction as the message insert. The row lock Postgres takes
--   for that UPDATE is what serializes two concurrent inserts into one
--   conversation, which is why this is a counter on the parent row rather than
--   a Postgres SEQUENCE (global, gappy, and lock-free — i.e. exactly not what
--   is wanted) or a `MAX(sequence)+1` subquery (read-then-write, races).
--
--   Distinct from `message_count`, which is a best-effort denormalized tally
--   for display. This one is never decremented and never repaired.
--
--
-- 3. The two unique indexes
--
--   `(conversation_id, sequence)` is what makes the order trustworthy rather
--   than merely recorded: without it a bug in the allocator produces two
--   messages claiming position 7 and no reader can tell.
--
--   `(business_id, channel_account_id, external_id)` is duplicate suppression
--   at the row that matters. `webhook_events(source, external_id)` already
--   turns a provider's retry away at the door, but a `webhook-dlq` replay
--   deliberately skips that wall — a delivery parked after its `webhook_events`
--   row was written would otherwise be discarded as its own duplicate, which is
--   the message loss the DLQ exists to fix — and the web-chat socket gateway
--   has no wall at all. `external_id` is NULL on outbound and system messages;
--   Postgres treats NULLs as distinct in a unique index, so those are
--   unconstrained, which is correct: they have no channel-assigned identity to
--   deduplicate on.
--
--   Verified against production before writing this: 68 messages, 0 duplicate
--   groups. The guard below is for every other environment.

BEGIN;

-- ── Guard ────────────────────────────────────────────────────────────────
-- A pre-existing duplicate would fail the CREATE UNIQUE INDEX below with
-- Postgres' own message, which names the index and not the problem. Fail
-- earlier and say what to do instead. Messages are append-only, so resolving
-- this is a deliberate act by an operator, not something a migration may do.
DO $$
DECLARE
  dup_groups BIGINT;
BEGIN
  SELECT count(*) INTO dup_groups
    FROM (
      SELECT 1
        FROM messages
       WHERE external_id IS NOT NULL
       GROUP BY business_id, channel_account_id, external_id
      HAVING count(*) > 1
    ) d;

  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'Cannot add the messages dedupe index: % duplicate (business_id, channel_account_id, external_id) group(s) already exist. '
      'List them with: SELECT business_id, channel_account_id, external_id, count(*) FROM messages WHERE external_id IS NOT NULL '
      'GROUP BY 1,2,3 HAVING count(*) > 1; then decide per group which row is canonical. messages is append-only, so this '
      'migration will not choose for you.', dup_groups;
  END IF;
END $$;

-- ── 1. The allocator ─────────────────────────────────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS message_seq INTEGER NOT NULL DEFAULT 0;

-- ── 2. The sequence column, backfilled ───────────────────────────────────
-- Added nullable so the backfill has somewhere to land, then made NOT NULL.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sequence INTEGER;

-- Existing rows get the best order that can still be recovered, which is the
-- same one every reader has been using: (created_at, id). For same-microsecond
-- ties that is an arbitrary choice, but it is the *already agreed* arbitrary
-- choice, so no history changes order as a result of this migration.
UPDATE messages m
   SET sequence = ordered.rn
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY conversation_id
             ORDER BY created_at ASC, id ASC
           ) AS rn
      FROM messages
  ) ordered
 WHERE m.id = ordered.id
   AND m.sequence IS NULL;

ALTER TABLE messages
  ALTER COLUMN sequence SET NOT NULL;

-- Point the allocator at the end of what was just backfilled, so the next
-- claim continues the run rather than colliding with it.
UPDATE conversations c
   SET message_seq = COALESCE(
     (SELECT max(m.sequence) FROM messages m WHERE m.conversation_id = c.id),
     0
   );

-- ── 3. The constraints ───────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_id_sequence_key
  ON messages (conversation_id, sequence);

CREATE UNIQUE INDEX IF NOT EXISTS messages_business_id_channel_account_id_external_id_key
  ON messages (business_id, channel_account_id, external_id);

COMMIT;
