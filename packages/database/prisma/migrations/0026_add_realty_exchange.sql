-- Migration: 0026_add_realty_exchange
-- GoSumo Realty — the L2 co-broking exchange (blueprint §19).
--
-- Formalises India's informal 50:50 deal-sharing culture into a trustable
-- network. Adds three tenant-scoped tables:
--   realty_syndications       — the immutable attribution ledger (OFFERED→…→CLOSED)
--   realty_reliability_scores — per-member composite trust that gates matching
--   realty_resale_listings    — Tier-1 oxygen supply that also feeds the exchange
--
-- Every table is tenant-scoped on business_id and protected by Row-Level Security
-- (app.current_business_id session var), consistent with 0021_add_realty_tables.sql.
-- Resale listings additionally expose ACTIVE rows network-wide (the intentional
-- co-broking read) via a second permissive SELECT policy.

-- ─────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "SyndicationState" AS ENUM ('OFFERED', 'ACCEPTED', 'VISIT', 'CLOSED', 'EXPIRED', 'DISPUTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "SettlementState" AS ENUM ('UNSETTLED', 'PENDING', 'SETTLED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ResaleListingStatus" AS ENUM ('ACTIVE', 'UNDER_OFFER', 'SOLD', 'WITHDRAWN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "realty_syndications" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "from_business_id" UUID NOT NULL,
    "to_business_id" UUID NOT NULL,
    "developer_id" UUID,
    "split_terms" JSONB NOT NULL DEFAULT '{}',
    "buyer_consent_at" TIMESTAMPTZ,
    "state" "SyndicationState" NOT NULL DEFAULT 'OFFERED',
    "commission_pool" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platform_fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "settlement_state" "SettlementState" NOT NULL DEFAULT 'UNSETTLED',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_syndications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_reliability_scores" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "target_business_id" UUID NOT NULL,
    "response_speed_score" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "showup_integrity_score" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "split_honoring_score" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "documentation_hygiene_score" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "composite_score" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_reliability_scores_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_resale_listings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "project_id" UUID,
    "locality" VARCHAR(180) NOT NULL,
    "config" VARCHAR(60) NOT NULL,
    "carpet_sqft" INTEGER,
    "asking_price" DECIMAL(14,2) NOT NULL,
    "seller_phone" VARCHAR(20) NOT NULL,
    "status" "ResaleListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "verified_at" TIMESTAMPTZ,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_resale_listings_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────────

ALTER TABLE "realty_syndications" ADD CONSTRAINT "realty_syndications_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_reliability_scores" ADD CONSTRAINT "realty_reliability_scores_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_resale_listings" ADD CONSTRAINT "realty_resale_listings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE INDEX "realty_syndications_business_id_state_idx" ON "realty_syndications"("business_id", "state");
CREATE INDEX "realty_syndications_business_id_lead_id_idx" ON "realty_syndications"("business_id", "lead_id");
CREATE INDEX "realty_syndications_to_business_id_state_idx" ON "realty_syndications"("to_business_id", "state");
CREATE INDEX "realty_syndications_business_id_settlement_state_idx" ON "realty_syndications"("business_id", "settlement_state");
CREATE INDEX "realty_syndications_deleted_at_idx" ON "realty_syndications"("deleted_at");

CREATE UNIQUE INDEX "realty_reliability_scores_business_target_period_key" ON "realty_reliability_scores"("business_id", "target_business_id", "period_start");
CREATE INDEX "realty_reliability_scores_business_id_target_business_id_idx" ON "realty_reliability_scores"("business_id", "target_business_id");
CREATE INDEX "realty_reliability_scores_business_id_composite_score_idx" ON "realty_reliability_scores"("business_id", "composite_score" DESC);

CREATE INDEX "realty_resale_listings_business_id_status_idx" ON "realty_resale_listings"("business_id", "status");
CREATE INDEX "realty_resale_listings_status_locality_config_idx" ON "realty_resale_listings"("status", "locality", "config");
CREATE INDEX "realty_resale_listings_deleted_at_idx" ON "realty_resale_listings"("deleted_at");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- ─────────────────────────────────────────────

ALTER TABLE "realty_syndications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_reliability_scores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_resale_listings" ENABLE ROW LEVEL SECURITY;

-- Syndications are visible to both sides of the deal (originator + counterparty).
CREATE POLICY "realty_syndications_tenant_isolation" ON "realty_syndications"
  USING (
    "business_id" = current_setting('app.current_business_id', TRUE)::uuid
    OR "to_business_id" = current_setting('app.current_business_id', TRUE)::uuid
  );

CREATE POLICY "realty_reliability_scores_tenant_isolation" ON "realty_reliability_scores"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

-- Owner-scoped policy for all commands on a member's own resale listings.
CREATE POLICY "realty_resale_listings_tenant_isolation" ON "realty_resale_listings"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid)
  WITH CHECK ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

-- The intentional network read: any member may SELECT another member's ACTIVE
-- resale supply — this is what makes the co-broking exchange liquid. Only ACTIVE,
-- non-deleted rows are exposed; seller_phone is stripped in the service layer.
CREATE POLICY "realty_resale_listings_exchange_read" ON "realty_resale_listings"
  FOR SELECT
  USING ("status" = 'ACTIVE' AND "deleted_at" IS NULL);

-- ─────────────────────────────────────────────
-- APPEND-ONLY GUARANTEE for the syndication ledger's attribution facts.
-- The ledger's money/state legs advance, but the attribution (who syndicated
-- which lead to whom, the split, and the buyer's consent) is evidence and must
-- never be rewritten. A BEFORE UPDATE trigger pins those columns to their
-- original values (root rule #7 — the ledger is the trust anchor of the network).
-- ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "realty_syndications_freeze_attribution"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."lead_id"          IS DISTINCT FROM OLD."lead_id"
    OR NEW."from_business_id" IS DISTINCT FROM OLD."from_business_id"
    OR NEW."to_business_id"   IS DISTINCT FROM OLD."to_business_id"
    OR NEW."developer_id"     IS DISTINCT FROM OLD."developer_id"
    OR NEW."split_terms"      IS DISTINCT FROM OLD."split_terms"
    OR NEW."buyer_consent_at" IS DISTINCT FROM OLD."buyer_consent_at"
    OR NEW."created_at"       IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'realty_syndications attribution columns are immutable (append-only ledger)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "realty_syndications_freeze_attribution_trg" ON "realty_syndications";
CREATE TRIGGER "realty_syndications_freeze_attribution_trg"
  BEFORE UPDATE ON "realty_syndications"
  FOR EACH ROW EXECUTE FUNCTION "realty_syndications_freeze_attribution"();
