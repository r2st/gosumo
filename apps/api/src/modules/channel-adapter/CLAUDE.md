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
- **`downloadMedia` fetches an address it did not choose**, so every implementation bounds it the same three ways via `common/utils/media-download.util.ts`: https-only (`isFetchableMediaUrl`), a content-type allow-list (`assertContentType`), and a streamed body read against a running total (`readBodyWithLimit`, 25 MB). Never use `response.arrayBuffer()` here — it allocates until the process dies, and the box shares 4 GB with Postgres and the web server. WhatsApp resolves a Meta-named CDN url; Instagram is handed `attachment.payload.url` straight off the webhook, which is why it also refuses a plaintext scheme. Use `VISUAL_MEDIA_CONTENT_TYPE_PREFIXES` for channel attachments — the audio list omits `image/` and would reject every photo
- **The `channel_accounts` lookup is memoized per webhook, not per message.** Every message in a batched payload resolves the same account, so a payload of N messages was issuing N identical queries on the hottest write path in the system. `ChannelAccountMemo` collapses them to one per distinct `(channel, external_id)`. It is **keyed, not hoisted** — Meta may put more than one `entry` in a payload and they need not name the same phone number id, and this row decides which tenant the message is written under. It is also **request-scoped**: caching across webhooks would keep serving an account that was since deactivated or re-pointed. Misses are memoized (a junk id re-asked per message is the same N+1); rejections are not (the delivery is dead-lettered and replayed)
- **Web Chat** is a Socket.IO gateway, not an HTTP webhook endpoint — the same module, but different entry point
- **`chat:init` is find-or-create twice over, and is serialized per session.** The client and the conversation are each a read that misses then a write, and a visitor drives two inits at once without meaning to — the widget re-inits with the same token on every reconnect, and a second tab replays it. Concurrently both reads miss, both write, and one visitor becomes two clients on two threads the operator sees as two different people. `ConversationLockService` keyed on `webchat:{widgetId}:{sessionId}` closes it in-process, the same guarantee `handleInboundWebhook` takes per (channel account, sender). Underneath, the `(channel_account_id, external_id)` unique constraint is the cross-process half: the client and its contact are written in one `$transaction` and a P2002 re-reads the winner's contact, so the loser reuses that client instead of failing the visitor's init — and the orphan `Web Visitor` row rolls back with the transaction rather than accumulating one per collision. `conversations` has no such constraint, so the lock is the only thing standing there
- **Web Chat outbound goes through the outbox**, not straight to a socket. `WebChatAdapter` has no socket and `WebChatGateway` has no adapter, so replies pass through `webchatResponseMap` in `webchat.adapter.ts`. Write to it with `enqueueWebChatResponse()` — never `.set()` directly: the helper is what notifies the gateway (registered as the delivery sink in its `onModuleInit`) and what applies the three ceilings. Undeliverable replies are bounded per session (`WEBCHAT_OUTBOX_MAX_PER_SESSION`, newest kept), per process (`WEBCHAT_OUTBOX_MAX_SESSIONS`, coldest shed) and by age (`WEBCHAT_OUTBOX_TTL_MS`). A visitor reconnecting flushes their backlog on `chat:init`.
- **Gateway teardown disconnects, it does not just unhook.** `onModuleDestroy` clears the delivery sink *and* hangs up every live session (`disconnect(true)`) before clearing all five socket maps. Clearing only the sink — which is what it did — stops new replies reaching a socket but leaves the socket connected, so the visitor's widget sat on an open connection to a process that had stopped answering until Nest tore Engine.IO down underneath it, with no `disconnect` event the client could react to. An explicit disconnect is what makes the widget reconnect onto the replacement process. The outbox is deliberately **not** cleared: it is module-global, survives this gateway, and holds replies the visitor has not seen — they flush on the next `chat:init` or age out on `WEBCHAT_OUTBOX_TTL_MS`. Sockets that connected but never inited are not disconnected (the gateway holds their id, not the socket, and they carry no session state); Nest closes the server under them.
- **Socket.IO events are not covered by the global `ValidationPipe`**, which only sees HTTP routes. Both handlers validate their own body, and the declared parameter types are a compile-time fiction — a frame can be `null`, a bare string, or an object of any shape. `chat:message` requires an object whose `text` is a non-empty string of at most `WEBCHAT_MAX_MESSAGE_CHARS` (4096). The throttle bounds message *count*; this bounds the size, which is what the stored row and the per-token LLM call actually cost.
- **`chat:init`'s `widgetId` must be a string before it reaches Prisma** (`readInitPayload`, checked before the throttle so junk costs nothing). It is passed to `channel_accounts.findFirst({ where: { id: widgetId } })`, and Prisma accepts a **filter object** there as readily as a string: `{"not": "<any uuid>"}` matched whatever active web-chat account came first, in *any* business, and the handler then created a `clients` row under that business's `business_id`. The widget id is the only thing between an anonymous socket and a tenant. A malformed `sessionId` is dropped rather than rejected — an unusable token already means "start a fresh session".
- **Two ceilings sit below the handlers.** `maxHttpBufferSize` is set to `WEBCHAT_MAX_FRAME_BYTES` (32 KB) on the gateway decorator, because `WEBCHAT_MAX_MESSAGE_CHARS` is checked only after Engine.IO has buffered and parsed the frame — its own default is 1 MB. And `WEBCHAT_MAX_SOCKETS_PER_IP` (50) bounds *connections*: `WebChatThrottle` rations events, so a socket that connects and never emits is charged by none of its buckets while still holding an Engine.IO session. The per-IP count is keyed on the address recorded at connect (`socketIp`), never re-derived at disconnect — a key that read differently on the way out would leak a slot per socket and turn the ceiling into a permanent lockout.
- **`WebChatThrottle` has three charge points, and the order matters.** `init` is charged *before* the `channel_accounts` lookup, because an unknown widgetId returns early and would otherwise leave that query unrationed; `session` is charged after, and only for genuinely new sessions, so a reconnect loop never burns it; `message`/`messageIp` are charged per accepted message.
- **WhatsApp rate limit:** 80 msg/sec per phone number — outbound sends are rate-limited via Redis; do not bypass
- Adding a new channel = implement the `ChannelAdapter` interface from `@gosumo/shared` and register it in `channel-registry.ts`
- **Outbound retry policy:** 3 attempts with exponential backoff (1s → 4s → 16s); emit `message.failed` after the third failure
