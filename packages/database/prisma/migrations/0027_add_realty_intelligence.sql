-- Migration: 0026_add_realty_intelligence
-- GoSumo Realty — Micro-Market Intelligence (L1, blueprint §18).
--
-- Adds the consented, anonymized corridor-aggregate layer that feeds priors back
-- into the grounded AI prompt (the data network effect).
--
--   businesses.intelligence_opt_in         — per-tenant consent (default false)
--   realty_intelligence_aggregates         — one corridor pattern per row
--
-- The aggregate table is tenant-scoped on business_id and protected by Row-Level
-- Security (app.current_business_id session var), consistent with the other realty
-- tables. Aggregates are only ever built from opted-in tenants, and only when a
-- corridor has at least min_n_threshold data points behind it (anti-reconstruction).

-- ─────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "IntelligenceMetricType" AS ENUM (
    'CADENCE_CONVERSION',
    'OBJECTION_FREQUENCY',
    'PRICE_ELASTICITY',
    'SOURCE_QUALITY',
    'SEASONAL_VELOCITY'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- CONSENT FLAG on the tenant table
-- ─────────────────────────────────────────────

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "intelligence_opt_in" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────
-- AGGREGATE TABLE
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "realty_intelligence_aggregates" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "corridor" VARCHAR(180) NOT NULL,
    "metric_type" "IntelligenceMetricType" NOT NULL,
    "metric_value" JSONB NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "min_n_threshold" INTEGER NOT NULL DEFAULT 5,
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_intelligence_aggregates_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────────

ALTER TABLE "realty_intelligence_aggregates"
  ADD CONSTRAINT "realty_intelligence_aggregates_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE UNIQUE INDEX "uq_realty_intel_business_corridor_metric_period"
  ON "realty_intelligence_aggregates"("business_id", "corridor", "metric_type", "period_start");

CREATE INDEX "realty_intelligence_aggregates_business_id_corridor_metric_type_idx"
  ON "realty_intelligence_aggregates"("business_id", "corridor", "metric_type");

CREATE INDEX "realty_intelligence_aggregates_business_id_metric_type_period_end_idx"
  ON "realty_intelligence_aggregates"("business_id", "metric_type", "period_end" DESC);

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- ─────────────────────────────────────────────

ALTER TABLE "realty_intelligence_aggregates" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "realty_intelligence_aggregates_tenant_isolation" ON "realty_intelligence_aggregates"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
