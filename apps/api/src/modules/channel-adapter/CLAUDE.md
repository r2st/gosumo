# Module: channel-adapter

The translation layer between all external messaging channels and GoSumo's internal normalized message format. This is the only module that speaks channel-specific protocols — everything downstream works with `NormalizedMessage` only.

## Purpose

Receives raw webhook payloads from WhatsApp, Instagram, SMS, Web Chat, and Email; verifies HMAC signatures; normalizes messages; stores raw payloads for debugging; emits `message.received`; and routes outbound messages back to the correct channel.

## Public API (IChannelAdapterService)

```typescript
sendMessage(businessId, dto: SendMessageDto): Promise<SendResultDto>
sendTemplate(businessId, dto: SendTemplateDto): Promise<SendResultDto>
sendInteractive(businessId, dto: SendInteractiveDto): Promise<SendResultDto>
downloadMedia(businessId, channelType, mediaId): Promise<Buffer>
uploadMediaToStorage(buffer, mimeType, businessId): Promise<string>
getChannelStatus(businessId, channelType): Promise<ChannelStatusDto>
getChannelCapabilities(channelType): Promise<ChannelCapabilitiesDto>
```

## Events

**Emits:**
- `message.received` — `{ businessId, normalizedMessage: NormalizedMessage }`
- `message.sent` — `{ businessId, messageId, externalId, channel, deliveredAt }`
- `message.failed` — `{ businessId, messageId, channel, error, retryCount }`

**Listens to:**
- `message.send` — triggers outbound routing to the correct adapter

## Tables Owned

- `webhook_events` — raw webhook payloads, deduplication, processing status, signature validity
- (Channel credentials live in `channel_accounts`, owned by `tenant` module)

## Dependencies

- `@gosumo/shared` — `ChannelType`, `NormalizedMessage`, `MessageContent`, domain event types
- `@gosumo/tenant` — `getChannelConnection()` to retrieve encrypted credentials per business

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/channel-adapter
```

## Key Gotchas

- **Invalid webhook signatures return HTTP 200** (not 400) to prevent channel retry storms, but the payload is logged and discarded
- **Duplicate detection:** `external_id` + `source` in `webhook_events` has a unique constraint — duplicate webhook deliveries within 24h are silently skipped via this DB constraint
- **Media re-upload:** always download media from channel CDN immediately and re-upload to GoSumo S3 — channel CDN URLs expire and must never be stored directly
- **Web Chat** is a Socket.IO gateway, not an HTTP webhook endpoint — the same module, but different entry point
- **Web Chat outbound goes through the outbox**, not straight to a socket. `WebChatAdapter` has no socket and `WebChatGateway` has no adapter, so replies pass through `webchatResponseMap` in `webchat.adapter.ts`. Write to it with `enqueueWebChatResponse()` — never `.set()` directly: the helper is what notifies the gateway (registered as the delivery sink in its `onModuleInit`) and what applies the three ceilings. Undeliverable replies are bounded per session (`WEBCHAT_OUTBOX_MAX_PER_SESSION`, newest kept), per process (`WEBCHAT_OUTBOX_MAX_SESSIONS`, coldest shed) and by age (`WEBCHAT_OUTBOX_TTL_MS`). A visitor reconnecting flushes their backlog on `chat:init`.
- **Socket.IO events are not covered by the global `ValidationPipe`**, which only sees HTTP routes. `chat:message` validates its own body: `text` must be a non-empty string of at most `WEBCHAT_MAX_MESSAGE_CHARS` (4096). The throttle bounds message *count*; this bounds the size, which is what the stored row and the per-token LLM call actually cost.
- **`WebChatThrottle` has three charge points, and the order matters.** `init` is charged *before* the `channel_accounts` lookup, because an unknown widgetId returns early and would otherwise leave that query unrationed; `session` is charged after, and only for genuinely new sessions, so a reconnect loop never burns it; `message`/`messageIp` are charged per accepted message.
- **WhatsApp rate limit:** 80 msg/sec per phone number — outbound sends are rate-limited via Redis; do not bypass
- Adding a new channel = implement the `ChannelAdapter` interface from `@gosumo/shared` and register it in `channel-registry.ts`
- **Outbound retry policy:** 3 attempts with exponential backoff (1s → 4s → 16s); emit `message.failed` after the third failure
