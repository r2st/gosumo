# Module: webhook-log

Read-only inspection over inbound webhook deliveries recorded in `webhook_events`. Lets a business (and support/ops) search, filter, and audit every webhook GoSumo received — WhatsApp, Instagram, Razorpay, etc.

## Purpose

Surface `webhook_events` — written by `channel-adapter` and `payment` as each inbound webhook is verified and recorded — through a searchable, paginated API plus delivery-health stats (processed rate, invalid-signature rate, volume by source).

## Public API (IWebhookLogService)

```typescript
list(businessId, query): Promise<PaginatedWebhookEventsDto>
get(businessId, id): Promise<WebhookEventDetailDto>
getStats(businessId, from?, to?): Promise<WebhookStatsDto>
```

## Events

**Emits:** none (read-only)

**Listens to:** none

## Tables Owned

None. `webhook_events` is written by `channel-adapter` (channel webhooks) and `payment` (Razorpay/Stripe webhooks) — this module only reads it, the same read-only-across-modules pattern `analytics` uses.

## Dependencies

None beyond Prisma.

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/webhook-log
```

## Key Gotchas

- **No replay/reprocess action.** `webhook_events` has a `[source, external_id]` unique constraint the writing modules rely on for idempotency — mutating rows from a second module risks breaking that guarantee, so this module is strictly read-only.
- **List responses omit `payload`/`headers`** for size and because payloads can carry customer PII — only the single-event `get()` includes them.
- **Only business-scoped events are visible** (`business_id = tenantId`); platform-level webhooks (`business_id IS NULL`, e.g. some pre-tenant-resolution deliveries) are out of scope for this per-business API.
- **`getStats` defaults to a trailing 7-day window** (shorter than analytics' 30-day default — webhook health is an operational, near-real-time concern).
