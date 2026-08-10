# Module: canned-response

Reusable, pre-written replies agents can insert into a conversation via a slash-command style shortcut (e.g. `/refund-policy`).

## Purpose

Let a business build a library of canned replies — categorized, taggable, optionally channel-specific — and track how often each is used.

## Public API (ICannedResponseService)

```typescript
create(businessId, dto, createdBy?): Promise<CannedResponseDto>
list(businessId, query): Promise<PaginatedCannedResponsesDto>
get(businessId, id): Promise<CannedResponseDto>
getByShortcut(businessId, shortcut): Promise<CannedResponseDto>
update(businessId, id, dto): Promise<CannedResponseDto>
delete(businessId, id): Promise<void>
recordUsage(businessId, id, conversationId?, usedBy?): Promise<CannedResponseDto>
```

## Events

**Emits:**
- `canned_response.used` — `{ businessId, cannedResponseId, conversationId?, usedBy? }`

**Listens to:** none

## Tables Owned

- `canned_responses`

## Dependencies

- `@gosumo/shared` — `ChannelType`, domain event types

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/canned-response
```

## Key Gotchas

- **`shortcut` is unique per business and always lower-cased** before lookup/create — `/Refund-Policy` and `/refund-policy` are the same response
- **`channel: null` means "usable on every channel"** — list filtering by channel returns both channel-specific and channel-null responses
- **`usage_count` only increments via `recordUsage`** — the dashboard client is expected to call this whenever an agent actually inserts a response, not on every fetch
- **Soft delete only** — `deleted_at`; a deleted shortcut can be reused by a new canned response
