-- Migration: 0042_segmentation_routing_and_message_search
--
-- Three additive changes, all columns and indexes on existing tables — no new
-- table, so no new RLS policy is needed:
--
--   1. `segments` gains routing: a stored decision about whether the AI may
--      answer the contacts a segment matches, and (optionally) which
--      confidence bands and which agent apply to them.
--   2. `messages` gains a generated `search_vector`, so conversation search is
--      a real full-text lookup rather than an unanchored ILIKE.
--   3. Two btree indexes for the conversation-quality aggregates
--      (resolution rate / FCR / CSAT proxy), which filter on `resolved_at`.
--
-- Nothing is dropped and no existing column changes type.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Segment-based routing
-- ─────────────────────────────────────────────────────────────────────────────
--
-- INHERIT is the default and means "this segment expresses no opinion" — the
-- tenant's own thresholds decide, exactly as before this migration. It exists
-- as an explicit value rather than as NULL so the resolver has one thing to
-- compare and a segment can be switched back to neutral without losing the
-- rest of its routing configuration.

-- CreateEnum
CREATE TYPE "SegmentRoutingMode" AS ENUM ('INHERIT', 'AI_ONLY', 'AI_FIRST', 'HUMAN_ONLY');

-- AlterTable
ALTER TABLE "segments"
  ADD COLUMN "routing_mode" "SegmentRoutingMode" NOT NULL DEFAULT 'INHERIT',
  ADD COLUMN "routing_priority" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "auto_execute_threshold" INTEGER,
  ADD COLUMN "draft_review_threshold" INTEGER,
  ADD COLUMN "routing_assignee_id" UUID;

-- The resolver reads every active segment that expresses a routing opinion,
-- highest priority first, on the inbound path of every message from a known
-- client. Without this it re-scanned the tenant's whole segment list each time.
CREATE INDEX "segments_business_id_routing_mode_routing_priority_idx"
  ON "segments" ("business_id", "routing_mode", "routing_priority" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Message full-text search
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `messages.text_content` already carries a trigram GIN index (migration 0034),
-- which makes `ILIKE '%term%'` survivable. It is still the wrong tool for a
-- search box: trigram similarity has no notion of a word, so "pay" matches
-- "repayment", multi-word queries degrade into three independent substring
-- scans, and there is no ranking to order the results by.
--
-- The text-search config is 'simple' rather than 'english' on purpose. This is
-- an Indian multi-channel inbox: a single conversation routinely mixes English,
-- transliterated Hindi and Devanagari. English stemming would mangle the first,
-- do nothing for the second, and silently drop the third's tokens as
-- non-words — while 'simple' lowercases and splits on word boundaries for all
-- three, which is the behaviour a search box is expected to have. It also keeps
-- stop-words, so "the offer" finds a message about "the offer".
--
-- GENERATED ... STORED rather than a trigger: the column cannot drift from the
-- text it indexes, there is no backfill step, and `messages` is append-only so
-- nothing ever pays the update cost. It does rewrite the table once when this
-- statement runs, holding an ACCESS EXCLUSIVE lock for the duration — that is
-- seconds at this deployment's volume, but on a large table run it in a
-- maintenance window.

-- Composite (tenant, vector) GIN. btree_gin is what lets a plain scalar sit in
-- a GIN index next to a tsvector; without it the tenant filter and the text
-- match are two separate indexes joined by a BitmapAnd, which reads every
-- matching row in the *platform* for a common term before discarding the other
-- tenants' rows. Tenant isolation is enforced in the WHERE clause either way —
-- this is about not making one tenant's search read another tenant's rows.
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- AlterTable
ALTER TABLE "messages"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce("text_content", ''))) STORED;

-- CreateIndex
CREATE INDEX "messages_business_id_search_vector_idx"
  ON "messages" USING GIN ("business_id", "search_vector");

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Conversation-quality aggregates
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Resolution rate, first-contact resolution and the CSAT proxy all scope to
-- "conversations RESOLVED within [from, to)". The existing
-- (business_id, status, last_message_at) index leads with the right two columns
-- and then sorts on the wrong one, so every one of these read the tenant's
-- entire resolved history and filtered it in memory.
CREATE INDEX "conversations_business_id_status_resolved_at_idx"
  ON "conversations" ("business_id", "status", "resolved_at" DESC);

-- The CSAT proxy's explicit arm reads submitted scores only. Partial, because
-- the overwhelming majority of conversations never receive one and indexing
-- those rows would triple the index for no reader.
CREATE INDEX "conversations_business_id_csat_submitted_at_idx"
  ON "conversations" ("business_id", "csat_submitted_at" DESC)
  WHERE "csat_submitted_at" IS NOT NULL;
