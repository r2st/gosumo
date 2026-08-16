-- Migration: 0043_export_archives_tagging_templates_merge
--
-- R84. Five additive changes; nothing is dropped and no existing column
-- changes type.
--
--   1. `data_export_jobs`               — asynchronous subject-access archives
--   2. `conversation_tag_assignments`   — provenance for conversation tags
--   3. `canned_responses` + columns     — variables and an approval workflow
--   4. `contact_merges`                 — audit + undo record for a merge
--   5. `business_notification_settings` — operator-facing notification rules
--
-- Four new tables, so four new RLS policies at the bottom.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Subject-access export archives
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "DataExportJobStatus" AS ENUM ('PENDING', 'BUILDING', 'READY', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DataExportArchiveFormat" AS ENUM ('JSON', 'NDJSON');

-- CreateTable
CREATE TABLE "data_export_jobs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "status" "DataExportJobStatus" NOT NULL DEFAULT 'PENDING',
    "format" "DataExportArchiveFormat" NOT NULL DEFAULT 'JSON',
    "token_hash" VARCHAR(64) NOT NULL,
    "payload" BYTEA,
    "byte_size" INTEGER NOT NULL DEFAULT 0,
    "checksum" VARCHAR(64),
    "sections" JSONB NOT NULL DEFAULT '{}',
    "truncated" JSONB NOT NULL DEFAULT '[]',
    "requested_by" UUID,
    "requested_by_email" VARCHAR(320),
    "request_ip" VARCHAR(64),
    "correlation_id" VARCHAR(64),
    "error" TEXT,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "downloaded_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "data_export_jobs_pkey" PRIMARY KEY ("id")
);

-- The download route resolves a job by token alone — the recipient of a
-- subject-access link carries no tenant context — so this index is what makes
-- that lookup a single-row seek rather than a scan of every tenant's exports.
CREATE UNIQUE INDEX "uq_data_export_token_hash" ON "data_export_jobs" ("token_hash");
CREATE INDEX "data_export_jobs_business_id_client_id_created_at_idx"
    ON "data_export_jobs" ("business_id", "client_id", "created_at" DESC);
CREATE INDEX "data_export_jobs_business_id_status_created_at_idx"
    ON "data_export_jobs" ("business_id", "status", "created_at" DESC);
-- The expiry sweep starts without a business_id.
CREATE INDEX "data_export_jobs_status_expires_at_idx"
    ON "data_export_jobs" ("status", "expires_at");

ALTER TABLE "data_export_jobs"
    ADD CONSTRAINT "data_export_jobs_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "data_export_jobs"
    ADD CONSTRAINT "data_export_jobs_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Conversation tag provenance
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `conversations.tags` stays the array the inbox filters on (GIN-indexed, read
-- on every list query). This table records how each tag got there, which the
-- array cannot express, and in particular keeps a tombstone row when a human
-- removes an AI tag so the auto-tagger does not re-apply it on the next turn.

-- CreateEnum
CREATE TYPE "ConversationTagSource" AS ENUM ('AI', 'MANUAL', 'RULE');

-- CreateTable
CREATE TABLE "conversation_tag_assignments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "tag" VARCHAR(100) NOT NULL,
    "source" "ConversationTagSource" NOT NULL,
    "confidence" DECIMAL(5,4),
    "model" VARCHAR(100),
    "rationale" TEXT,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "suppressed_at" TIMESTAMPTZ,
    "suppressed_by" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "conversation_tag_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_conv_tag_assignment"
    ON "conversation_tag_assignments" ("conversation_id", "tag");
CREATE INDEX "conversation_tag_assignments_business_id_tag_suppressed_idx"
    ON "conversation_tag_assignments" ("business_id", "tag", "suppressed");
CREATE INDEX "conversation_tag_assignments_business_id_source_created_at_idx"
    ON "conversation_tag_assignments" ("business_id", "source", "created_at" DESC);

ALTER TABLE "conversation_tag_assignments"
    ADD CONSTRAINT "conversation_tag_assignments_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_tag_assignments"
    ADD CONSTRAINT "conversation_tag_assignments_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Canned-response variables + approval workflow
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "CannedResponseApprovalStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "canned_responses"
    ADD COLUMN "variables" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "approval_status" "CannedResponseApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN "submitted_by" UUID,
    ADD COLUMN "submitted_at" TIMESTAMPTZ,
    ADD COLUMN "reviewed_by" UUID,
    ADD COLUMN "reviewed_at" TIMESTAMPTZ,
    ADD COLUMN "review_note" TEXT;

-- Backfill. The column default is DRAFT, which is right for a response created
-- from now on and wrong for every row that already exists: those were written
-- and put into service before any review step existed, and leaving them at the
-- default would withdraw a tenant's entire canned-response library the moment
-- this migration lands, to enforce an approval nobody was ever asked for.
UPDATE "canned_responses"
   SET "approval_status" = 'APPROVED',
       "reviewed_at" = COALESCE("updated_at", CURRENT_TIMESTAMP)
 WHERE "approval_status" = 'DRAFT';

CREATE INDEX "canned_responses_business_id_approval_status_updated_at_idx"
    ON "canned_responses" ("business_id", "approval_status", "updated_at" DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Contact merges
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "ContactMergeStrategy" AS ENUM ('PREFER_SURVIVOR', 'PREFER_DUPLICATE', 'PREFER_MOST_RECENT', 'MANUAL');

-- CreateTable
CREATE TABLE "contact_merges" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "survivor_id" UUID NOT NULL,
    "duplicate_id" UUID NOT NULL,
    "strategy" "ContactMergeStrategy" NOT NULL,
    "field_resolutions" JSONB NOT NULL DEFAULT '{}',
    "moved" JSONB NOT NULL DEFAULT '{}',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "match_reason" VARCHAR(255),
    "match_score" DECIMAL(5,4),
    "performed_by" UUID,
    "performed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_at" TIMESTAMPTZ,
    "reverted_by" UUID,

    CONSTRAINT "contact_merges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contact_merges_business_id_performed_at_idx"
    ON "contact_merges" ("business_id", "performed_at" DESC);
CREATE INDEX "contact_merges_business_id_survivor_id_idx"
    ON "contact_merges" ("business_id", "survivor_id");
CREATE INDEX "contact_merges_business_id_duplicate_id_idx"
    ON "contact_merges" ("business_id", "duplicate_id");

ALTER TABLE "contact_merges"
    ADD CONSTRAINT "contact_merges_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Per-business notification settings
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Distinct from `notification_preferences`, which is per-customer and governs
-- what GoSumo sends TO a customer. This governs what it sends to the business's
-- own team. Merging them would let a customer's marketing opt-out silence an
-- SLA-breach alert to the operator.

-- CreateEnum
CREATE TYPE "NotificationDigestFrequency" AS ENUM ('OFF', 'HOURLY', 'DAILY', 'WEEKLY');

-- CreateTable
CREATE TABLE "business_notification_settings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "realtime_enabled" BOOLEAN NOT NULL DEFAULT true,
    "realtime_alerts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "realtime_min_severity" VARCHAR(20) NOT NULL DEFAULT 'WARNING',
    "digest_frequency" "NotificationDigestFrequency" NOT NULL DEFAULT 'DAILY',
    "digest_hour" SMALLINT NOT NULL DEFAULT 9,
    "digest_day_of_week" SMALLINT NOT NULL DEFAULT 1,
    "digest_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "digest_skip_when_empty" BOOLEAN NOT NULL DEFAULT true,
    "quiet_hours_start" SMALLINT,
    "quiet_hours_end" SMALLINT,
    "quiet_hours_override_severity" VARCHAR(20),
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    "fallback_email" VARCHAR(320),
    "last_digest_sent_at" TIMESTAMPTZ,
    "next_digest_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "business_notification_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_business_notification_settings"
    ON "business_notification_settings" ("business_id");
-- The digest sweep starts without a business_id.
CREATE INDEX "business_notification_settings_digest_frequency_next_digest_idx"
    ON "business_notification_settings" ("digest_frequency", "next_digest_at");

ALTER TABLE "business_notification_settings"
    ADD CONSTRAINT "business_notification_settings_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- ─────────────────────────────────────────────

ALTER TABLE "data_export_jobs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "data_export_jobs_tenant_isolation" ON "data_export_jobs"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

ALTER TABLE "conversation_tag_assignments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "conversation_tag_assignments_tenant_isolation" ON "conversation_tag_assignments"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

ALTER TABLE "contact_merges" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contact_merges_tenant_isolation" ON "contact_merges"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

ALTER TABLE "business_notification_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "business_notification_settings_tenant_isolation" ON "business_notification_settings"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
