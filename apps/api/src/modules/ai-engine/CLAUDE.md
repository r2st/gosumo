# Module: ai-engine

The cognitive core of GoSumo. Receives conversation context, classifies intent, retrieves business knowledge via RAG, calls an LLM through **OpenRouter** (free-tier models, OpenAI-compatible chat-completions API), scores confidence deterministically, and routes the result to auto-execute, draft review, or full escalation. Also owns the knowledge base ingestion pipeline.

## Purpose

Classify intent, retrieve RAG context from Qdrant, assemble system prompts, call the LLM via OpenRouter, parse structured responses, score confidence, and route to the correct action path.

## Public API (IAIEngineService)

```typescript
processMessage(businessId, dto: ProcessMessageDto): Promise<AIDecisionDto>
ingestKnowledgeBase(businessId, dto: IngestKnowledgeDto): Promise<IngestResultDto>
deleteKnowledgeEntry(businessId, entryId): Promise<void>
searchKnowledgeBase(businessId, query, limit?): Promise<KnowledgeEntryDto[]>
classifyIntent(businessId, text): Promise<IntentClassificationDto>
scoreConfidence(businessId, dto): Promise<ConfidenceScoreDto>
getDraftDecision(businessId, decisionId): Promise<AIDecisionDto>
regenerateDraft(businessId, decisionId, feedback?): Promise<AIDecisionDto>
```

## Confidence Formula

```
confidence = (data_availability × 0.5) + (policy_clarity × 0.5)
```

**Hard overrides (force confidence to 0 regardless of formula):**
- Price requested but item not in catalog — fed by `CatalogMatchService` (pipeline), which runs only for price-bearing intents and only for tenants that actually keep a catalog
- Refund exceeds `maxRefundAmountPaise` from business policy
- Customer message contains legal threat keywords
- Loop: >3 consecutive exchanges with identical intent
- Client sentiment below configured threshold

## Events

**Emits:**
- `ai.intent.classified` — `{ businessId, conversationId, messageId, intentCategory, confidence }`
- `ai.response.generated` — `{ businessId, conversationId, decisionId, band, draftResponse }`
- `ai.auto.executed` — `{ businessId, conversationId, decisionId, action }`
- `ai.escalated` — `{ businessId, conversationId, reason }`

**Listens to:**
- `message.received` — queues `processMessage()` via BullMQ `ai-process` queue
- `ai.response.approved` (from `hitl`) — sends the approved draft via `channel-adapter`
- `business.settings.updated` — invalidates cached AI config in Redis

## Tables Owned

- `ai_decisions` — immutable record of every AI decision, confidence breakdown, token usage, override tracking
- `ai_precedents` — learned patterns from human corrections, fed back into RAG pipeline
- `vector_embeddings_metadata` — Postgres-side tracking of what is embedded in Qdrant

## Dependencies

- `@gosumo/message` — `getLastNMessages()`, `attachAIMetadata()`
- `@gosumo/conversation` — `getConversationContext()`
- `@gosumo/catalog` — `searchCatalog()`, `getEffectivePrice()`
- `@gosumo/booking` — `getAvailableSlots()`
- `@gosumo/payment` — `createPaymentLink()`
- `@gosumo/order` — `getOrderStatus()`
- `@gosumo/tenant` — `getAIConfig()`, `getPolicies()`
- OpenRouter (via `fetch`, no provider SDK), Qdrant client, BullMQ

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/ai-engine
```

## Key Gotchas

- **Customer messages are untrusted input** — always wrap in `<customer_message>` XML tags inside the prompt and explicitly mark as untrusted
- **AI cannot invent data** — all factual claims must come from RAG-retrieved business data or direct catalog/booking queries; if data is unavailable, hard override applies
- **Every LLM call must have `max_tokens`** — prevents runaway cost; set to a per-intent-specific cap
- **Token usage must be logged** on every `ai_decisions` row (`prompt_tokens`, `completion_tokens`, `latency_ms`) — needed for cost tracking
- **BullMQ deduplication:** job ID includes `messageId` so the same message is never processed twice even if `message.received` is emitted twice
- **Qdrant unavailable:** proceed without RAG context; penalize `data_availability` in confidence calculation — do not block the pipeline
- **LLM timeout (>8s):** retry once; if still fails, escalate the conversation via HITL task
- RAG max chunks: 5 (defined in `ai-engine.constants.ts`). Always pass the top-5 by similarity score, not all matches
- `ai_decisions` is immutable — never UPDATE a decision record; create a new one for regenerated drafts
- **An override the pipeline never feeds is not a control** — `PRICE_NOT_IN_CATALOG` and `REFUND_OVER_LIMIT` were both implemented in the calculator while nothing supplied their inputs, so both sat dark and the cases they name auto-executed. When adding an override, wire its input in `runPipeline` in the same change, and cover it end-to-end in `ai-engine.service.spec.ts` — a calculator unit test passes either way
- **`requiresEscalation` outranks the band in every arm of `ActionRouterService`**, AUTO_PILOT included. That the two cannot currently co-occur is arithmetic between `OVERRIDE.*.forceScore` and `MIN_AUTO_EXECUTE_BAND`, not a property of the router
