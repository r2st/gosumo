# Module: sla

Configurable SLA targets (first-response and resolution) matched against conversations, with breach detection and escalation actions.

## Purpose

Let a business define SLA policies (priority-ordered match conditions + minute targets + escalation actions), automatically assign the best-matching policy to every new conversation, track two clocks per conversation (first response, resolution), and escalate on breach.

## Public API (ISlaService)

```typescript
createPolicy / updatePolicy / deletePolicy
listPolicies(businessId): Promise<SlaPolicyDto[]>
getPolicy(businessId, id): Promise<SlaPolicyDto>

listBreaches(businessId, query): Promise<PaginatedBreachesDto>
getBreachesForConversation(businessId, conversationId): Promise<SlaBreachDto[]>
getComplianceSummary(businessId, from?, to?): Promise<SlaComplianceDto>
getBreachCountsByAssignee(businessId, from, to)   // for agent-performance, injected

sweepOverdueBreaches(businessId): Promise<{ swept: number }>
sweepAllBusinesses(now?): Promise<SlaSweepSummary>   // the scheduled path
```

## Events

**Emits:**
- `sla.breached` — `{ businessId, conversationId, policyId, breachType, targetMinutes, actualMinutes }`
- `sla.escalated` — `{ businessId, conversationId, policyId, breachType, action, target? }` (one per configured escalation action)

**Listens to:**
- `conversation.created` → match a policy (channel/tags), create FIRST_RESPONSE + RESOLUTION trackers in `sla_breaches`
- `message.sent` → check the FIRST_RESPONSE tracker
- `conversation.resolved` → check the RESOLUTION tracker

## Queue

`sla` — one repeatable job, `sla-breach-sweep`, registered in `onModuleInit`
under a stable jobId (`SLA_SWEEP_REPEAT_JOB_ID`). Same contract as the other
scheduled modules; covered by `repeatable-schedules.spec.ts`.

## Tables Owned

- `sla_policies`
- `sla_breaches`

## Dependencies

- `@gosumo/shared` — `ChannelType`, domain event types
- Read-only lookup on `conversations` (channel/tags/created_at for policy matching and per-assignee breach stats) — never written to

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/sla
```

## Key Gotchas

- **A conversation only gets SLA trackers if an active policy matches at `conversation.created` time.** Tag-conditioned policies are matched using whatever tags the conversation already has at that instant — in practice usually none, since tags are typically added afterward. Channel is the reliable signal for initial matching.
- **First matching policy wins, ordered by `priority` descending.** An empty `conditions` object matches everything — put your catch-all policy at the lowest priority.
- **Breach detection is event-driven *and* timer-driven.** A tracker is checked when its triggering event fires (`message.sent` / `conversation.resolved`). A conversation nobody ever responds to has no such event, so for it the **sweep is the detection path, not a backstop** — `SlaProcessor` runs `sweepAllBusinesses` every five minutes off the `sla` queue (`SLA_SWEEP_CRON`). The interval is the resolution of the breach clock: a 15-minute SLA swept hourly would report breaches up to an hour late.
- **The sweep is bounded at both levels and says when it truncated.** It visits at most `SLA_SWEEP_MAX_BUSINESSES` (200) tenants per tick — only those that actually have an overdue tracker — and each tenant's own sweep takes at most `SWEEP_BATCH_SIZE` (200) trackers. A backlog past either cap drains across ticks, and the processor logs that at `warn` rather than reporting a clean run. One tenant throwing never stops the others.
- **Escalation fires once per breach.** `escalated`/`escalated_at` gate it — a tracker already marked breached by the sweep won't re-escalate when the real event later marks it `met_at` (late).
- **Escalation is emit-only.** `sla.escalated` carries the action (`NOTIFY`/`REASSIGN`/`CREATE_TASK`) and target, but this module does not itself notify, reassign, or create a HITL task — a listener in notification/conversation/hitl would need to be added to act on it.
- **`resolutionTargetMinutes` must be `>= firstResponseTargetMinutes`** — enforced at policy create/update time (400 otherwise).
