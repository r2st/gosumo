# Module: knowledge

PostgreSQL-backed FAQ and help articles, searchable by keyword and used to
ground AI answers.

## Purpose

Give a business a place to write down what it tells customers — refund windows,
COD limits, delivery times — and put that text in front of the model when a
customer asks about it.

## Why this exists next to `ai-engine/rag`

`ai-engine/rag` is the Qdrant-backed vector store. `RagRetrieverService.retrieve`
returns `[]` whenever Qdrant or the embedding provider is unreachable, and that
is correct: a sick vector store must not take the message pipeline down.

The consequence was that a deployment without Qdrant had **no grounding at all**,
silently — every answer went out on the model's general knowledge, and the only
signal was a depressed confidence score. Production runs without Qdrant by
design (`/health/ready` reports `vector: down` permanently), so that was the
live state, not a hypothetical.

These rows live in the PostgreSQL the API cannot start without. The two stores
are **merged**, not tried in order — a business with both gets both.

## Public API (`KnowledgeService`)

```typescript
create / update / publish / archive / remove
list(businessId, query)          // paginated, substring title filter
get / getBySlug
search(businessId, query)        // operator-facing ranked search, no floor
stats(businessId)

retrieveForAi(businessId, text, intent, limit?): Promise<GroundingArticle[]>
```

## Endpoints (controller path `knowledge`; `/v1` prefix)

| Route | Role |
|---|---|
| `POST /v1/knowledge` | MANAGER |
| `GET /v1/knowledge` | any |
| `GET /v1/knowledge/search` | any |
| `GET /v1/knowledge/stats` | any |
| `GET /v1/knowledge/slug/:slug` | any |
| `GET /v1/knowledge/:id` | any |
| `PATCH /v1/knowledge/:id` | MANAGER |
| `POST /v1/knowledge/:id/publish` | MANAGER |
| `POST /v1/knowledge/:id/archive` | MANAGER |
| `DELETE /v1/knowledge/:id` | MANAGER |

## Tables Owned

- `knowledge_articles` (migration 0045)
- the `knowledge_article_tsv(text, text[], text, text)` SQL function

## Dependencies

- `@gosumo/shared` — `IntentType`
- `@gosumo/database` — `KnowledgeArticleStatus`

`AiEngineModule` imports this module and injects `KnowledgeService` for
`retrieveForAi`. That is a synchronous read on the message hot path, which is
the case the root guidance says to use direct injection for.

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/knowledge
```

## Key Gotchas

- **The search index is a GIN index on a function, not on an expression.** The
  inline expression cannot be indexed at all: `to_tsvector(text, text)` and
  `array_to_string` are both only STABLE, and Postgres rejects a non-IMMUTABLE
  index expression outright. `knowledge_article_tsv` is declared IMMUTABLE to
  assert what the planner cannot derive. Editing the function body changes what
  is indexed — existing rows are reindexed by `REINDEX`, not automatically.
- **The query must call the function with the arguments in declared order.**
  Postgres matches an expression index by the whole call. `fn(title, summary,
  keywords, body)` compiles, runs, returns a differently-weighted vector, and
  never uses the index — a silent sequential scan, not an error.
  `knowledge.repository.spec.ts` pins this.
- **`status` and `ai_enabled` are two independent switches.** PUBLISHED controls
  operator visibility; `ai_enabled` controls whether the model may quote it. An
  article can be published for the team and withheld from customers. The AI path
  requires *both*.
- **Empty `applicable_intents` means every intent**, and it is the default. An
  article restricted to intents nobody classifies is invisible, and that failure
  is silent — prefer leaving it empty.
- **The slug is never re-derived from a changed title.** It is the stable handle
  a saved link points at. Renaming an article keeps its slug.
- **Slug uniqueness spans soft-deleted rows**, because the unique index does.
  `findTakenSlugs` deliberately omits the `deleted_at` filter — scoping it to
  live rows would pick a slug a deleted row still holds and fail a P2002.
- **`published_at` is when the article *first* went live.** Re-publishing an
  archived article keeps the original date rather than making it look newly
  written.
- **`retrieveForAi` never throws.** It swallows its own errors and returns `[]`,
  the same contract the vector retriever honours. Do not add a `.catch()` at the
  call site expecting it to reject.
- **The score floor deliberately sits below a lone body match** (0.05 against a
  D-weight of 0.1). See `knowledge.constants.spec.ts`, which pins the
  relationship against the migration's weights.
