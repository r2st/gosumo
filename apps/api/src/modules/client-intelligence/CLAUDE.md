# Module: client-intelligence

Builds and maintains rich profiles of each business's customers. Processes every inbound message to extract facts (name, preferences, location), tracks sentiment over time, computes churn risk (RFM model), estimates lifetime value (LTV), and maintains Qdrant vectors for semantic search over client history.

## Purpose

Turn raw message volume into actionable client intelligence that the AI reads before responding to personalize interactions and that operators use to prioritize customer outreach.

## Public API (IClientIntelligenceService)

```typescript
findOrCreateClient(businessId, dto: FindOrCreateClientDto): Promise<ClientProfileDto>
getClientProfile(businessId, clientId): Promise<ClientProfileDto>
getClientByExternalId(businessId, externalId, channelType): Promise<ClientProfileDto | null>
updateClientProfile(businessId, clientId, dto): Promise<ClientProfileDto>
listClients(businessId, query): Promise<PaginatedResult<ClientProfileDto>>
mergeClients(businessId, primaryId, secondaryId): Promise<ClientProfileDto>
extractAndStoreFacts(businessId, clientId, messageId, text): Promise<ClientFactDto[]>
recordSentiment(businessId, clientId, messageId, score): Promise<void>
getClientSentimentTrend(businessId, clientId, days): Promise<SentimentTrendDto>
getChurnScore(businessId, clientId): Promise<ChurnScoreDto>
getLTVEstimate(businessId, clientId): Promise<LTVEstimateDto>
getClientSegment(businessId, clientId): Promise<ClientSegmentDto>
getClientTimeline(businessId, clientId, limit?): Promise<ClientTimelineDto>
refreshIntelligenceScores(businessId, clientId): Promise<void>
getClientSummaryForAI(businessId, clientId): Promise<ClientAISummaryDto>
```

## Segmentation

`getClientSegment()` classifies a client into one behavioural segment derived from RFM + churn. Precedence (highest first): **LOST** (>180d inactive) → **VIP** (≥10 orders or ≥₹50k spent, active ≤60d) → **AT_RISK** (≥1 order + HIGH/CRITICAL churn) → **DORMANT** (60–180d inactive) → **NEW** (tenure ≤30d, ≤1 order) → **ACTIVE** (default).

## Timeline

`getClientTimeline()` merges conversations, orders, bookings, and payments into one newest-first chronological stream (`TimelineEventDto[]`), each capped at `limit` per source then re-sorted and sliced. Monetary fields are returned in paise. `payments` has no `deleted_at` column — do not filter it by soft-delete.

## Events

**Emits:**
- `client.profile.updated` — `{ businessId, clientId, changedFields }`
- `client.churn.risk` — `{ businessId, clientId, churnScore, riskLevel }` (fires only on boundary crossing)
- `client.fact.extracted` — `{ businessId, clientId, factType, value }`

**Listens to:**
- `message.received` — async fact extraction and sentiment recording via BullMQ
- `order.delivered` — update LTV, reset churn risk
- `booking.created` — update last engagement date
- `payment.success` — update LTV

## Tables Owned

- `clients` — core identity, intelligence scores (`churn_risk`, `ltv_score`, `engagement_score`), opt-out tracking
- `channel_contacts` — maps channel-specific external IDs (phone, IG handle) to internal `client` records

## Dependencies

- `@gosumo/shared` — `ChannelType`, client event types
- `@gosumo/message` — reads message text for fact extraction
- Qdrant client — upsert and search client profile vectors
- Anthropic SDK — lightweight fact extraction LLM calls
- BullMQ — async intelligence refresh jobs

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/client-intelligence
```

## Key Gotchas

- **One client per (businessId, externalId, channelType).** Same phone on WhatsApp and SMS = two `channel_contacts` pointing to one `client`. Merge is manual (operator-triggered via `mergeClients()`)
- **Churn risk event fires only on level boundary crossings** (e.g., MEDIUM → HIGH), not on every score update — prevents alert spam
- **Facts with confidence < 0.7 are stored but excluded** from `getClientSummaryForAI()` — low-confidence facts must not pollute the AI prompt
- `getClientSummaryForAI()` must return ≤300 chars — it is injected directly into the AI system prompt on every message
- **Sentiment scores:** -1.0 (very negative) to +1.0 (very positive). Clamp any out-of-range values — never throw
- **Fact extraction failure:** log warning, continue processing the message normally — intelligence is best-effort, not blocking
- Churn risk levels: LOW (0–30), MEDIUM (31–60), HIGH (61–80), CRITICAL (81–100) — stored as `Decimal(5,4)` in `clients.churn_risk` (0.0–1.0 scale)
- **LTV** is recalculated after every `order.delivered` and `payment.success` event — not in real-time during every message
