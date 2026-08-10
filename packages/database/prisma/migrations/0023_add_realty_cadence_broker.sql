-- Migration: 0023_add_realty_cadence_broker
-- GoSumo Realty — Phase 5 (Cadences + Compliance) and Phase 6 (Broker Surface).
--
-- Phase 5 tables (blueprint §17 / §21):
--   realty_message_templates   — WhatsApp template registry (category + approval gated)
--   realty_cadences            — declarative follow-up sequences (trigger-enrolled)
--   realty_cadence_steps       — day-offset steps with condition + stop_on signals
--   realty_cadence_enrollments — per-lead run state (next_run_at scheduling)
--
-- Phase 6 tables (blueprint §16):
--   realty_approvals            — AI drafts parked for human review (70–89% band)
--   realty_account_settings     — the autonomy dial + kill switch + briefing config
--   realty_broker_alerts        — notification-centre feed (hot leads, briefings…)
--   realty_conversation_control — AI/human ownership for the takeover protocol
--
-- Every table is tenant-scoped on business_id and protected by Row-Level Security
-- (app.current_business_id session var), consistent with 0001_enable_rls.sql.

-- ─────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "CadenceTrigger" AS ENUM ('NO_RESPONSE', 'POST_VISIT', 'DORMANT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CadenceStopOn" AS ENUM ('REPLY', 'OPTOUT', 'STAGE_CHANGE');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "CadenceEnrollmentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'STOPPED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TemplateCategory" AS ENUM ('UTILITY', 'MARKETING');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "TemplateApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'EDITED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AutonomyLevel" AS ENUM ('SUGGEST', 'ASSISTED', 'AUTONOMOUS');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "ConversationOwner" AS ENUM ('AI', 'HUMAN');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "BrokerAlertType" AS ENUM ('HOT_LEAD', 'MORNING_BRIEFING', 'APPROVAL_PENDING', 'TAKEOVER', 'VISIT_REMINDER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- TABLES — PHASE 5
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "realty_message_templates" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "category" "TemplateCategory" NOT NULL DEFAULT 'UTILITY',
    "language" VARCHAR(20) NOT NULL,
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approval_status" "TemplateApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approved_at" TIMESTAMPTZ,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_message_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_cadences" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "trigger" "CadenceTrigger" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_cadences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_cadence_steps" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "cadence_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "step_order" INTEGER NOT NULL,
    "day_offset" INTEGER NOT NULL,
    "condition" JSONB NOT NULL DEFAULT '{}',
    "stop_on" "CadenceStopOn"[] DEFAULT ARRAY[]::"CadenceStopOn"[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_cadence_steps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_cadence_enrollments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "cadence_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "status" "CadenceEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMPTZ,
    "trigger" "CadenceTrigger" NOT NULL,
    "stop_reason" VARCHAR(60),
    "last_step_sent_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_cadence_enrollments_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- TABLES — PHASE 6
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "realty_approvals" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "conversation_id" UUID,
    "draft_text" TEXT NOT NULL,
    "edited_text" TEXT,
    "confidence" INTEGER NOT NULL,
    "intent" VARCHAR(60),
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ,
    "reason" VARCHAR(500),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "realty_approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_account_settings" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "autonomy_level" "AutonomyLevel" NOT NULL DEFAULT 'SUGGEST',
    "auto_approve_threshold" INTEGER NOT NULL DEFAULT 90,
    "kill_switch" BOOLEAN NOT NULL DEFAULT false,
    "briefing_enabled" BOOLEAN NOT NULL DEFAULT true,
    "briefing_hour" INTEGER NOT NULL DEFAULT 7,
    "briefing_minute" INTEGER NOT NULL DEFAULT 30,
    "hot_alert_whatsapp" VARCHAR(20),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_account_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_broker_alerts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "type" "BrokerAlertType" NOT NULL,
    "lead_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_broker_alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "realty_conversation_control" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "lead_id" UUID,
    "owner" "ConversationOwner" NOT NULL DEFAULT 'AI',
    "taken_over_by" UUID,
    "taken_over_at" TIMESTAMPTZ,
    "released_at" TIMESTAMPTZ,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realty_conversation_control_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────
-- FOREIGN KEYS
-- ─────────────────────────────────────────────

ALTER TABLE "realty_message_templates" ADD CONSTRAINT "realty_message_templates_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_cadences" ADD CONSTRAINT "realty_cadences_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_cadence_steps" ADD CONSTRAINT "realty_cadence_steps_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_cadence_steps" ADD CONSTRAINT "realty_cadence_steps_cadence_id_fkey" FOREIGN KEY ("cadence_id") REFERENCES "realty_cadences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_cadence_steps" ADD CONSTRAINT "realty_cadence_steps_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "realty_message_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "realty_cadence_enrollments" ADD CONSTRAINT "realty_cadence_enrollments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "realty_cadence_enrollments" ADD CONSTRAINT "realty_cadence_enrollments_cadence_id_fkey" FOREIGN KEY ("cadence_id") REFERENCES "realty_cadences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_approvals" ADD CONSTRAINT "realty_approvals_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_account_settings" ADD CONSTRAINT "realty_account_settings_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_broker_alerts" ADD CONSTRAINT "realty_broker_alerts_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "realty_conversation_control" ADD CONSTRAINT "realty_conversation_control_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE UNIQUE INDEX "uq_realty_templates_business_name" ON "realty_message_templates"("business_id", "name");
CREATE INDEX "realty_message_templates_business_id_approval_status_idx" ON "realty_message_templates"("business_id", "approval_status");
CREATE INDEX "realty_message_templates_deleted_at_idx" ON "realty_message_templates"("deleted_at");

CREATE INDEX "realty_cadences_business_id_trigger_is_active_idx" ON "realty_cadences"("business_id", "trigger", "is_active");
CREATE INDEX "realty_cadences_deleted_at_idx" ON "realty_cadences"("deleted_at");

CREATE UNIQUE INDEX "uq_realty_cadence_step_order" ON "realty_cadence_steps"("cadence_id", "step_order");
CREATE INDEX "realty_cadence_steps_business_id_cadence_id_idx" ON "realty_cadence_steps"("business_id", "cadence_id");
CREATE INDEX "realty_cadence_steps_deleted_at_idx" ON "realty_cadence_steps"("deleted_at");

CREATE INDEX "realty_cadence_enrollments_business_id_status_next_run_at_idx" ON "realty_cadence_enrollments"("business_id", "status", "next_run_at");
CREATE INDEX "realty_cadence_enrollments_business_id_lead_id_status_idx" ON "realty_cadence_enrollments"("business_id", "lead_id", "status");
CREATE INDEX "realty_cadence_enrollments_business_id_cadence_id_idx" ON "realty_cadence_enrollments"("business_id", "cadence_id");

CREATE INDEX "realty_approvals_business_id_status_created_at_idx" ON "realty_approvals"("business_id", "status", "created_at");
CREATE INDEX "realty_approvals_business_id_lead_id_idx" ON "realty_approvals"("business_id", "lead_id");
CREATE INDEX "realty_approvals_deleted_at_idx" ON "realty_approvals"("deleted_at");

CREATE UNIQUE INDEX "realty_account_settings_business_id_key" ON "realty_account_settings"("business_id");

CREATE INDEX "realty_broker_alerts_business_id_is_read_created_at_idx" ON "realty_broker_alerts"("business_id", "is_read", "created_at");
CREATE INDEX "realty_broker_alerts_business_id_type_created_at_idx" ON "realty_broker_alerts"("business_id", "type", "created_at");
CREATE INDEX "realty_broker_alerts_business_id_lead_id_idx" ON "realty_broker_alerts"("business_id", "lead_id");

CREATE UNIQUE INDEX "uq_realty_conv_control" ON "realty_conversation_control"("business_id", "conversation_id");
CREATE INDEX "realty_conversation_control_business_id_owner_idx" ON "realty_conversation_control"("business_id", "owner");
CREATE INDEX "realty_conversation_control_business_id_lead_id_idx" ON "realty_conversation_control"("business_id", "lead_id");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- Uses the app.current_business_id session var set by withTenant().
-- ─────────────────────────────────────────────

ALTER TABLE "realty_message_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_cadences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_cadence_steps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_cadence_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_account_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_broker_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realty_conversation_control" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "realty_message_templates_tenant_isolation" ON "realty_message_templates"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_cadences_tenant_isolation" ON "realty_cadences"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_cadence_steps_tenant_isolation" ON "realty_cadence_steps"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_cadence_enrollments_tenant_isolation" ON "realty_cadence_enrollments"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_approvals_tenant_isolation" ON "realty_approvals"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_account_settings_tenant_isolation" ON "realty_account_settings"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_broker_alerts_tenant_isolation" ON "realty_broker_alerts"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "realty_conversation_control_tenant_isolation" ON "realty_conversation_control"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
