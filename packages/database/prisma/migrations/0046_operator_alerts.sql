-- Migration: 0046_operator_alerts
--
-- The delivery half of operator alerting.
--
-- `business_notification_settings` already answers "does this business want to
-- be told about this, now?" — quiet hours, muted channels, minimum severity,
-- subscribed kinds. Nothing asked it. `sla.escalated` was emitted per
-- configured escalation action and had no listener at all, so a conversation
-- could breach its SLA, escalate, and reach no human. These rows are the record
-- of every alert raised, what the rules decided about it, and where it went.
--
-- Why a table rather than only sending an email: an operator who was asleep
-- during a deferred alert, or whose alert was withheld by a rule they forgot
-- they set, needs to be able to see that afterwards. A suppressed alert is
-- stored precisely so "we never told you" is answerable.
--
-- Idempotent throughout (IF NOT EXISTS / DO-block guards) so it can be applied
-- by psql against a database whose end state is the source of truth.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Status enum
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperatorAlertStatus') THEN
        CREATE TYPE "OperatorAlertStatus" AS ENUM (
            'PENDING',
            'DEFERRED',
            'DELIVERED',
            'SUPPRESSED',
            'FAILED'
        );
    END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Table
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `kind` and `severity` are VARCHAR, not enums, for the same reason
-- `business_notification_settings.realtime_alerts` is a TEXT[]: a dashboard
-- shipped ahead of the API may raise a kind this build has never heard of, and
-- a failed INSERT would lose the alert entirely. Unknown values are ranked and
-- filtered on read (see notification-settings.constants.ts).

CREATE TABLE IF NOT EXISTS "operator_alerts" (
    "id"              UUID                  NOT NULL DEFAULT uuid_generate_v4(),
    "business_id"     UUID                  NOT NULL,

    "kind"            VARCHAR(40)           NOT NULL,
    "severity"        VARCHAR(20)           NOT NULL,

    "title"           VARCHAR(300)          NOT NULL,
    "body"            TEXT,

    -- The conversation channel the alert came from, matched against
    -- `muted_channels`. NULL for alerts with no channel (billing, platform).
    "source_channel"  VARCHAR(30),

    -- What the alert is about, so the dashboard can deep-link to it.
    "conversation_id" UUID,
    "entity_type"     VARCHAR(40),
    "entity_id"       UUID,

    "context"         JSONB                 NOT NULL DEFAULT '{}'::jsonb,

    "status"          "OperatorAlertStatus" NOT NULL DEFAULT 'PENDING',
    -- Why it was withheld, deferred, or failed. NULL when it went straight out.
    "reason"          VARCHAR(200),
    "deferred_until"  TIMESTAMPTZ,
    "delivered_at"    TIMESTAMPTZ,
    -- The addresses it actually reached, so "who was told" is answerable
    -- without joining against the notification rows.
    "delivered_to"    TEXT[]                NOT NULL DEFAULT ARRAY[]::TEXT[],

    "read_at"         TIMESTAMPTZ,
    "read_by"         UUID,

    -- Collapses repeats of the same underlying condition. Nullable: an alert
    -- with no natural key is always distinct.
    "dedupe_key"      VARCHAR(200),

    "created_at"      TIMESTAMPTZ           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMPTZ           NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_alerts_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'operator_alerts_business_id_fkey'
    ) THEN
        ALTER TABLE "operator_alerts"
            ADD CONSTRAINT "operator_alerts_business_id_fkey"
            FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE;
    END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Dedupe is per business. Postgres treats NULLs as distinct in a unique index,
-- which is exactly what we want: an alert with no dedupe key never collides.
CREATE UNIQUE INDEX IF NOT EXISTS "operator_alerts_dedupe_key"
    ON "operator_alerts" ("business_id", "dedupe_key");

-- The operator inbox: unread first, newest first.
CREATE INDEX IF NOT EXISTS "operator_alerts_inbox_idx"
    ON "operator_alerts" ("business_id", "read_at", "created_at" DESC);

-- Filtering the inbox by what the alert is about.
CREATE INDEX IF NOT EXISTS "operator_alerts_kind_idx"
    ON "operator_alerts" ("business_id", "kind", "created_at" DESC);

-- Deep-link from a conversation to the alerts it raised.
CREATE INDEX IF NOT EXISTS "operator_alerts_conversation_idx"
    ON "operator_alerts" ("business_id", "conversation_id");

-- The release sweep, which starts without a tenant and asks *which* businesses
-- are holding alerts whose quiet-hours window has ended. Partial, so it indexes
-- only the handful of rows actually parked rather than the whole history.
CREATE INDEX IF NOT EXISTS "operator_alerts_deferred_idx"
    ON "operator_alerts" ("deferred_until")
    WHERE "status" = 'DEFERRED';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Row-level security (tenant isolation backstop)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "operator_alerts" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'operator_alerts'
          AND policyname = 'operator_alerts_tenant_isolation'
    ) THEN
        CREATE POLICY "operator_alerts_tenant_isolation" ON "operator_alerts"
          USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
    END IF;
END
$$;
