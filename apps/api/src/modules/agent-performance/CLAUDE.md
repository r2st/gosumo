# Module: agent-performance

Per-agent (team member) productivity metrics: response/resolution times, CSAT, tasks resolved, and SLA compliance. Read-only, in the same spirit as `analytics` — no owned tables, no writes.

## Purpose

Give a manager a leaderboard and per-agent drill-down: how fast an agent responds and resolves, their CSAT average, HITL tasks resolved, and their SLA compliance rate for a date range.

## Public API (IAgentPerformanceService)

```typescript
getAgentPerformance(businessId, memberId, from?, to?): Promise<AgentPerformanceDto>
listAgentPerformance(businessId, from?, to?): Promise<AgentLeaderboardDto>
```

## Events

**Emits:** none (read-only)

**Listens to:** none

## Tables Owned

None. Direct read-only SQL queries on: `team_members`, `conversations`, `messages`, `tasks`.

## Dependencies

- `sla` module — `SlaService.getBreachCountsByAssignee()` (injected for a synchronous read; this module never queries `sla_breaches` directly)

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/agent-performance
```

## Key Gotchas

- **Date range defaults to trailing 30 days, capped at 365 days** (422 `DATE_RANGE_TOO_LARGE` beyond that) — same convention as `analytics`
- **First-response time is human-agent-specific**: only `messages` rows with `sender_type = 'HUMAN_AGENT'` and `sender_id = <memberId>` count — AI-sent messages never count toward an agent's response time
- **A member with zero activity in range still returns a full DTO with zeros**, not a 404 — 404 only fires when the member itself doesn't exist or is soft-deleted/inactive
- **`slaComplianceRate` defaults to 100%** when the agent has no SLA targets due in the range (never divides by zero, and "no targets" should not read as "failing")
- **`assignedConversations` is a live snapshot** (currently assigned, not range-scoped) — everything else (`resolvedConversations`, CSAT, tasks, SLA) is scoped to the requested date range
