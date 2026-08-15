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
- **`external_id` deduplication:** unique on `(business_id, channel_account_id, external_id)` as of migration 0040. Until then this line described an index that did not exist — the schema had a plain non-unique `@@index([external_id])` — so nothing but `webhook_events(source, external_id)` stood between a redelivery and a second row, and the two paths that bypass that wall (a `webhook-dlq` replay, which skips it on purpose, and the web-chat socket, which never had one) wrote duplicates. A collision is not an error: `createSequencedMessage` returns the stored row with `duplicate: true`, and the caller **must not re-emit `message.received`** — that event drives the AI pipeline, so a re-announcement is a second LLM call and a second reply to a customer who sent one message
- **Every message row is written through `createSequencedMessage`** (`common/utils/message-sequence.ts`), never `prisma.messages.create` directly. It claims `conversations.message_seq` with a database-side increment and inserts inside the same transaction, so `messages.sequence` is the arrival order rather than an approximation of it. `sequence` has no Prisma default precisely so a new write path is a compile error rather than a row at position 0. Distinct from `ConversationLockService`, which serializes *processing* in one process; this serializes *storage* across all of them
- **Two read orderings, chosen by scope.** `MESSAGE_ORDER_IN_CONVERSATION_*` leads with `sequence` and requires a `conversation_id` filter; `MESSAGE_ORDER_*` does not and is for tenant-wide reads. Leading with `sequence` on a cross-conversation query sorts by position-in-thread while claiming recency — every conversation has a message 1. `findByConversation` is conversation-scoped but still uses the tenant-wide pair, because its keyset cursor is `(created_at, id)` and a cursor must agree with its sort key
- **Full-text search** only indexes `TEXT`-type messages via the `text_content` column (denormalized). Image/document/location messages are excluded from search results
- **Media URLs must be GoSumo S3 URLs**, never external channel CDN URLs — `channel-adapter` is responsible for re-uploading before this module stores them
- **`storage_key` is a caller-supplied pointer, validated at write time** by `common/utils/storage-key.util.ts`: no scheme, leading slash, `..` segment, backslash, or control character, and ≤1024 bytes. Nothing dereferences it yet; the moment a presigned-URL signer or a retention sweep does, a poisoned row is indistinguishable from a real one. `filename` must be a single name, never a path.
- **Two paths write `file_uploads`** — `attachMedia` (via `AttachMediaDto`) and `persistMediaFromContent` (off an inbound channel payload, no DTO). The second repeats the first's checks by hand; keep them in step. Their failure handling differs on purpose: the DTO path rejects with a 400, while the inbound path drops or clamps the attachment and warns, because the message is already stored and append-only.
- **`mimeType` must match the declared `type`** (IMAGE/STICKER→`image/*`, VIDEO→`video/*`, AUDIO→`audio/*`; DOCUMENT is unconstrained). These rows carry `is_public`, so an IMAGE declaring `text/html` is a stored-XSS setup for whatever eventually serves the object.
- **Bounds that are the database's, not policy:** `mime_type` is VARCHAR(100) and `size_bytes`/`width`/`height` are int4. Without the DTO caps the failure is a Prisma 500 rather than a 400 naming the field.
- **`file_uploads` rows are swept by DPDPA retention, not just `messages`.** `RetentionService` clears a message's `text_content`, but an IMAGE or DOCUMENT message keeps its personal data in the row beside it — `filename` is whatever the sender's device called the file ("Aadhaar-Ramesh.pdf") and `cdn_url` is a live link to it. `ComplianceRepository.anonymizeOldFileUploads` scrubs both plus `thumbnail_key` past the window. `storage_key` is deliberately **kept**: it is the only handle to the stored object, so clearing it would strand the object instead of erasing it — it is the column an object-purge will read. A new PII-bearing column on this table must be added to that update
- **Outbound AI messages** must have `is_ai_generated: true` and `confidence_score` populated — `ai-engine` calls `attachAIMetadata()` after storing
- `messages` is **not** partitioned. This line used to claim monthly `created_at` partitioning via a `0010_partition_messages.sql` that does not exist in `packages/database/prisma/migrations`, and production confirms it: `pg_class.relkind` for `messages` is `r`, an ordinary table. The distinction is load-bearing rather than trivia — Postgres requires every unique constraint on a partitioned table to include the partition key, so the `(conversation_id, sequence)` and `(business_id, channel_account_id, external_id)` indexes added in 0040 would have been illegal. Partitioning this table later means revisiting both
- `getLastNMessages` returns messages newest-first; callers that want chronological order must reverse the array
