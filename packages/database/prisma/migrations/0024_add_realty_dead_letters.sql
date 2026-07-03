-- Migration: 0024_add_realty_dead_letters
-- GoSumo Realty — Phase 7 (Hardening): the dead-letter queue.
--
-- realty_dead_letters — a realty operation that exhausted its retries. Captured
-- (never silently dropped) so the operator can inspect and deterministically
-- replay it during the 7-day unattended soak on shadow traffic.
--
-- Tenant-scoped on business_id and protected by Row-Level Security
-- (app.current_business_id session var), consistent with 0001_enable_rls.sql.

-- ─────────────────────────────────────────────
-- ENUM
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "DeadLetterStatus" AS ENUM ('PENDING', 'REPLAYED', 'RESOLVED', 'DISCARDED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- TABLE
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "realty_dead_letters" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "source" VARCHAR(80) NOT NULL,
    "operation" VARCHAR(120) NOT NULL,
    "payload" JSONB NOT NULL,
    "error_message" TEXT NOT NULL,
    "error_stack" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'PENDING',
    "resolution" TEXT,
    "correlation_id" VARCHAR(64),
    "lead_id" UUID,
    "conversation_id" UUID,
    "replayed_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_dead_letters_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEY
-- ─────────────────────────────────────────────

ALTER TABLE "realty_dead_letters" ADD CONSTRAINT "realty_dead_letters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE INDEX "realty_dead_letters_business_id_status_created_at_idx" ON "realty_dead_letters"("business_id", "status", "created_at" DESC);
CREATE INDEX "realty_dead_letters_business_id_source_operation_idx" ON "realty_dead_letters"("business_id", "source", "operation");
CREATE INDEX "realty_dead_letters_business_id_lead_id_idx" ON "realty_dead_letters"("business_id", "lead_id");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- ─────────────────────────────────────────────

ALTER TABLE "realty_dead_letters" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "realty_dead_letters_tenant_isolation" ON "realty_dead_letters"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
