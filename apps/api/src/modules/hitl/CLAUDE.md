# Module: hitl (Human-in-the-Loop)

The interface between AI decisions and human operators. When AI confidence is too low or policy requires approval, creates a task that appears in the operator dashboard in real-time via Socket.IO. Operators review AI drafts, approve/reject/edit, send manual responses, and escalate further. The safety valve of the entire system.

## Purpose

Create and manage HITL tasks, push real-time notifications to dashboard operators, handle draft approval workflows, maintain internal conversation notes, track SLA timers, and escalate stale tasks automatically.

## Public API (IHITLService)

```typescript
createTask(businessId, dto: CreateTaskDto): Promise<TaskDto>
getTask / listTasks
assignTask(businessId, taskId, userId): Promise<TaskDto>
resolveTask(businessId, taskId, dto): Promise<TaskDto>
approveDraft(businessId, taskId, dto): Promise<void>
rejectDraft(businessId, taskId, dto): Promise<void>
editAndSendDraft(businessId, taskId, dto): Promise<void>
sendManualResponse(businessId, dto): Promise<void>
postInternalNote(businessId, dto): Promise<InternalNoteDto>
getInternalNotes(businessId, conversationId): Promise<InternalNoteDto[]>
escalateConversation(businessId, conversationId, dto): Promise<TaskDto>
getTaskQueueStats(businessId): Promise<TaskQueueStatsDto>
```

## Events

**Emits:**
- `task.created` — `{ businessId, taskId, conversationId, taskType, priority }`
- `task.assigned` — `{ businessId, taskId, assignedTo }`
- `task.resolved` — `{ businessId, taskId, resolution, resolvedBy }`
- `ai.response.approved` — `{ businessId, taskId, decisionId, editedResponse? }`
- `ai.response.rejected` — `{ businessId, taskId, decisionId, feedback }`

**Listens to:**
- `ai.response.generated` with `band: DRAFT_REVIEW` → `createTask()` with the AI draft
- `ai.escalated` → `createTask()` with escalation type
- `conversation.escalated` → `createTask()` with ESCALATION type
- `task.created` → push real-time update via Socket.IO to all online operators for that business

## Tables Owned

- `tasks` — task records with SLA tracking, AI draft, assignment, resolution, escalation chain
- (`internal_notes` stored in `tasks.metadata` JSONB or as a separate table — implement as `internal_notes` table)

## Dependencies

- `@gosumo/shared` — `TaskStatus`, `TaskType`
- `@gosumo/conversation` — `updateConversationStatus()` when task resolved
- `@gosumo/message` — `storeOutboundMessage()` when draft approved and sent
- `@gosumo/channel-adapter` — `sendMessage()` for approved/manual responses
- `@gosumo/ai-engine` — `regenerateDraft()` when draft rejected with feedback
- Socket.IO — real-time task push via `HitlGateway`

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/hitl
```

## Key Gotchas

- **One open task per conversation** — check for existing open tasks before creating a new one; return `CONVERSATION_HAS_OPEN_TASK` (409) if one exists
- **SLA timers:** DRAFT_REVIEW tasks must be resolved within 15 min; ESCALATION within 4h. BullMQ delayed job sets `sla_breached = true` and bumps priority to URGENT on breach
- **Draft approval without edits:** send the exact AI-generated text; `is_ai_generated = true` on the stored message
- **Draft rejection:** call `ai-engine.regenerateDraft(decisionId, feedback)` to get a new draft; update the existing task with the new draft (do not create a new task)
- **Internal notes are never sent to the customer** — they are staff-only, visible only in the dashboard
- **Socket.IO gateway** pushes to room `business:{businessId}` — operators join this room on dashboard login; disconnecting leaves the room automatically
- **Task priority auto-escalation on SLA breach:** bump to URGENT and emit Socket.IO event to all online operators for that business
- Resolving a task triggers `task.resolved` event, which `conversation` listens to and may auto-resolve the conversation depending on task type
