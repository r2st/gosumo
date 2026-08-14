-- Migration: 0035_add_webhook_dead_letters
-- Webhook reliability — the dead-letter queue for inbound webhook deliveries.
--
-- webhook_dead_letters — an inbound webhook whose handler threw, parked for
-- retry with exponential backoff instead of being lost.
--
-- Why a separate table from `webhook_events`: that table is the *idempotency*
-- ledger, and its UNIQUE (source, external_id) is what makes a provider
-- redelivery a no-op. That is precisely why a failed delivery cannot be
-- recovered from it — the provider's own retry is swallowed as a duplicate,
-- so the first failure is permanent. This table is the *recovery* ledger, with
-- its own attempt counter, backoff schedule, and operator lifecycle.
--
-- business_id is nullable, mirroring webhook_events: a gateway webhook that
-- fails before its payment row can be read has no resolvable tenant. The RLS
-- policy below therefore hides those rows from tenant-scoped sessions — they
-- are reachable only by the app role (which bypasses RLS) through the retry
-- worker and the platform-wide backlog gauge, never by another business.

-- ─────────────────────────────────────────────
-- ENUM (shared with realty_dead_letters — see 0024)
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "DeadLetterStatus" AS ENUM ('PENDING', 'REPLAYED', 'RESOLVED', 'DISCARDED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- TABLE
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "webhook_dead_letters" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID,
    "webhook_event_id" UUID,
    "source" VARCHAR(50) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "external_id" VARCHAR(255) NOT NULL,
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT NOT NULL,
    "error_stack" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 6,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'PENDING',
    "next_retry_at" TIMESTAMPTZ,
    "last_attempt_at" TIMESTAMPTZ,
    "replayed_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,
    "resolution" TEXT,
    "correlation_id" VARCHAR(64),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_dead_letters_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEY
-- ─────────────────────────────────────────────

ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "webhook_dead_letters_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

-- One recovery row per provider event: a webhook that fails twice updates its
-- attempt count instead of stacking duplicates.
CREATE UNIQUE INDEX "webhook_dead_letters_source_external_id_key" ON "webhook_dead_letters"("source", "external_id");

-- The sweep that claims due retries reads exactly this pair.
CREATE INDEX "webhook_dead_letters_status_next_retry_at_idx" ON "webhook_dead_letters"("status", "next_retry_at");
CREATE INDEX "webhook_dead_letters_business_id_status_created_at_idx" ON "webhook_dead_letters"("business_id", "status", "created_at" DESC);
CREATE INDEX "webhook_dead_letters_business_id_source_event_type_idx" ON "webhook_dead_letters"("business_id", "source", "event_type");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- ─────────────────────────────────────────────

ALTER TABLE "webhook_dead_letters" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook_dead_letters_tenant_isolation" ON "webhook_dead_letters"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
