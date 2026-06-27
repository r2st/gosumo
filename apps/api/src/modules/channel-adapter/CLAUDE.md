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
- **WhatsApp rate limit:** 80 msg/sec per phone number — outbound sends are rate-limited via Redis; do not bypass
- Adding a new channel = implement the `ChannelAdapter` interface from `@gosumo/shared` and register it in `channel-registry.ts`
- **Outbound retry policy:** 3 attempts with exponential backoff (1s → 4s → 16s); emit `message.failed` after the third failure
