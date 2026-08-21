-- Migration: 0045_knowledge_articles
--
-- A PostgreSQL-backed FAQ/article store the AI can ground on.
--
-- Why this exists alongside the Qdrant RAG store: `RagRetrieverService`
-- returns `[]` whenever the vector database or the embedding provider is
-- unreachable, and that is the correct behaviour — a sick vector store must
-- not take the message pipeline down. The consequence is that a deployment
-- running without Qdrant has *no* grounding at all, silently: every answer
-- goes out on the model's general knowledge and the only signal is a lower
-- confidence score. These rows live in the PostgreSQL the API already cannot
-- start without, so knowledge survives that outage. Retrieval merges the two.
--
-- Idempotent throughout (IF NOT EXISTS / DO-block guards) so it can be applied
-- by psql against a database whose end state is the source of truth.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Status enum
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'KnowledgeArticleStatus') THEN
        CREATE TYPE "KnowledgeArticleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
    END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "knowledge_articles" (
    "id"                 UUID                     NOT NULL DEFAULT uuid_generate_v4(),
    "business_id"        UUID                     NOT NULL,
    "title"              VARCHAR(255)             NOT NULL,
    "slug"               VARCHAR(160)             NOT NULL,
    "summary"            TEXT,
    "body"               TEXT                     NOT NULL,
    "category"           VARCHAR(100),
    "tags"               TEXT[]                   NOT NULL DEFAULT ARRAY[]::TEXT[],
    "keywords"           TEXT[]                   NOT NULL DEFAULT ARRAY[]::TEXT[],
    "applicable_intents" TEXT[]                   NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status"             "KnowledgeArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "ai_enabled"         BOOLEAN                  NOT NULL DEFAULT true,
    "use_count"          INTEGER                  NOT NULL DEFAULT 0,
    "created_by"         UUID,
    "updated_by"         UUID,
    "published_at"       TIMESTAMPTZ,
    "created_at"         TIMESTAMPTZ              NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ              NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at"         TIMESTAMPTZ,

    CONSTRAINT "knowledge_articles_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Foreign keys
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_articles_business_id_fkey'
    ) THEN
        ALTER TABLE "knowledge_articles"
            ADD CONSTRAINT "knowledge_articles_business_id_fkey"
            FOREIGN KEY ("business_id") REFERENCES "businesses"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'knowledge_articles_created_by_fkey'
    ) THEN
        ALTER TABLE "knowledge_articles"
            ADD CONSTRAINT "knowledge_articles_created_by_fkey"
            FOREIGN KEY ("created_by") REFERENCES "team_members"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- Slug uniqueness is per business and spans soft-deleted rows deliberately:
-- see the revive path in KnowledgeRepository. A partial index excluding
-- deleted rows would let a delete free a slug that an old link still points at.
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_articles_business_id_slug_key"
    ON "knowledge_articles" ("business_id", "slug");

CREATE INDEX IF NOT EXISTS "knowledge_articles_business_id_status_updated_at_idx"
    ON "knowledge_articles" ("business_id", "status", "updated_at" DESC);

CREATE INDEX IF NOT EXISTS "knowledge_articles_business_id_category_idx"
    ON "knowledge_articles" ("business_id", "category");

-- Full-text search.
--
-- The vector is built by a named function rather than by an inline expression,
-- for two reasons.
--
-- 1. **Postgres will not index the inline form.** An index expression must be
--    IMMUTABLE, and two of the functions involved are only STABLE:
--    `to_tsvector(text, text)` resolves its configuration name at call time,
--    and `array_to_string(anyarray, text)` may call a type output function.
--    Both are immutable *in this use* — a pinned `regconfig` and a `text[]`
--    column — but Postgres cannot know that, so it refuses the index with
--    "functions in index expression must be marked IMMUTABLE". Wrapping them
--    in a function declared IMMUTABLE is the supported way to assert what the
--    planner cannot derive. (`to_tsvector` still takes the `::regconfig`
--    overload inside: the wrapper asserts immutability, it does not make a
--    search-path-dependent lookup safe.)
--
-- 2. **It makes drift impossible.** Postgres only uses an expression index
--    when the query repeats the expression exactly, and a mismatch does not
--    error — the planner silently falls back to a sequential scan over the
--    tenant's articles, which stays correct and gets slower with every article
--    added. With one function, the index and `KNOWLEDGE_TSVECTOR_SQL` on the
--    repository both name it and cannot disagree about its body.
--
-- The weights are the whole point of storing `keywords` separately: A (title)
-- and B (keywords) outrank C (summary) and D (body), so an article whose title
-- is "Cash on delivery" beats one that merely mentions the phrase in passing.
--
-- `coalesce` on every part is required, not defensive: `to_tsvector` over a
-- NULL returns NULL, and one NULL in the concatenation would erase the whole
-- vector — an article with no summary would become unfindable by its title.

CREATE OR REPLACE FUNCTION "knowledge_article_tsv"(
    "title"    TEXT,
    "keywords" TEXT[],
    "summary"  TEXT,
    "body"     TEXT
) RETURNS tsvector
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
AS $$
    SELECT setweight(to_tsvector('english'::regconfig, coalesce($1, '')), 'A') ||
           setweight(to_tsvector('english'::regconfig, coalesce(array_to_string($2, ' '), '')), 'B') ||
           setweight(to_tsvector('english'::regconfig, coalesce($3, '')), 'C') ||
           setweight(to_tsvector('english'::regconfig, coalesce($4, '')), 'D')
$$;

CREATE INDEX IF NOT EXISTS "knowledge_articles_search_idx"
    ON "knowledge_articles"
    USING GIN ("knowledge_article_tsv"("title", "keywords", "summary", "body"));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Row-level security (tenant isolation backstop)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "knowledge_articles" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'knowledge_articles'
          AND policyname = 'knowledge_articles_tenant_isolation'
    ) THEN
        CREATE POLICY "knowledge_articles_tenant_isolation" ON "knowledge_articles"
          USING ("business_id" = current_setting('app.current_business_id', TRUE)::uuid);
    END IF;
END
$$;
