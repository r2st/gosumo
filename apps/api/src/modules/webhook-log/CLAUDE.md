# Module: webhook-log

Inbound webhook **observability** and **recovery**. Two halves that share a subject:

1. Read-only inspection over deliveries recorded in `webhook_events` — search, filter, and audit every webhook GoSumo received (WhatsApp, Instagram, Razorpay, Stripe…).
2. The **dead-letter queue** (`webhook_dead_letters` + the `webhook-dlq` Bull queue): a delivery whose handler threw is parked and retried with exponential backoff, instead of being lost.

## Why the DLQ exists

`webhook_events` is the *idempotency* ledger — it records the delivery **before** processing it, and its `[source, external_id]` unique constraint makes a provider redelivery a no-op. That is exactly why a failed delivery could not be recovered from it: the provider's own retry was swallowed as a duplicate, so the first failure was permanent. A captured payment whose handler threw would sit PENDING until reconciliation happened to notice.

So recovery lives in a separate table with its own attempt counter, backoff schedule, and operator lifecycle — leaving the idempotency guarantee the writing modules depend on untouched.

## Public API

```typescript
// WebhookLogService — the delivery log
list(businessId, query): Promise<PaginatedWebhookEventsDto>
get(businessId, id): Promise<WebhookEventDetailDto>
getStats(businessId, from?, to?): Promise<WebhookStatsDto>

// WebhookDlqService — the recovery path
registerReplayer(source, handler): void          // called by the provider-owning module
capture(delivery, error, now?): Promise<webhook_dead_letters | null>   // never throws
runRetry(businessId, id, now?): Promise<WebhookRetryOutcome>
replayNow(businessId, id): Promise<WebhookReplayResultDto>
sweepDue(now?, limit?): Promise<number>
list / get / stats / pendingDepth / queueHealth / resolve
```

## Backlog monitoring

`GET webhook-log/dlq/health` grades the platform-wide PENDING count against
`WEBHOOK_DLQ_DEPTH_WARN` (25) and `WEBHOOK_DLQ_DEPTH_FAIL` (100) →
`pass` / `warn` / `fail`, or `unknown` when the count itself cannot be read.

A rising backlog is the one webhook symptom nothing else surfaces: the provider
got its 200, the delivery is in `webhook_events`, the retry schedule is being
kept — and every attempt is failing on its way to DISCARDED.

It is **not** part of `/health/ready` on purpose. The depth is platform-wide, so
folding it in would take every instance out of the load balancer at once and
turn "some webhooks are failing" into "the API is down".

## Retry policy

| Attempt | Wait before it |
|---|---|
| 1 | *(the live delivery)* |
| 2 | 30s |
| 3 | 1m |
| 4 | 2m |
| 5 | 4m |
| 6 | 8m |

Doubling, capped at one hour (`webhookRetryBackoffMs`). After `max_attempts` (default 6) the entry becomes `DISCARDED` — **not deleted**: the payload stays readable and an operator can still replay it from `POST webhook-log/dlq/:id/replay`.

## Registering a replayer

A module that owns a provider teaches the DLQ how to re-run its events, in `onModuleInit`:

```typescript
this.webhookDlq.registerReplayer('RAZORPAY', async (payload) => {
  await this.dispatchRazorpayEvent(payload as RazorpayWebhookPayload);
});
```

The handler is **post-verification** by design: the payload only reached the DLQ because its signature already passed, and the raw bytes verification needs are not stored. It also skips the `webhook_events` idempotency write, which by definition already happened. Today `payment` registers `RAZORPAY` and `STRIPE`.

## Events

**Emits:** `webhook.deadletter.captured`, `.replayed`, `.discarded`, `.resolved`

**Listens to:** none

## Tables Owned

- `webhook_dead_letters` — parked deliveries. Owned by this module.

`webhook_events` is **not** owned here: it is written by `channel-adapter` (channel webhooks) and `payment` (gateway webhooks); this module only reads it, the same read-only-across-modules pattern `analytics` uses.

## Dependencies

Prisma, `@nestjs/bull` (the `webhook-dlq` queue), `EventEmitter2`.

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/webhook-log
```

## Key Gotchas

- **`webhook_events` stays read-only from here.** Recovery state lives in `webhook_dead_letters` precisely so the `[source, external_id]` idempotency guarantee is never at risk.
- **`capture()` never throws.** It runs inside a webhook handler's catch block; a DLQ failure that propagated would turn one lost event into a 500 the provider retries — straight back into the dedupe wall. A capture that cannot be persisted is logged loudly and swallowed.
- **Bull retries are deliberately off** (`attempts: 1` on every job). The attempt budget and backoff live in the DB row; a second retry engine on top would spend all six attempts in seconds.
- **`next_retry_at` is the source of truth, not the queue.** A repeatable sweep (`*/5 * * * *`) re-enqueues entries whose backoff elapsed but whose job never arrived — a flushed Redis, or a crash between the DB write and the enqueue.
- **`business_id` is nullable** on `webhook_dead_letters`, mirroring `webhook_events`: a gateway webhook can fail before its payment row is readable. `payment` resolves the tenant best-effort at capture time; when it cannot, the entry is platform-level and invisible to the per-business API (but still retried, and still counted by `pendingDepth()`).
- **List responses omit `payload`/`headers`** for size and because payloads can carry customer PII — only the single-entry `get()` includes them. Same rule on both halves of the module.
- **DLQ routes are declared above `GET :id`** in the controller, so the literal `dlq` segment is matched before the wildcard param that would otherwise swallow it.
- **`getStats` defaults to a trailing 7-day window** (shorter than analytics' 30-day default — webhook health is an operational, near-real-time concern).
