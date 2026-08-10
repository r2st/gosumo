-- Migration: 0022_add_realty_site_visits
-- GoSumo Realty — Phase 3 (Site Visits).
--
-- Adds `realty_site_visits`: scheduled property visits that sit on top of the
-- `booking` module for Google Calendar sync, with a realty-specific reminder
-- cadence (T-24h, T-2h), reschedule/cancel flows, and post-visit feedback +
-- outcome logging.
--
-- Tenant-scoped on business_id and protected by Row-Level Security
-- (app.current_business_id session var), consistent with 0001_enable_rls.sql.

-- ─────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "SiteVisitStatus" AS ENUM ('BOOKED', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'RESCHEDULED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "SiteVisitOutcome" AS ENUM ('PENDING', 'INTERESTED', 'NOT_INTERESTED', 'WANTS_ALTERNATIVE', 'NEEDS_FOLLOWUP', 'TOKEN_BOOKED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- TABLE
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "realty_site_visits" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "unit_id" UUID,
    "assigned_agent_id" UUID,
    "scheduled_at" TIMESTAMPTZ NOT NULL,
    "duration_minutes" INTEGER NOT NULL DEFAULT 45,
    "timezone" VARCHAR(60) NOT NULL DEFAULT 'Asia/Kolkata',
    "status" "SiteVisitStatus" NOT NULL DEFAULT 'BOOKED',
    "booking_id" UUID,
    "calendar_event_id" VARCHAR(255),
    "calendar_id" VARCHAR(255),
    "reminder_state" JSONB NOT NULL DEFAULT '{}',
    "reminders_sent" INTEGER NOT NULL DEFAULT 0,
    "last_reminder_at" TIMESTAMPTZ,
    "feedback" TEXT,
    "outcome" "SiteVisitOutcome" NOT NULL DEFAULT 'PENDING',
    "rescheduled_from" TIMESTAMPTZ,
    "cancellation_reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_site_visits_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEYS
-- business_id modeled in Prisma; lead/project/unit are loose module-boundary
-- references, enforced at the DB level only.
-- ─────────────────────────────────────────────

ALTER TABLE "realty_site_visits" ADD CONSTRAINT "realty_site_visits_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_site_visits" ADD CONSTRAINT "realty_site_visits_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "realty_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_site_visits" ADD CONSTRAINT "realty_site_visits_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "realty_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_site_visits" ADD CONSTRAINT "realty_site_visits_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "realty_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE INDEX "realty_site_visits_business_id_status_scheduled_at_idx" ON "realty_site_visits"("business_id", "status", "scheduled_at");
CREATE INDEX "realty_site_visits_business_id_lead_id_idx" ON "realty_site_visits"("business_id", "lead_id");
CREATE INDEX "realty_site_visits_business_id_scheduled_at_idx" ON "realty_site_visits"("business_id", "scheduled_at");
CREATE INDEX "realty_site_visits_business_id_assigned_agent_id_scheduled_at_idx" ON "realty_site_visits"("business_id", "assigned_agent_id", "scheduled_at");
CREATE INDEX "realty_site_visits_deleted_at_idx" ON "realty_site_visits"("deleted_at");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- ─────────────────────────────────────────────

ALTER TABLE "realty_site_visits" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "realty_site_visits_tenant_isolation" ON "realty_site_visits"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
