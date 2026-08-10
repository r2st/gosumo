# Module: analytics

Aggregates operational data from across the platform and serves it to the dashboard. Pre-aggregates into time-series buckets via BullMQ background workers to keep dashboard queries fast. Read-only — never writes to other modules' tables.

## Purpose

Track and serve the metrics that matter most: conversation volumes, AI autonomy rate (the primary GoSumo KPI), response times, top intents, revenue, campaign performance, and staff productivity.

## Public API (IAnalyticsService)

```typescript
getConversationMetrics(businessId, query): Promise<ConversationMetricsDto>
getIntentBreakdown(businessId, query): Promise<IntentBreakdownDto[]>
getResponseTimeMetrics(businessId, query): Promise<ResponseTimeMetricsDto>
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
- **Autonomy rate = `autoExecuted / totalDecisions × 100`** — this is the primary GoSumo KPI; ensure it is always accurate and never returns 0 when decisions exist
- **All monetary metrics returned in paise** (integer) — frontend converts to rupees. Never return rupees from API endpoints
- **Date range queries are capped at 365 days** — return 422 `DATE_RANGE_TOO_LARGE` for larger ranges
- **`analytics_events` is partitioned** by `created_at` month in production — all queries must include a `created_at` range filter or Postgres cannot prune partitions efficiently
- **Aggregation worker runs hourly** and processes the last 2 hours (idempotent) — handles late-arriving events without double-counting
- **Zero data for a date range returns empty arrays**, not errors — never throw 404 for an empty time series
- **Cross-tenant isolation is critical** — every aggregation query must include `business_id = :businessId`; test this explicitly in integration tests
- `analytics_events` and `audit_logs` are append-only — never run UPDATE or DELETE on these tables
- **`getAiSummary` fails open** — if OpenRouter is unavailable or `OPENROUTER_API_KEY` is unset, it returns a deterministic, numbers-only summary with `aiGenerated: false` instead of throwing. Never surface an LLM outage as an API error here.
- **`exportReport` reuses the same JSON-endpoint methods** (`getConversationMetrics`, `getRevenueMetrics`, etc.) and just renders the result as CSV — it is not a separate query path, so the 30-day default / 365-day cap apply identically

