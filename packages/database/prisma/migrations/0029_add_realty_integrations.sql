-- Migration: 0029_add_realty_integrations
-- GoSumo Realty — Phase 5 outbound integrations.
--
-- Tables:
--   realty_integration_connections — one row per (business, provider): Google Sheets
--                                    export + Indian CRM push (Sell.Do/LeadSquared/Privyr)
--   realty_eoi_requests            — Expression-of-Interest (टोकन) payment requests,
--                                    broker-approved before a Razorpay link is sent
--   realty_parser_health_checks    — platform-ops snapshots of portal-email parser probes
--
-- Tenant tables (connections, eoi) are business_id-scoped and protected by RLS
-- (app.current_business_id), consistent with 0001_enable_rls.sql. The parser
-- health table is platform-ops (global parser code, no tenant data) → no RLS.

-- ─────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "RealtyIntegrationProvider" AS ENUM ('GOOGLE_SHEETS', 'SELLDO', 'LEADSQUARED', 'PRIVYR');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RealtyIntegrationStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'ERROR');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RealtyEoiStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'LINK_SENT', 'PAID', 'EXPIRED', 'REJECTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RealtyParserHealthStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "realty_integration_connections" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "provider" "RealtyIntegrationProvider" NOT NULL,
    "status" "RealtyIntegrationStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "config" JSONB NOT NULL DEFAULT '{}',
    "external_ref" VARCHAR(255),
    "last_sync_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "sync_count" INTEGER NOT NULL DEFAULT 0,
    "pushed_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_integration_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_eoi_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "unit_id" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "token_label" VARCHAR(60) NOT NULL DEFAULT 'टोकन',
    "status" "RealtyEoiStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "payment_link_id" VARCHAR(120),
    "payment_link_url" TEXT,
    "gateway_payment_id" VARCHAR(120),
    "requested_by" UUID,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "paid_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "reject_reason" TEXT,
    "notes" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_eoi_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_parser_health_checks" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "portal" VARCHAR(40) NOT NULL,
    "status" "RealtyParserHealthStatus" NOT NULL,
    "sample_count" INTEGER NOT NULL,
    "pass_count" INTEGER NOT NULL,
    "fail_count" INTEGER NOT NULL,
    "empty_count" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB NOT NULL DEFAULT '{}',
    "checked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_parser_health_checks_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────────

ALTER TABLE "realty_integration_connections" ADD CONSTRAINT "realty_integration_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_eoi_requests" ADD CONSTRAINT "realty_eoi_requests_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- UNIQUE CONSTRAINTS + INDEXES
-- ─────────────────────────────────────────────

CREATE UNIQUE INDEX "uq_realty_integration_business_provider" ON "realty_integration_connections"("business_id", "provider");
CREATE INDEX "realty_integration_connections_business_id_status_idx" ON "realty_integration_connections"("business_id", "status");
CREATE INDEX "realty_integration_connections_provider_status_idx" ON "realty_integration_connections"("provider", "status");
CREATE INDEX "realty_integration_connections_deleted_at_idx" ON "realty_integration_connections"("deleted_at");

CREATE INDEX "realty_eoi_requests_business_id_status_idx" ON "realty_eoi_requests"("business_id", "status");
CREATE INDEX "realty_eoi_requests_business_id_lead_id_idx" ON "realty_eoi_requests"("business_id", "lead_id");
CREATE INDEX "realty_eoi_requests_business_id_payment_link_id_idx" ON "realty_eoi_requests"("business_id", "payment_link_id");

CREATE INDEX "realty_parser_health_checks_portal_checked_at_idx" ON "realty_parser_health_checks"("portal", "checked_at" DESC);
CREATE INDEX "realty_parser_health_checks_status_checked_at_idx" ON "realty_parser_health_checks"("status", "checked_at" DESC);

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- parser health is platform-ops (no tenant data) → intentionally NOT RLS-guarded.
-- ─────────────────────────────────────────────

ALTER TABLE "realty_integration_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_eoi_requests" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "realty_integration_connections_tenant_isolation" ON "realty_integration_connections"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_eoi_requests_tenant_isolation" ON "realty_eoi_requests"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
