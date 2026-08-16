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
resolveRouting(businessId, clientId): Promise<ResolvedRoutingDto>
```

`SegmentRoutingService` is exported separately (and injected by `ai-engine`):

```typescript
resolve(businessId, clientId, now?): Promise<SegmentRoutingDecision>
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
- **Every filter criterion is implemented twice** — as SQL in `segmentFilterToWhere` (for member lists and counts) and as a pure function in `segment-routing.util.ts` (for the single-contact question the AI pipeline asks on every inbound message). Answering "which segments is *this* contact in?" as SQL would be one query per segment per message on the hottest path in the product. The duplication is the price of that, and the two must agree: a contact the SQL puts in a `HUMAN_ONLY` segment but the evaluator does not is a contact the AI answers anyway while the segment page still shows them as protected. `segment-routing.spec.ts` pins the criteria sets against each other
- **A criterion that cannot be expressed identically in both places is not offered.** `minConversations` was cut for exactly this reason — Prisma can compare a relation's cardinality to zero and to nothing else, so the SQL side would have had to approximate what the evaluator applied exactly. It exists as `hasConversations: boolean` instead
- **`routing_mode: INHERIT` is the default and means "no opinion"** — the tenant's own confidence bands decide, exactly as before segments carried routing. Every segment that predates this reads as INHERIT
- **`HUMAN_ONLY` is fed to the confidence calculator's `forceEscalate` input**, not applied after scoring. `ai_decisions` is the audit trail, and an unexplained zero on a turn with full RAG context is indistinguishable from a scoring bug
- **Per-segment thresholds merge per-field over the tenant's**, so a segment that sets only `autoExecuteThreshold` keeps the tenant's `draftReview`. `validateRouting` checks the *merged* pair for inversion, which is why a partial update is checked against the stored row and not against a default
- **Routing resolution fails in two different directions on purpose** — a failed segment-list read resolves to INHERIT (that read returns empty for almost every tenant, so failing closed would escalate the whole platform to protect a control nobody configured); a failed *membership* read while routing segments are known to exist resolves to `HUMAN_ONLY`. See `SegmentRoutingService`'s class docstring
