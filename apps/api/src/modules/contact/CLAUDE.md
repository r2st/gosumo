# Module: contact

Contact management and segmentation on top of the existing `clients` table. Lets a business tag contacts and save dynamic segments (filter definitions) for targeting and dashboard grouping.

## Purpose

Add tagging and saved dynamic segments to the client records other modules already own and create. Never creates or deletes a client itself — channel-adapter and client-intelligence do that on first contact.

## Public API (IContactService)

```typescript
listContacts(businessId, query): Promise<PaginatedContactsDto>
getContact(businessId, id): Promise<ContactResponseDto>
updateContact(businessId, id, dto): Promise<ContactResponseDto>
addTags / removeTags(businessId, id, tags): Promise<ContactResponseDto>

createSegment / updateSegment / deleteSegment
listSegments(businessId): Promise<SegmentResponseDto[]>
getSegment(businessId, id): Promise<SegmentResponseDto>
getSegmentMembers(businessId, id, page, limit): Promise<PaginatedContactsDto>
```

## Events

**Emits:**
- `contact.tagged` — `{ businessId, contactId, tags }` (full tag list after the change)

**Listens to:** none

## Tables Owned

- `segments` — saved dynamic filters over `clients`
- `clients.tags` column (the `clients` table itself is owned by client-intelligence/channel-adapter)

## Dependencies

- `@gosumo/shared` — `ChannelType`, domain event types
- Direct read/write on `clients` (tags + basic contact fields only — never touches AI-managed `profile`/scores)

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/contact
```

## Key Gotchas

- **Segments are dynamic, not materialized** — `getSegmentMembers` evaluates the stored `filter` JSON against `clients` live, on every call; there is no membership table to keep in sync
- **Segment names are unique per business** — 409 on create/rename collision
- **Tags are normalized**: trimmed, lower-cased, capped at 50 chars, deduplicated — `addTags`/`removeTags` always operate on the normalized form
- **`updateContact` only touches `name`/`email`/`phone`** — AI-managed fields (`profile`, `ltv_score`, `churn_risk`, etc.) are never writable through this module
- Segment `filter.tags` uses OR semantics (`hasSome`) — a contact matches if it has *any* of the listed tags, not all
