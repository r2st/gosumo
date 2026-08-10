-- Migration: 0031_add_api_keys
-- Programmatic API access: hashed, per-business API keys.
--
-- Tables:
--   api_keys — one row per issued key (integrations module)
--
-- Before this migration `ApiKeysController` created the table at runtime with
-- `$executeRawUnsafe` on the first successful POST, catching SQLSTATE 42P01 to
-- detect its absence. That left the schema dependent on request traffic: reads
-- silently returned an empty list until someone happened to create a key, the
-- table was invisible to Prisma, and it carried neither RLS nor indexes. The
-- table is now declared here like every other tenant table.
--
-- `key_hash` stores SHA-256 of the raw key; the raw value is returned once at
-- creation and never persisted. Rows are hard-deleted on revoke — a revoked
-- credential must stop authenticating, so the soft-delete rule does not apply.

CREATE TABLE IF NOT EXISTS "api_keys" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "business_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    -- Display-only leading fragment of the raw key, e.g. "gs_a1b2c3d"
    "prefix" VARCHAR(20) NOT NULL,
    -- Display-only trailing fragment, rendered as prefix••••last4
    "last4" VARCHAR(8) NOT NULL DEFAULT '',
    -- SHA-256 hex digest of the raw key
    "key_hash" VARCHAR(64) NOT NULL,
    -- Granted scopes, e.g. {conversations:read,orders:write}
    "scopes" TEXT[] NOT NULL DEFAULT '{}',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "last_used_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_keys_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE,
    CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "team_members"("id") ON DELETE SET NULL
);

-- ─────────────────────────────────────────────
-- REPAIR: environments where the runtime path already created the table
--
-- `CREATE TABLE IF NOT EXISTS` above is a no-op there, and that older table has
-- no foreign keys and a nullable `created_at`. Bring it up to the declared
-- shape. Every step is a no-op on a table this migration just created.
-- ─────────────────────────────────────────────

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "last4" VARCHAR(8) NOT NULL DEFAULT '';
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "scopes" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "api_keys" ALTER COLUMN "created_at" SET DEFAULT now();
UPDATE "api_keys" SET "created_at" = now() WHERE "created_at" IS NULL;
ALTER TABLE "api_keys" ALTER COLUMN "created_at" SET NOT NULL;

-- Orphaned tenant rows cannot satisfy the FK; a key whose business is gone is
-- unusable anyway.
DELETE FROM "api_keys" a
  WHERE NOT EXISTS (SELECT 1 FROM "businesses" b WHERE b."id" = a."business_id");
UPDATE "api_keys" a SET "created_by" = NULL
  WHERE a."created_by" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "team_members" t WHERE t."id" = a."created_by");

DO $$ BEGIN
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "team_members"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Authentication looks a key up by its digest alone, so the digest must be
-- globally unique rather than unique per business.
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX IF NOT EXISTS "idx_api_keys_business_created" ON "api_keys"("business_id", "created_at" DESC);

-- ─────────────────────────────────────────────
-- ROW-LEVEL SECURITY (tenant isolation backstop)
-- Uses the app.current_business_id session var set by withTenant().
-- ─────────────────────────────────────────────

ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS; drop-then-create keeps the whole
-- migration replayable, which the repair path above depends on.
DROP POLICY IF EXISTS "api_keys_tenant_isolation" ON "api_keys";
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys"
  USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
