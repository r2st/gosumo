-- Migration: 0030_add_contact_canned_sla
-- Operations layer: contact tagging/segmentation, canned responses, SLA
-- tracking + escalation rules.
--
-- Tables:
--   segments          — saved dynamic filters over `clients` (contact module)
--   canned_responses  — reusable pre-written replies (canned-response module)
--   sla_policies      — configurable first-response/resolution targets (sla module)
--   sla_breaches      — per-conversation SLA clocks + breach state (sla module)
--
-- Also adds `clients.tags` for contact tagging.
--
-- All new tables are business_id-scoped and protected by RLS
-- (app.current_business_id), consistent with 0001_enable_rls.sql.

-- ─────────────────────────────────────────────
-- ENUMS
-- ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "SlaBreachType" AS ENUM ('FIRST_RESPONSE', 'RESOLUTION');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─────────────────────────────────────────────
-- clients.tags
-- ─────────────────────────────────────────────

ALTER TABLE "clients"
  ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT '{}';

-- GIN index for tag containment lookups (@> / && operators).
CREATE INDEX IF NOT EXISTS "idx_clients_business_tags" ON "clients" USING GIN ("tags");

-- ─────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "segments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "segments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "segments_business_id_name_key" ON "segments"("business_id", "name");
CREATE INDEX IF NOT EXISTS "idx_segments_business_active" ON "segments"("business_id", "is_active");

CREATE TABLE IF NOT EXISTS "canned_responses" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "shortcut" VARCHAR(100) NOT NULL,
    "content" TEXT NOT NULL,
    "category" VARCHAR(100),
    "channel" "ChannelType",
    "tags" TEXT[] NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "canned_responses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "canned_responses_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE,
    CONSTRAINT "canned_responses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "team_members"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "canned_responses_business_id_shortcut_key" ON "canned_responses"("business_id", "shortcut");
CREATE INDEX IF NOT EXISTS "idx_canned_responses_business_active_category" ON "canned_responses"("business_id", "is_active", "category");
CREATE INDEX IF NOT EXISTS "idx_canned_responses_tags" ON "canned_responses" USING GIN ("tags");

CREATE TABLE IF NOT EXISTS "sla_policies" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "first_response_target_minutes" INTEGER NOT NULL,
    "resolution_target_minutes" INTEGER NOT NULL,
    "escalation_actions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sla_policies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_sla_policies_business_active_priority" ON "sla_policies"("business_id", "is_active", "priority" DESC);

CREATE TABLE IF NOT EXISTS "sla_breaches" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "breach_type" "SlaBreachType" NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "due_at" TIMESTAMPTZ NOT NULL,
    "met_at" TIMESTAMPTZ,
    "breached" BOOLEAN NOT NULL DEFAULT false,
    "breached_at" TIMESTAMPTZ,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "escalated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "sla_breaches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sla_breaches_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE,
    CONSTRAINT "sla_breaches_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE,
    CONSTRAINT "sla_breaches_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "sla_policies"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sla_breaches_conversation_id_breach_type_key" ON "sla_breaches"("conversation_id", "breach_type");
CREATE INDEX IF NOT EXISTS "idx_sla_breaches_business_breached_due" ON "sla_breaches"("business_id", "breached", "due_at");
CREATE INDEX IF NOT EXISTS "idx_sla_breaches_business_conversation" ON "sla_breaches"("business_id", "conversation_id");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- Uses the app.current_business_id session var set by withTenant().
-- ─────────────────────────────────────────────

ALTER TABLE "segments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canned_responses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sla_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sla_breaches" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "segments_tenant_isolation" ON "segments"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "canned_responses_tenant_isolation" ON "canned_responses"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "sla_policies_tenant_isolation" ON "sla_policies"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
CREATE POLICY "sla_breaches_tenant_isolation" ON "sla_breaches"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
