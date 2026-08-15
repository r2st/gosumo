# Module: notification

Multi-channel outbound notification delivery for GoSumo: email, SMS, WhatsApp, and push. Owns templates, event-driven triggers, client preferences/opt-outs, per-channel rate limiting, delivery tracking, retries, and history.

## Purpose

Turn domain events (`booking.created`, `order.confirmed`, `payment.success`, …) and operator-initiated sends into reliably delivered, preference-respecting notifications across every channel — without other modules knowing any provider details.

## Public API (NotificationService)

```typescript
// Dispatch
dispatch(businessId, dto: DispatchNotificationDto): Promise<DispatchResultDto>
dispatchBatch(businessId, dto: DispatchBatchDto): Promise<BatchResultDto>
processDispatch(businessId, notificationId): Promise<void>   // Bull processor
processBatch(businessId, notificationIds): Promise<void>      // Bull processor
handleEventTrigger(eventType, payload): Promise<void>         // event listener

// Delivery tracking
updateDeliveryStatus(businessId, idOrProviderId, dto): Promise<NotificationDto>
retryNotification(businessId, id): Promise<NotificationDto>
listNotifications / getNotification / getStats

// Templates
createTemplate / updateTemplate / listTemplates / getTemplate / deleteTemplate / previewTemplate

// Preferences
setPreference(businessId, dto): Promise<PreferenceDto>
getPreferences(businessId, clientId): Promise<PreferenceDto[]>

// Triggers
createTrigger / updateTrigger / listTriggers / deleteTrigger
```

## Events

**Emits:**
- `notification.queued` — accepted into the dispatch queue
- `notification.sent` — handed to the channel provider
- `notification.delivered` — provider confirmed delivery (via receipt)
- `notification.failed` — permanently failed after exhausting retries
- `notification.skipped` — not sent due to opt-out / missing address

**Listens to:** `booking.*`, `order.*`, `payment.*` (see `SUPPORTED_TRIGGER_EVENTS`) — each event fans out to the business's configured triggers, or a built-in default.

## Tables Owned

- `notifications` — one row per dispatch; delivery state, retry bookkeeping, history
- `notification_templates` — per-tenant, per-channel templates with `{{ variable }}` bodies
- `notification_preferences` — per-client opt-in/opt-out + quiet hours, per channel/category
- `notification_triggers` — event → channel/template mapping with delay + JSON conditions

## Architecture

`controller → service → repository`. Channel transports implement the `ChannelSender`
interface and are resolved via `SenderRegistry` (mirrors channel-adapter's registry).
Delivery runs on the `notifications` Bull queue via `NotificationProcessor`.

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/notification
```

## Key Gotchas

- **Opt-out bypass:** TRANSACTIONAL and SYSTEM notifications ignore marketing opt-outs (receipts must always send); MARKETING and REMINDER honour every opt-out. An explicit per-(channel, category) preference row is honoured even for transactional. See `categoryHonoursOptOut()`.
- **Quiet hours** apply only to REMINDER/MARKETING and are expressed in IST minutes-from-midnight; a notification inside the window is deferred to the window's end via `scheduledAt`.
- **Idempotency:** `(business_id, dedupe_key)` is unique. Event triggers derive a dedupe key of `event:entityId:channel`, so a re-emitted event never double-sends.
- **Retry bookkeeping is owned by the service, not Bull.** Dispatch jobs are added with `attempts: 1`; transient failures re-queue with `RETRY_BACKOFF_MS` backoff up to `max_attempts`. Permanent failures (bad address, unapproved template) fail fast.
- **Therefore `processDispatch` must never let an exception escape.** With `attempts: 1` Bull will not re-run it, so a throw strands the row in QUEUED — never sent, never failed, never retried, and silent to `notification.failed` consumers. Sender resolution and payload rendering are wrapped and converted into a `SendOutcome` so the normal retry/permanent-fail path records them. `SenderRegistry.get()` throws for an unregistered channel, and `ChannelSender.send` is documented never to throw — do not add fallible work outside that guard.
- **`recoverStuck` is the backstop under all of that, not a substitute for it.** The row lives in Postgres and the job lives in Redis with no transaction across the two, so every path that writes one then enqueues the other has a window: `dispatchBatch` writes all the rows and then enqueues in chunks (a failed chunk logs "written but not enqueued" and leaves them PENDING); the retry path writes `QUEUED, attempts+1` *before* adding the delayed job; and a Redis flush, failover onto an empty replica, or unpersisted restart drops every delayed job at once. A repeatable job (`recover-stuck`, `STUCK_RECOVERY_CRON`, every 15 min) re-enqueues anything non-terminal and older than `STUCK_NOTIFICATION_AFTER_MS` (30 min — past the longest retry backoff, so it never races a job that is merely waiting), and fails out rows whose attempts are already spent so `notification.failed` actually fires. It **enqueues before writing the status** on purpose: the other order re-creates the exact stranding it is fixing. `findStuckGlobal` is the module's only unscoped query — it returns `{id, business_id}` and nothing else, and the sweep re-reads each row through the tenant-scoped `findById` (which is also what makes it re-check the row has not gone terminal since the scan). It is listed in `repository-contract.spec.ts`'s `GLOBAL_SWEEPS` for that reason.
- **Rate limiting** is per (business, channel), fixed-window (`CHANNEL_RATE_LIMITS`). A throttled dispatch is re-queued **without** consuming an attempt.
- **Senders are provider-agnostic stubs** when no credentials are configured (dev/test) — they log + return a synthetic provider id so the full pipeline runs. Wire real providers (SES/Resend, MSG91/Twilio, Meta WA Cloud, FCM) inside each sender's `send()`.
- **`dispatchBatch` validates every `clientId` up front, in one query, and rejects the whole submission if any fails to resolve inside the tenant** — a foreign business's client id looks exactly like a stale one here. Per-recipient validation mid-loop would half-commit the batch: rows written for everyone ahead of the bad entry, no batch id returned, and nothing enqueued to send or fail them. Failures *after* validation (a create or an enqueue that errors) are counted into `BatchResultDto.failed` and the batch continues — a non-zero `failed` is the only place a caller can see a partial send.
- **Never reach into other modules' tables.** Recipient contact details are read from the `clients` row only.
- All monetary values in template data remain in paise; format in the template/frontend.
