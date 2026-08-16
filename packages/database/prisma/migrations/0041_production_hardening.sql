-- Migration: 0041_production_hardening
--
-- Five observability/durability surfaces, one migration because they share
-- nothing but their timing:
--
--   1. ai_quality_metrics            — pre-aggregated AI decision quality
--   2. payment_reconciliation_runs   — gateway-vs-ledger sweep bookkeeping
--      payment_discrepancies         — the flagged disagreements
--   4. notification_template_versions— immutable template snapshots
--      + notifications.template_version_id  (what a send is bound to)
--      + notification_templates.active_version / latest_version
--   5. data_retention_policies       — per-tenant, per-class retention rules
--      data_archive_records          — cold snapshots taken before a purge
--      data_retention_runs           — sweep bookkeeping
--
-- (3, per-recipient notification rate limiting, is process state and adds no
-- tables — see `notification.recipient-rate-limiter.ts`.)
--
-- Every new table is tenant-scoped and gets the same RLS policy as the rest of
-- the schema. Additive only: no column is dropped and no existing column
-- changes type, so this applies to a live database without a backfill.

-- CreateEnum
CREATE TYPE "AiQualityBucket" AS ENUM ('HOUR', 'DAY');

-- CreateEnum
CREATE TYPE "ReconciliationRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentDiscrepancyType" AS ENUM ('STATUS_MISMATCH', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'MISSING_AT_GATEWAY', 'MISSING_LOCALLY', 'REFUND_IN_TRANSIT', 'REFUND_AMOUNT_MISMATCH', 'DISPUTED_CHARGE', 'DUPLICATE_PAYMENT');

-- CreateEnum
CREATE TYPE "PaymentDiscrepancyStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'RESOLVED', 'IGNORED');

-- CreateEnum
CREATE TYPE "PaymentDiscrepancySeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TemplateVersionState" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TemplateValidationState" AS ENUM ('UNCHECKED', 'VALID', 'INVALID');

-- CreateEnum
CREATE TYPE "RetentionDataClass" AS ENUM ('MESSAGES', 'CONVERSATIONS', 'AUDIT_LOGS', 'NOTIFICATIONS', 'ANALYTICS_EVENTS', 'WEBHOOK_EVENTS', 'AI_DECISIONS');

-- CreateEnum
CREATE TYPE "RetentionActionKind" AS ENUM ('ANONYMIZE', 'ARCHIVE', 'ARCHIVE_AND_PURGE', 'PURGE');

-- AlterTable
ALTER TABLE "notification_templates" ADD COLUMN     "active_version" INTEGER,
ADD COLUMN     "latest_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "template_version_id" UUID;

-- CreateTable
CREATE TABLE "ai_quality_metrics" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "bucket" "AiQualityBucket" NOT NULL,
    "bucket_start" TIMESTAMPTZ NOT NULL,
    "decisions" INTEGER NOT NULL DEFAULT 0,
    "auto_executed" INTEGER NOT NULL DEFAULT 0,
    "sent_for_review" INTEGER NOT NULL DEFAULT 0,
    "escalated" INTEGER NOT NULL DEFAULT 0,
    "overridden" INTEGER NOT NULL DEFAULT 0,
    "expired" INTEGER NOT NULL DEFAULT 0,
    "human_overrides" INTEGER NOT NULL DEFAULT 0,
    "confidence_deciles" JSONB NOT NULL DEFAULT '[0,0,0,0,0,0,0,0,0,0]',
    "confidence_sum" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "confidence_min" DECIMAL(5,4),
    "confidence_max" DECIMAL(5,4),
    "latency_count" INTEGER NOT NULL DEFAULT 0,
    "latency_sum_ms" INTEGER NOT NULL DEFAULT 0,
    "latency_p50_ms" INTEGER,
    "latency_p95_ms" INTEGER,
    "latency_max_ms" INTEGER,
    "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
    "completion_tokens" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_quality_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_reconciliation_runs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "gateway" "PaymentGateway" NOT NULL,
    "status" "ReconciliationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ NOT NULL,
    "payments_checked" INTEGER NOT NULL DEFAULT 0,
    "refunds_checked" INTEGER NOT NULL DEFAULT 0,
    "discrepancies_found" INTEGER NOT NULL DEFAULT 0,
    "auto_resolved" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "payment_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_discrepancies" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "run_id" UUID,
    "payment_id" UUID,
    "refund_id" UUID,
    "gateway" "PaymentGateway" NOT NULL,
    "gateway_payment_id" VARCHAR(255),
    "gateway_refund_id" VARCHAR(255),
    "type" "PaymentDiscrepancyType" NOT NULL,
    "severity" "PaymentDiscrepancySeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "PaymentDiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "fingerprint" VARCHAR(255) NOT NULL,
    "local_status" VARCHAR(50),
    "gateway_status" VARCHAR(100),
    "local_amount" DECIMAL(14,2),
    "gateway_amount" DECIMAL(14,2),
    "delta_amount" DECIMAL(14,2),
    "currency" CHAR(3),
    "detail" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,
    "resolved_by" UUID,
    "resolution_note" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_template_versions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "state" "TemplateVersionState" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '[]',
    "subject" VARCHAR(500),
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "category" VARCHAR(50),
    "external_name" VARCHAR(255),
    "validation_state" "TemplateValidationState" NOT NULL DEFAULT 'UNCHECKED',
    "validation_errors" JSONB NOT NULL DEFAULT '[]',
    "validated_at" TIMESTAMPTZ,
    "change_note" TEXT,
    "created_by" UUID,
    "activated_at" TIMESTAMPTZ,
    "deactivated_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_retention_policies" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "data_class" "RetentionDataClass" NOT NULL,
    "action" "RetentionActionKind" NOT NULL,
    "retention_days" INTEGER NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "batch_size" INTEGER NOT NULL DEFAULT 500,
    "purge_caches" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMPTZ,
    "last_run_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_pending" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "data_retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_archive_records" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "data_class" "RetentionDataClass" NOT NULL,
    "run_id" UUID,
    "source_id" UUID NOT NULL,
    "source_created_at" TIMESTAMPTZ NOT NULL,
    "payload" JSONB NOT NULL,
    "purged_at" TIMESTAMPTZ,
    "archived_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_archive_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_retention_runs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "data_class" "RetentionDataClass" NOT NULL,
    "action" "RetentionActionKind" NOT NULL,
    "cutoff" TIMESTAMPTZ NOT NULL,
    "examined" INTEGER NOT NULL DEFAULT 0,
    "archived" INTEGER NOT NULL DEFAULT 0,
    "anonymized" INTEGER NOT NULL DEFAULT 0,
    "purged" INTEGER NOT NULL DEFAULT 0,
    "caches_purged" INTEGER NOT NULL DEFAULT 0,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "data_retention_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_quality_metrics_business_id_bucket_bucket_start_idx" ON "ai_quality_metrics"("business_id", "bucket", "bucket_start" DESC);

-- CreateIndex
CREATE INDEX "ai_quality_metrics_bucket_bucket_start_idx" ON "ai_quality_metrics"("bucket", "bucket_start" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_ai_quality_bucket" ON "ai_quality_metrics"("business_id", "bucket", "bucket_start", "channel");

-- CreateIndex
CREATE INDEX "payment_reconciliation_runs_business_id_started_at_idx" ON "payment_reconciliation_runs"("business_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "payment_reconciliation_runs_business_id_gateway_status_idx" ON "payment_reconciliation_runs"("business_id", "gateway", "status");

-- CreateIndex
CREATE INDEX "payment_discrepancies_business_id_status_severity_last_dete_idx" ON "payment_discrepancies"("business_id", "status", "severity", "last_detected_at" DESC);

-- CreateIndex
CREATE INDEX "payment_discrepancies_business_id_type_status_idx" ON "payment_discrepancies"("business_id", "type", "status");

-- CreateIndex
CREATE INDEX "payment_discrepancies_payment_id_idx" ON "payment_discrepancies"("payment_id");

-- CreateIndex
CREATE INDEX "payment_discrepancies_refund_id_idx" ON "payment_discrepancies"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payment_discrepancy_fingerprint" ON "payment_discrepancies"("business_id", "fingerprint");

-- CreateIndex
CREATE INDEX "notification_template_versions_business_id_template_id_stat_idx" ON "notification_template_versions"("business_id", "template_id", "state");

-- CreateIndex
CREATE INDEX "notification_template_versions_template_id_state_idx" ON "notification_template_versions"("template_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "uq_template_version_number" ON "notification_template_versions"("template_id", "version");

-- CreateIndex
CREATE INDEX "data_retention_policies_is_enabled_data_class_idx" ON "data_retention_policies"("is_enabled", "data_class");

-- CreateIndex
CREATE UNIQUE INDEX "uq_retention_policy_business_class" ON "data_retention_policies"("business_id", "data_class");

-- CreateIndex
CREATE INDEX "data_archive_records_business_id_data_class_source_created__idx" ON "data_archive_records"("business_id", "data_class", "source_created_at");

-- CreateIndex
CREATE INDEX "data_archive_records_business_id_archived_at_idx" ON "data_archive_records"("business_id", "archived_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_archive_business_class_source" ON "data_archive_records"("business_id", "data_class", "source_id");

-- CreateIndex
CREATE INDEX "data_retention_runs_business_id_data_class_started_at_idx" ON "data_retention_runs"("business_id", "data_class", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "notification_template_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_quality_metrics" ADD CONSTRAINT "ai_quality_metrics_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reconciliation_runs" ADD CONSTRAINT "payment_reconciliation_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_discrepancies" ADD CONSTRAINT "payment_discrepancies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_discrepancies" ADD CONSTRAINT "payment_discrepancies_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payment_reconciliation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_template_versions" ADD CONSTRAINT "notification_template_versions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_template_versions" ADD CONSTRAINT "notification_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "notification_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_retention_policies" ADD CONSTRAINT "data_retention_policies_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_archive_records" ADD CONSTRAINT "data_archive_records_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_retention_runs" ADD CONSTRAINT "data_retention_runs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────
-- ONE ACTIVE VERSION PER TEMPLATE
-- ─────────────────────────────────────────────
--
-- The invariant the whole feature rests on: a dispatch binds to "the active
-- version", so two of them means the binding is decided by row order. Prisma
-- cannot express a partial unique index, so it is declared here and the
-- activation path is written to rely on it — `activateVersion` demotes the
-- incumbent and promotes the successor in one transaction, and this index is
-- what makes two concurrent activations fail loudly instead of both winning.

CREATE UNIQUE INDEX "uq_template_one_active_version"
    ON "notification_template_versions" ("template_id")
    WHERE "state" = 'ACTIVE';

-- The version-binding read on the dispatch path: given a template, find the
-- row a new notification should point at. Served by the partial index above
-- only for the equality; this covers the ordered scan the API's version list
-- does (newest first) on the same template.
CREATE INDEX "notification_template_versions_template_id_version_idx"
    ON "notification_template_versions" ("template_id", "version" DESC);

-- The reconciliation sweep asks which tenants have reconcilable payments
-- before a tenant is known, then walks them by age. `payments` already has
-- (business_id, status, created_at DESC); this is the tenant-unknown twin,
-- same shape as 0038's notification sweep index and for the same reason.
CREATE INDEX IF NOT EXISTS "payments_status_created_at_idx"
    ON "payments" ("status", "created_at");

-- Same, for the refund side of the sweep: refunds stuck non-terminal are the
-- "in transit" case, and finding them starts without a business_id.
CREATE INDEX IF NOT EXISTS "refunds_status_created_at_idx"
    ON "refunds" ("status", "created_at");

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- ─────────────────────────────────────────────

ALTER TABLE "ai_quality_metrics" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai_quality_metrics_tenant_isolation" ON "ai_quality_metrics"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

ALTER TABLE "payment_reconciliation_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payment_reconciliation_runs_tenant_isolation" ON "payment_reconciliation_runs"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

ALTER TABLE "payment_discrepancies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "payment_discrepancies_tenant_isolation" ON "payment_discrepancies"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

ALTER TABLE "notification_template_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "notification_template_versions_tenant_isolation" ON "notification_template_versions"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

ALTER TABLE "data_retention_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "data_retention_policies_tenant_isolation" ON "data_retention_policies"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

ALTER TABLE "data_archive_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "data_archive_records_tenant_isolation" ON "data_archive_records"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);

ALTER TABLE "data_retention_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "data_retention_runs_tenant_isolation" ON "data_retention_runs"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
