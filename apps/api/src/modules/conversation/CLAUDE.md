# Module: conversation

Manages the lifecycle of conversation threads between a business and its customers. Acts as the central coordination point: it tracks conversation state via a state machine, provides the context window that `ai-engine` reads before responding, and ensures no conversation is lost between AI and human handling.

## Purpose

Owns conversation status (OPEN, PENDING_HUMAN, ESCALATED, RESOLVED, SNOOZED), enforces valid state transitions, tracks SLA metrics (first response time, resolution time), and provides context to the AI pipeline.

## Public API (IConversationService)

```typescript
findOrCreateConversation(businessId, dto: FindOrCreateConversationDto): Promise<ConversationDto>
getConversation(businessId, conversationId): Promise<ConversationDto>
listConversations(businessId, query): Promise<PaginatedResult<ConversationDto>>
updateConversationStatus(businessId, conversationId, dto): Promise<ConversationDto>
assignConversation(businessId, conversationId, dto): Promise<ConversationDto>
snoozeConversation(businessId, conversationId, snoozeUntil): Promise<ConversationDto>
getConversationContext(businessId, conversationId): Promise<ConversationContextDto>
addTag / removeTag / updateConversationNote
getConversationStats(businessId, query): Promise<ConversationStatsDto>
```

## Events

**Emits:**
- `conversation.created` — `{ businessId, conversationId, clientId, channelType }`
- `conversation.resolved` — `{ businessId, conversationId, resolvedBy, resolutionTimeMs }`
- `conversation.escalated` — `{ businessId, conversationId, escalationReason }`
- `conversation.status.changed` — `{ businessId, conversationId, from, to, changedBy }`

**Listens to:**
- `message.received` — find or create conversation, update `last_message_at`
- `ai.escalated` — the AI's own escalation moves the conversation to ESCALATED. Without this the status was only ever set by the manual REST endpoint, so an AI escalation never reached the inbox's "Escalated" filter and the `task.resolved` return path below could not fire
- `task.created` — a `REVIEW_RESPONSE` / `CLARIFY_INTENT` task moves the conversation to PENDING_HUMAN (escalation task types are left to `ai.escalated`, which sets the stronger status)
- `task.resolved` — ESCALATED **or** PENDING_HUMAN → OPEN, but only once no other task on that conversation is still open. Emitted on every HITL resolution path (resolve / approve / reject / edit-and-send), so a rejected draft has a way back
- `ai.response.approved` — transition from PENDING_HUMAN → OPEN
- `team.member.removed` — release every live conversation that member held back to the unassigned queue (RESOLVED ones keep their assignee as a record of who handled it)

**Why the status matters beyond the inbox:** `AiEngineService` refuses to send
anything to the customer while a conversation is ESCALATED or PENDING_HUMAN,
downgrading an auto-executable reply to a review task. These two statuses are
what stop the AI answering over the person holding the thread.

## Tables Owned

- `conversations` — all conversation state, assignment, CSAT, tags, message counters
- `conversation_events` — immutable audit of every status transition (not in Prisma schema; stored in `metadata` JSONB or as analytics events)

## Dependencies

- `@gosumo/shared` — `ConversationStatus` enum, domain event types
- `@gosumo/channel-adapter` — `getChannelCapabilities()` for sending context

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/conversation
```

## Key Gotchas

- **One active conversation per (businessId, clientId, channelType)** — a resolved conversation is auto-reopened when a new message arrives from the same client; never create a duplicate
- **Context window for AI:** last 20 messages + last 5 status events + client profile summary (compact, ≤300 chars) — defined in `conversation.constants.ts` as `CONTEXT_WINDOW_SIZE = 20`
- **Cannot manually resolve** a conversation while an open HITL task exists for it — check tasks before allowing resolution
- **Snooze max:** 7 days. Snoozed conversations are woken by a BullMQ delayed job that fires at `snoozed_until` and re-opens them
- `getConversationContext` is called on every AI pipeline invocation — it must be fast; cache the active conversation ID in Redis for sub-millisecond lookup
- The `assigned_to` column references `team_members.id` (not `users`) — validate the assignee belongs to the same `businessId`
