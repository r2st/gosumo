-- Migration: 0034_add_search_and_inbox_indexes
-- Index the three queries that were reading whole tables, plus two smaller ones.
--
-- Every statement here was chosen from an EXPLAIN (ANALYZE, BUFFERS) run against
-- a synthetic copy of the schema at 200k conversations / 750k messages / 120k
-- clients, spread over 20 tenants with one large one. Before/after, buffers read
-- and wall time for the query as the repository actually spells it:
--
--   conversation inbox, no status filter    5,482 buf  18.4 ms  ->    364 buf  0.17 ms
--   message search, term matches nothing   22,597 buf 117.2 ms  ->     75 buf  1.57 ms
--   contact search, term matches nothing    2,814 buf 103.8 ms  ->     65 buf  0.28 ms
--   conversation search, no match           5,406 buf  38.4 ms  ->     16 buf  0.16 ms
--   findReplies (metadata threading)       22,670 buf  59.6 ms  ->      6 buf  0.39 ms
--   snooze-wake sweep                       4,083 buf   8.9 ms  ->    103 buf  0.40 ms
--
-- The searches are the interesting case. Measured with a term that matches many
-- rows they looked fine — the LIMIT filled before the scan got far — so the cost
-- only shows up on a term that matches nothing, which is the ordinary outcome of
-- typing into a search box. The message-search figure is the one that matters
-- most: `messages` is the largest table in the schema and the only append-only
-- one, so its scan cost grows without bound.
--
-- Index names match what `prisma migrate diff` emits for the corresponding
-- @@index entries in schema.prisma, so the two stay in sync. The one exception
-- is the threading index, which Prisma cannot express (it indexes a JSONB
-- expression, not a column) and so lives only here.
--
-- Deliberately not added:
--   notifications / orders / payments (business_id, created_at)
--     Same "leading column then sort" shape as the inbox index below, but these
--     are back-office list screens, not the product's primary view. Revisit if
--     they show up in slow-query logs.
--   messages(business_id, conversation_id, created_at)
--     conversation_id is already selective enough on its own; the existing
--     (conversation_id, created_at DESC) index serves the conversation view in
--     ~15 buffers.
--
-- Plain CREATE INDEX, matching every migration before this one. The GIN builds
-- take a few seconds on the volumes above and hold a SHARE lock for that time,
-- which blocks writes to the table. On a live database run them as CREATE INDEX
-- CONCURRENTLY instead — that form cannot run inside a transaction, so issue it
-- outside any wrapping BEGIN/COMMIT.

-- Trigram support for unanchored ILIKE. No btree index can serve `%term%`,
-- which is the pattern all three search endpoints build.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Conversation inbox ───────────────────────────────────────────────────────
-- The default inbox view filters only on business_id and orders by
-- last_message_at. conversations_business_id_status_last_message_at_idx cannot
-- serve it: status sits between the filter and the sort column, so the planner
-- could seek to the tenant but then had to sort every one of its conversations
-- to return the first 20. This is the most-loaded screen in the product.
CREATE INDEX IF NOT EXISTS "conversations_business_id_last_message_at_idx"
    ON "conversations"("business_id", "last_message_at" DESC);

-- The snooze-wake job filters (business_id, status='SNOOZED', snoozed_until <=
-- now) and orders by snoozed_until. The status index stops one column short, so
-- the job bitmap-scanned every snoozed conversation and top-N sorted it to take
-- one capped batch.
CREATE INDEX IF NOT EXISTS "conversations_business_id_status_snoozed_until_idx"
    ON "conversations"("business_id", "status", "snoozed_until");

-- ── Free-text search ─────────────────────────────────────────────────────────
-- messages.search: text_content ILIKE '%term%', restricted to TEXT messages.
CREATE INDEX IF NOT EXISTS "messages_text_content_idx"
    ON "messages" USING GIN ("text_content" gin_trgm_ops);

-- conversation.list search: subject OR current_topic ILIKE '%term%'. One index
-- per column so the planner can BitmapOr them.
CREATE INDEX IF NOT EXISTS "conversations_subject_idx"
    ON "conversations" USING GIN ("subject" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "conversations_current_topic_idx"
    ON "conversations" USING GIN ("current_topic" gin_trgm_ops);

-- contact.findMany search: name OR email OR phone ILIKE '%term%'. Note this one
-- was scanning the *whole* clients table rather than the caller's slice of it,
-- because the OR sat alongside the business_id filter rather than under it.
CREATE INDEX IF NOT EXISTS "clients_name_idx"
    ON "clients" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "clients_email_idx"
    ON "clients" USING GIN ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "clients_phone_idx"
    ON "clients" USING GIN ("phone" gin_trgm_ops);

-- ── Message threading ────────────────────────────────────────────────────────
-- MessageRepository.findReplies matches a pointer inside the metadata document,
-- which Prisma emits as `metadata #>> '{reply_to_message_id}'`. The expression
-- has to be written exactly that way for the planner to match the index — the
-- equivalent `metadata ->> 'reply_to_message_id'` is a different expression and
-- silently fails to match, leaving the sequential scan in place.
--
-- Partial, because only a small minority of messages are replies: an equality
-- on the expression implies the IS NOT NULL predicate, so the planner still
-- uses it, at a fraction of the size (2.9 MB vs 7.6 MB on the sample above,
-- and the real ratio is better — the sample over-represents replies).
CREATE INDEX IF NOT EXISTS "idx_messages_reply_to_message_id"
    ON "messages" ((metadata #>> '{reply_to_message_id}'))
    WHERE metadata #>> '{reply_to_message_id}' IS NOT NULL;
