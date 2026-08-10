-- Migration: 0024_add_realty_pilot
-- GoSumo Realty — Phase 8 (Pilot Migration).
--
-- Tables (blueprint §22 "8-week build" / §24 launch gate):
--   realty_migration_runs     — audit of each pilot data import (leads/contacts/inventory)
--   realty_autonomy_events     — append-only ledger of evidence-driven autonomy-dial changes
--   realty_no_ship_incidents   — append-only ledger of no-ship violations (launch-gate hard fail)
--
-- Every table is tenant-scoped on business_id and protected by Row-Level Security
-- (app.current_business_id session var), consistent with 0001_enable_rls.sql.
-- The two ledgers are append-only: UPDATE/DELETE are blocked by rules, mirroring
-- the audit_logs guarantees (root rules #5 / #7).

-- ─────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "MigrationKind" AS ENUM ('LEADS', 'CONTACTS', 'INVENTORY');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "MigrationStatus" AS ENUM ('VALIDATED', 'COMMITTED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AutonomyDirection" AS ENUM ('OPEN', 'HOLD', 'CLOSE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AutonomyActorType" AS ENUM ('HUMAN', 'AI');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "NoShipKind" AS ENUM ('UNVERIFIED_PRICE', 'STALE_AVAILABILITY', 'OPTED_OUT_SEND', 'RERA_CLAIM', 'CROSS_BUYER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "realty_migration_runs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "kind" "MigrationKind" NOT NULL,
    "status" "MigrationStatus" NOT NULL DEFAULT 'VALIDATED',
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "created_count" INTEGER NOT NULL DEFAULT 0,
    "merged_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "summary" JSONB NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_migration_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_autonomy_events" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "direction" "AutonomyDirection" NOT NULL,
    "from_level" "AutonomyLevel" NOT NULL,
    "to_level" "AutonomyLevel" NOT NULL,
    "from_threshold" INTEGER NOT NULL,
    "to_threshold" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "reason" VARCHAR(500) NOT NULL,
    "actor_type" "AutonomyActorType" NOT NULL DEFAULT 'HUMAN',
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_autonomy_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_no_ship_incidents" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "kind" "NoShipKind" NOT NULL,
    "lead_id" UUID,
    "conversation_id" UUID,
    "detail" VARCHAR(500) NOT NULL,
    "source" VARCHAR(80) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_no_ship_incidents_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────────

ALTER TABLE "realty_migration_runs" ADD CONSTRAINT "realty_migration_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_autonomy_events" ADD CONSTRAINT "realty_autonomy_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_no_ship_incidents" ADD CONSTRAINT "realty_no_ship_incidents_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE INDEX "realty_migration_runs_business_id_kind_created_at_idx" ON "realty_migration_runs"("business_id", "kind", "created_at" DESC);
CREATE INDEX "realty_migration_runs_business_id_status_idx" ON "realty_migration_runs"("business_id", "status");
CREATE INDEX "realty_migration_runs_deleted_at_idx" ON "realty_migration_runs"("deleted_at");

CREATE INDEX "realty_autonomy_events_business_id_created_at_idx" ON "realty_autonomy_events"("business_id", "created_at" DESC);

CREATE INDEX "realty_no_ship_incidents_business_id_created_at_idx" ON "realty_no_ship_incidents"("business_id", "created_at" DESC);
CREATE INDEX "realty_no_ship_incidents_business_id_kind_idx" ON "realty_no_ship_incidents"("business_id", "kind");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- ─────────────────────────────────────────────

ALTER TABLE "realty_migration_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_autonomy_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_no_ship_incidents" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "realty_migration_runs_tenant_isolation" ON "realty_migration_runs"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_autonomy_events_tenant_isolation" ON "realty_autonomy_events"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_no_ship_incidents_tenant_isolation" ON "realty_no_ship_incidents"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

-- ─────────────────────────────────────────────
-- APPEND-ONLY GUARANTEE for the two ledgers (mirrors audit_logs, root rule #7)
-- The autonomy + no-ship ledgers are the evidence trail behind launch/no-ship
-- decisions — they must never be rewritten or erased.
-- ─────────────────────────────────────────────

CREATE RULE "realty_autonomy_events_no_update" AS ON UPDATE TO "realty_autonomy_events" DO INSTEAD NOTHING;
CREATE RULE "realty_autonomy_events_no_delete" AS ON DELETE TO "realty_autonomy_events" DO INSTEAD NOTHING;

CREATE RULE "realty_no_ship_incidents_no_update" AS ON UPDATE TO "realty_no_ship_incidents" DO INSTEAD NOTHING;
CREATE RULE "realty_no_ship_incidents_no_delete" AS ON DELETE TO "realty_no_ship_incidents" DO INSTEAD NOTHING;
