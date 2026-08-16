# Module: analytics

Aggregates operational data from across the platform and serves it to the dashboard. Pre-aggregates into time-series buckets via BullMQ background workers to keep dashboard queries fast. Read-only — never writes to other modules' tables.

## Purpose

Track and serve the metrics that matter most: conversation volumes, AI autonomy rate (the primary GoSumo KPI), response times, top intents, revenue, campaign performance, and staff productivity.

## Public API (IAnalyticsService)

```typescript
getConversationMetrics(businessId, query): Promise<ConversationMetricsDto>
getIntentBreakdown(businessId, query): Promise<IntentBreakdownDto[]>
getResponseTimeMetrics(businessId, query): Promise<ResponseTimeMetricsDto>
getConversationQualityMetrics(businessId, query): Promise<ConversationQualityDto>
getAutonomyMetrics(businessId, query): Promise<AutonomyMetricsDto>
getConfidenceDistribution(businessId, query): Promise<ConfidenceDistributionDto>
getOrderMetrics / getRevenueTimeSeries / getBookingMetrics
getCampaignMetrics(businessId, query): Promise<CampaignMetricsDto>
getStaffMetrics(businessId, query): Promise<StaffMetricsDto[]>
getClientAcquisitionMetrics / getClientRetentionMetrics
getDashboardSummary(businessId): Promise<DashboardSummaryDto>
exportReport(businessId, query): Promise<ExportedReportDto>   // CSV download
getAiSummary(businessId, query?): Promise<AiSummaryDto>       // OpenRouter narrative summary
```

## Events

**Emits:** none (analytics is read-only)

**Listens to:**
- `conversation.resolved` → update daily conversation aggregates
- `ai.auto.executed` → update AI decision aggregates
- `order.created`, `order.delivered` → update order/revenue aggregates
- `campaign.sent`, `campaign.completed` → update campaign aggregates
- `task.resolved` → update HITL aggregates

## Tables Owned

- `analytics_events` — high-volume raw event stream, partitioned by `created_at` month
- `audit_logs` — immutable append-only audit records (shared ownership; analytics reads only)

## Dependencies

- `@gosumo/shared` — all domain event types (listener only)
- Direct read-only SQL queries on: `conversations`, `ai_decisions`, `orders`, `campaigns`, `tasks`, `messages`
- Redis — dashboard summary cache (TTL: 5 minutes)
- `ai-engine`'s `LlmClientService` (OpenRouter) — for `getAiSummary` only; instantiated as its own provider here rather than importing `AiEngineModule`, since it has no dependencies beyond `ConfigService`

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/analytics
```

## Key Gotchas

- **Dashboard summary is cached in Redis for 5 minutes** — on cache miss, run live query and re-cache; never return a 404 for a missing summary
- **The dashboard cache key is dated** (`…:analytics:dashboard:YYYY-MM-DD`, UTC) — every field on it measures `[UTC midnight, now)`, so a day-less key would serve the previous day's counts for up to a TTL after rollover. The key and the window come from a single clock read
- **`getClientAcquisitionMetrics.byChannel` is a partition, not a tally** — each new client is attributed to the one channel they arrived on (earliest `channel_contacts.first_seen_at`). Since clients are matched across channels, grouping contacts by channel would count one acquisition once per channel and push the percentages past 100
- **Autonomy rate = `autoExecuted / totalDecisions × 100`** — this is the primary GoSumo KPI; ensure it is always accurate and never returns 0 when decisions exist
- **All monetary metrics returned in paise** (integer) — frontend converts to rupees. Never return rupees from API endpoints
- **Date range queries are capped at 365 days** — return 422 `DATE_RANGE_TOO_LARGE` for larger ranges
- **`analytics_events` is partitioned** by `created_at` month in production — all queries must include a `created_at` range filter or Postgres cannot prune partitions efficiently
- **Aggregation worker runs hourly** and processes the last 2 hours (idempotent) — handles late-arriving events without double-counting
- **Zero data for a date range returns empty arrays**, not errors — never throw 404 for an empty time series
- **Cross-tenant isolation is critical** — every aggregation query must include `business_id = :businessId`; test this explicitly in integration tests
- `analytics_events` and `audit_logs` are append-only — never run UPDATE or DELETE on these tables
- **`getAiSummary` fails open** — if OpenRouter is unavailable or `OPENROUTER_API_KEY` is unset, it returns a deterministic, numbers-only summary with `aiGenerated: false` instead of throwing. Never surface an LLM outage as an API error here.
- **Conversation quality scopes resolution by `resolved_at`, not `created_at`** — a conversation opened in March and closed in April belongs to April. Scoping by creation makes the current period's resolution rate permanently understated (its newest conversations have not had time to close), which is the classic way a resolution chart trends down while nothing has got worse. It also means `resolutionRate` can exceed 100% in a period spent clearing a backlog — true, and not clamped
- **First-contact resolution needs both halves**: exactly one inbound message *and* no human takeover, with "escalated" read off `ai_decisions` rather than the conversation's current status (status is where it ended, not where it has been)
- **The CSAT proxy is not a measurement and is never blended silently into the explicit score.** `csat.explicit*` and `csat.proxy*` are reported separately with their own sample sizes, and every response carries `csat.proxyModel` — the four parameters that produced the number. Explicit ratings exist on well under 1% of conversations for a tenant that sends no survey, so a real-CSAT-only trend line is computed over a tiny self-selected sample
- **Proxy signal groups, not per-conversation rows** — `getCsatSignals` groups by the four booleans, so a tenant with a million resolved conversations returns at most 16 rows and the scoring policy stays in `conversation-quality.util.ts` where it is readable and unit-testable without a database
- **`exportReport` reuses the same JSON-endpoint methods** (`getConversationMetrics`, `getRevenueMetrics`, etc.) and just renders the result as CSV — it is not a separate query path, so the 30-day default / 365-day cap apply identically

