-- Migration: 0026_add_realty_billing_compliance
-- GoSumo Realty — Pricing tier enforcement (§9) + DPDPA compliance (§21).
--
-- Tables:
--   business_subscriptions       — one row per business: pricing tier + live usage counters
--   consent_logs                 — append-mostly DPDPA consent ledger (grant/revoke)
--   realty_compliance_settings   — per-business retention window + data-processor agreement
--
-- Every table is tenant-scoped on business_id and protected by Row-Level Security
-- (app.current_business_id session var), consistent with 0001_enable_rls.sql.
-- consent_logs is append-mostly: DELETE is blocked (rule), UPDATE is allowed only
-- so a granted consent can be stamped with revoked_at.

-- ─────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "RealtyPlan" AS ENUM ('SOLO', 'TEAM', 'DEVELOPER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ConsentType" AS ENUM ('PROCESSING', 'MARKETING', 'EXCHANGE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "business_subscriptions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "plan" "RealtyPlan" NOT NULL DEFAULT 'SOLO',
    "monthly_lead_limit" INTEGER,
    "seat_limit" INTEGER,
    "plan_price_paise" INTEGER NOT NULL DEFAULT 399900,
    "overage_rate_paise" INTEGER NOT NULL DEFAULT 800,
    "billing_cycle_start" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leads_used_this_cycle" INTEGER NOT NULL DEFAULT 0,
    "overage_leads_this_cycle" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "consent_logs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "consent_type" "ConsentType" NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,
    "channel" VARCHAR(30) NOT NULL DEFAULT 'SYSTEM',
    "message_id" UUID,
    "source" VARCHAR(80),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_compliance_settings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "retention_months" INTEGER NOT NULL DEFAULT 24,
    "data_processor_agreement" BOOLEAN NOT NULL DEFAULT false,
    "data_processor_agreed_at" TIMESTAMPTZ,
    "last_retention_run_at" TIMESTAMPTZ,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_compliance_settings_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────────

ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "consent_logs" ADD CONSTRAINT "consent_logs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_compliance_settings" ADD CONSTRAINT "realty_compliance_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- UNIQUE CONSTRAINTS + INDEXES
-- ─────────────────────────────────────────────

CREATE UNIQUE INDEX "business_subscriptions_business_id_key" ON "business_subscriptions"("business_id");
CREATE INDEX "business_subscriptions_plan_idx" ON "business_subscriptions"("plan");

CREATE INDEX "consent_logs_business_id_phone_consent_type_idx" ON "consent_logs"("business_id", "phone", "consent_type");
CREATE INDEX "consent_logs_business_id_consent_type_granted_at_idx" ON "consent_logs"("business_id", "consent_type", "granted_at" DESC);

CREATE UNIQUE INDEX "realty_compliance_settings_business_id_key" ON "realty_compliance_settings"("business_id");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- ─────────────────────────────────────────────

ALTER TABLE "business_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_compliance_settings" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "business_subscriptions_tenant_isolation" ON "business_subscriptions"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "consent_logs_tenant_isolation" ON "consent_logs"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_compliance_settings_tenant_isolation" ON "realty_compliance_settings"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

-- ─────────────────────────────────────────────
-- APPEND-MOSTLY GUARANTEE for consent_logs (DPDPA auditability)
-- A consent record is never erased. UPDATE is permitted (to stamp revoked_at on
-- withdrawal); DELETE is blocked so the ledger stays complete for audit.
-- ─────────────────────────────────────────────

CREATE RULE "consent_logs_no_delete" AS ON DELETE TO "consent_logs" DO INSTEAD NOTHING;
