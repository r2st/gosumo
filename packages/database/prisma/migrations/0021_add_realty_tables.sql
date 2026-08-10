-- Migration: 0021_add_realty_tables
-- GoSumo Realty — the AI Lead Manager + inventory grounding layer.
--
-- Adds the four Phase-1 domain tables (blueprint §14):
--   realty_leads     — the central lead entity (BLTC profile, attribution, stages, memory)
--   realty_projects  — verified projects (the sole ground truth the AI may quote)
--   realty_units     — sellable units with availability freshness (24h rule)
--   realty_assets    — pre-uploaded verified media (versioned to block stale price sheets)
--
-- Every table is tenant-scoped on business_id and protected by Row-Level Security
-- (app.current_business_id session var), consistent with 0001_enable_rls.sql.

-- ─────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "LeadSource" AS ENUM ('PORTAL', 'META_LEAD_AD', 'CTWA', 'IVR', 'REFERRAL', 'CSV', 'WALK_IN', 'EXCHANGE_INBOUND', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeadTemperature" AS ENUM ('HOT', 'WARM', 'COLD', 'JUNK');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'VISIT_BOOKED', 'VISITED', 'NEGOTIATING', 'CLOSED_WON', 'CLOSED_LOST', 'DORMANT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeadPurpose" AS ENUM ('END_USE', 'INVEST');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "FinancingStatus" AS ENUM ('CASH', 'PREAPPROVED', 'NEEDS_LOAN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "LeadExchangeStatus" AS ENUM ('NONE', 'ELIGIBLE', 'OFFERED', 'SYNDICATED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ProjectStatus" AS ENUM ('PRELAUNCH', 'UC', 'RTM');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "UnitAvailability" AS ENUM ('AVAILABLE', 'HOLD', 'SOLD', 'UNVERIFIED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "NetworkVisibility" AS ENUM ('PRIVATE', 'EXCHANGE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RealtyAssetType" AS ENUM ('BROCHURE', 'FLOORPLAN', 'PRICESHEET', 'VIDEO', 'PIN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "realty_leads" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "assigned_agent_id" UUID,
    "client_id" UUID,
    "conversation_id" UUID,
    "whatsapp_phone" VARCHAR(20) NOT NULL,
    "alt_phone" VARCHAR(20),
    "email" VARCHAR(320),
    "name" VARCHAR(255),
    "language_pref" VARCHAR(20) NOT NULL DEFAULT 'hinglish',
    "source" "LeadSource" NOT NULL,
    "sub_source" VARCHAR(120),
    "campaign_id" UUID,
    "listing_ref" VARCHAR(255),
    "first_touch_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "budget_min" DECIMAL(14,2),
    "budget_max" DECIMAL(14,2),
    "localities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "timeline_months" INTEGER,
    "config" VARCHAR(60),
    "purpose" "LeadPurpose",
    "financing" "FinancingStatus",
    "qual_score" INTEGER NOT NULL DEFAULT 0,
    "temperature" "LeadTemperature" NOT NULL DEFAULT 'COLD',
    "stage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "matched_unit_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "extracted_facts" JSONB NOT NULL DEFAULT '[]',
    "objections" JSONB NOT NULL DEFAULT '[]',
    "promises" JSONB NOT NULL DEFAULT '[]',
    "opt_out" BOOLEAN NOT NULL DEFAULT false,
    "consent_log" JSONB NOT NULL DEFAULT '[]',
    "share_consent" BOOLEAN NOT NULL DEFAULT false,
    "exchange_status" "LeadExchangeStatus" NOT NULL DEFAULT 'NONE',
    "cadence_id" UUID,
    "cadence_step" INTEGER NOT NULL DEFAULT 0,
    "next_followup_at" TIMESTAMPTZ,
    "last_activity_at" TIMESTAMPTZ,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_projects" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "developer" VARCHAR(255),
    "locality" VARCHAR(180) NOT NULL,
    "geo" JSONB,
    "rera_number" VARCHAR(120),
    "possession_date" DATE,
    "status" "ProjectStatus" NOT NULL DEFAULT 'UC',
    "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "price_band_min" DECIMAL(14,2),
    "price_band_max" DECIMAL(14,2),
    "fact_sheet_doc_id" UUID,
    "commission_terms" JSONB NOT NULL DEFAULT '{}',
    "network_visibility" "NetworkVisibility" NOT NULL DEFAULT 'PRIVATE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_units" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "config" VARCHAR(60) NOT NULL,
    "carpet_sqft" INTEGER,
    "builtup_sqft" INTEGER,
    "floor" INTEGER,
    "facing" VARCHAR(40),
    "base_price" DECIMAL(14,2),
    "all_in_price" DECIMAL(14,2) NOT NULL,
    "availability" "UnitAvailability" NOT NULL DEFAULT 'UNVERIFIED',
    "verified_at" TIMESTAMPTZ,
    "network_visibility" "NetworkVisibility" NOT NULL DEFAULT 'PRIVATE',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_units_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_assets" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "type" "RealtyAssetType" NOT NULL,
    "wa_media_id" VARCHAR(255),
    "url" TEXT,
    "title" VARCHAR(255),
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_assets_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────────

ALTER TABLE "realty_leads" ADD CONSTRAINT "realty_leads_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_projects" ADD CONSTRAINT "realty_projects_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_units" ADD CONSTRAINT "realty_units_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_units" ADD CONSTRAINT "realty_units_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "realty_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_assets" ADD CONSTRAINT "realty_assets_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_assets" ADD CONSTRAINT "realty_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "realty_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE INDEX "realty_leads_business_id_stage_last_activity_at_idx" ON "realty_leads"("business_id", "stage", "last_activity_at" DESC);
CREATE INDEX "realty_leads_business_id_temperature_qual_score_idx" ON "realty_leads"("business_id", "temperature", "qual_score" DESC);
CREATE INDEX "realty_leads_business_id_assigned_agent_id_stage_idx" ON "realty_leads"("business_id", "assigned_agent_id", "stage");
CREATE INDEX "realty_leads_business_id_source_idx" ON "realty_leads"("business_id", "source");
CREATE INDEX "realty_leads_business_id_next_followup_at_idx" ON "realty_leads"("business_id", "next_followup_at");
CREATE INDEX "realty_leads_deleted_at_idx" ON "realty_leads"("deleted_at");
CREATE UNIQUE INDEX "uq_realty_leads_business_phone" ON "realty_leads"("business_id", "whatsapp_phone");

CREATE INDEX "realty_projects_business_id_locality_status_idx" ON "realty_projects"("business_id", "locality", "status");
CREATE INDEX "realty_projects_business_id_network_visibility_idx" ON "realty_projects"("business_id", "network_visibility");
CREATE INDEX "realty_projects_business_id_is_active_idx" ON "realty_projects"("business_id", "is_active");
CREATE INDEX "realty_projects_deleted_at_idx" ON "realty_projects"("deleted_at");

CREATE INDEX "realty_units_business_id_project_id_availability_idx" ON "realty_units"("business_id", "project_id", "availability");
CREATE INDEX "realty_units_business_id_config_availability_idx" ON "realty_units"("business_id", "config", "availability");
CREATE INDEX "realty_units_business_id_all_in_price_idx" ON "realty_units"("business_id", "all_in_price");
CREATE INDEX "realty_units_deleted_at_idx" ON "realty_units"("deleted_at");

CREATE INDEX "realty_assets_business_id_project_id_type_is_current_idx" ON "realty_assets"("business_id", "project_id", "type", "is_current");
CREATE INDEX "realty_assets_deleted_at_idx" ON "realty_assets"("deleted_at");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- Uses the app.current_business_id session var set by withTenant().
-- ─────────────────────────────────────────────

ALTER TABLE "realty_leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_assets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "realty_leads_tenant_isolation" ON "realty_leads"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_projects_tenant_isolation" ON "realty_projects"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_units_tenant_isolation" ON "realty_units"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_assets_tenant_isolation" ON "realty_assets"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
