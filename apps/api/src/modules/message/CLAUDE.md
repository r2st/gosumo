# Module: message

Persistent storage, retrieval, and full-text search for all messages flowing through GoSumo — inbound from customers and outbound from AI or human agents. Maintains the complete conversation history that feeds both the AI context window and the dashboard conversation view.

## Purpose

Store every message exactly once, track delivery status, attach AI metadata, and provide pagination-aware retrieval for dashboard rendering and AI context assembly.

## Public API (IMessageService)

```typescript
storeInboundMessage(businessId, dto: StoreInboundMessageDto): Promise<MessageDto>
storeOutboundMessage(businessId, dto: StoreOutboundMessageDto): Promise<MessageDto>
updateDeliveryStatus(businessId, messageId, dto): Promise<void>
getMessage(businessId, messageId): Promise<MessageDto>
getConversationMessages(businessId, conversationId, query): Promise<PaginatedResult<MessageDto>>
getLastNMessages(businessId, conversationId, n): Promise<MessageDto[]>
searchMessages(businessId, query: SearchMessagesDto): Promise<PaginatedResult<MessageDto>>
attachAIMetadata(businessId, messageId, dto: AIMetadataDto): Promise<void>
getMessageStats(businessId, conversationId): Promise<MessageStatsDto>
```

## Events

**Emits:**
- `message.stored` — `{ businessId, messageId, conversationId, direction }`

**Listens to:**
- `message.received` (from `channel-adapter`) — calls `storeInboundMessage()`
- `message.sent` (from `channel-adapter`) — calls `storeOutboundMessage()` if not already stored
- `message.failed` — calls `updateDeliveryStatus()` with FAILED status

## Tables Owned

- `messages` — all message content (polymorphic JSONB `content` column), delivery tracking, AI attribution, campaign attribution, full-text search via `text_content` column
- `file_uploads` — S3-backed media references attached to messages

## Dependencies

- `@gosumo/shared` — `NormalizedMessage`, `MessageDirection`, `DeliveryStatus`
- `@gosumo/conversation` — validates `conversationId` exists before storing

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/message
```

## Key Gotchas

- **Messages are append-only** — never update message content after storage; update only delivery status fields
- **`external_id` deduplication:** `external_id` (channel-assigned message ID) has a unique index; duplicate inbound messages from channel retries are silently discarded via DB constraint
- **Full-text search** only indexes `TEXT`-type messages via the `text_content` column (denormalized). Image/document/location messages are excluded from search results
- **Media URLs must be GoSumo S3 URLs**, never external channel CDN URLs — `channel-adapter` is responsible for re-uploading before this module stores them
- **`storage_key` is a caller-supplied pointer, validated at write time** by `common/utils/storage-key.util.ts`: no scheme, leading slash, `..` segment, backslash, or control character, and ≤1024 bytes. Nothing dereferences it yet; the moment a presigned-URL signer or a retention sweep does, a poisoned row is indistinguishable from a real one. `filename` must be a single name, never a path.
- **Two paths write `file_uploads`** — `attachMedia` (via `AttachMediaDto`) and `persistMediaFromContent` (off an inbound channel payload, no DTO). The second repeats the first's checks by hand; keep them in step. Their failure handling differs on purpose: the DTO path rejects with a 400, while the inbound path drops or clamps the attachment and warns, because the message is already stored and append-only.
- **`mimeType` must match the declared `type`** (IMAGE/STICKER→`image/*`, VIDEO→`video/*`, AUDIO→`audio/*`; DOCUMENT is unconstrained). These rows carry `is_public`, so an IMAGE declaring `text/html` is a stored-XSS setup for whatever eventually serves the object.
- **Bounds that are the database's, not policy:** `mime_type` is VARCHAR(100) and `size_bytes`/`width`/`height` are int4. Without the DTO caps the failure is a Prisma 500 rather than a 400 naming the field.
- **Outbound AI messages** must have `is_ai_generated: true` and `confidence_score` populated — `ai-engine` calls `attachAIMetadata()` after storing
- `messages` table is partitioned by `created_at` month in production — migration `0010_partition_messages.sql` handles this; do not add raw SQL queries that assume a non-partitioned layout
- `getLastNMessages` returns messages newest-first; callers that want chronological order must reverse the array
