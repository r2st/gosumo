# Module: conversation-search

Full-text search across conversation history. Reads `messages` for the match and joins `conversations` and `clients` for the context on a result row. Writes nothing and owns no table.

## Purpose

Give the inbox a real search box: ranked, phrase-aware, filterable by customer, conversation, channel, status and date range, and tenant-isolated at every level.

## Public API (IConversationSearchService)

```typescript
searchMessages(businessId, query): Promise<MessageSearchResultDto>       // one row per message
searchConversations(businessId, query): Promise<ConversationSearchResultDto>  // one row per thread
```

## Events

**Emits:** none
**Listens to:** none

## Tables Owned

None. Read-only over `messages`, `conversations`, `clients` — the same arrangement `analytics` uses, and for the same reason: the query spans tables that belong to different modules and belongs to none of them.

## Dependencies

- `@gosumo/shared` — `ChannelType`, `ConversationStatus`
- `messages.search_vector` — a generated `tsvector` column, and the composite `(business_id, search_vector)` GIN index, both from migration 0042

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/conversation-search
```

## Key Gotchas

- **The text-search config is `'simple'`, not `'english'`** — this is an Indian multi-channel inbox and one thread routinely mixes English, transliterated Hindi and Devanagari. English stemming mangles the first, does nothing for the second, and drops the third's tokens as non-words. `'simple'` also keeps stop-words, so "the offer" finds a message about "the offer"
- **`websearch_to_tsquery`, never `to_tsquery`** — `to_tsquery` raises a syntax error on input a person would reasonably type (an unbalanced quote, a trailing `&`), which turns a typo into a 500. `plainto_tsquery` never errors but silently discards quotes and operators, so a phrase search becomes an AND of its words
- **Snippets are plain text plus offsets, never markup.** `ts_headline` returns HTML and does no escaping of the document it highlights — and the document is `messages.text_content`, bytes a customer typed. The one place in the product where an attacker picks the markup is the one place a highlighted snippet gets rendered. `search-snippet.util.ts` builds the window in TypeScript instead, which also skips `ts_headline`'s per-row re-parse of the document
- **The snippet tokenizer allows `\p{M}`** — Devanagari vowel signs are combining marks, not letters, so a `[\p{L}\p{N}]` class shreds an ordinary Hindi word and highlights the wrong span. Applies to every Indic script the inbox carries
- **`business_id` is filtered on `messages` *and* on the joined `conversations`.** Not redundancy: the composite GIN index can only prune to one tenant when the predicate is on the indexed table, so filtering on the join alone runs the text match across every tenant's rows and discards the others afterwards
- **`total` is capped at `SEARCH_COUNT_CEILING` (500)** and `totalIsExact` says whether it stopped there. Counting every match on a common term scans that term's whole posting list across the tenant's history — the one part of the query whose cost is not bounded by page size, paid on every keystroke of a type-ahead. Clients render "500+"
- **Ordering is `rank DESC, created_at DESC, id DESC`** — `ts_rank_cd` ties constantly on short messages, and an untied sort lets Postgres return a different page for two identical requests
- **Date filters apply to the *message*, not the conversation** — "March" means messages sent in March, so a thread open since January still matches on the message the caller is looking for
- **`deleted_at` is checked on the conversation only** — messages are append-only and have no soft-delete column, so a message's visibility is entirely its conversation's
