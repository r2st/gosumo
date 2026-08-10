# Module: realty-cadence (GoSumo Realty — Phase 5)

The declarative follow-up engine: a WhatsApp **template registry**, trigger-based
**cadences**, a scheduled **engine**, and a **compliance gate**. Turns a quiet lead
into a booked visit without a human touching the keyboard (blueprint §17).

## Public API

**RealtyCadenceService** (management surface)
```typescript
seedDefaults(businessId)                         // install templates (en+hi) + 3 cadences (idempotent)
createTemplate / listTemplates / getTemplate / updateTemplate / setTemplateApproval / deleteTemplate
createCadence / listCadences / getCadence / updateCadence / deleteCadence
listEnrollments(businessId, { leadId?, status? })
```
**CadenceEngineService** (runtime)
```typescript
enroll(businessId, leadId, trigger)              // no-op if no active cadence / already enrolled
stopForLead(businessId, leadId, signal, reason)  // OPTOUT stops all; REPLY/STAGE_CHANGE per current step
processDueEnrollments(now?, businessId?)         // the scheduler tick — runs due steps
```

## How enrolment happens (event-driven)

| Event | Action |
|---|---|
| `realty.lead.created` | enrol **NO_RESPONSE** (D1/D3/D7 chase) |
| `realty.visit.completed` | enrol **POST_VISIT** nurture |
| `realty.lead.stage_changed` → DORMANT | enrol **DORMANT** reactivation |
| `realty.lead.stage_changed` (other) | stop steps flagged `STAGE_CHANGE` |
| `realty.lead.opted_out` | **stop everything** (opt-out is absolute) |
| `message.received` (inbound reply) | stop steps flagged `REPLY` |

## Execution (`processDueEnrollments`)

For each ACTIVE enrolment with `next_run_at ≤ now`: load lead → if opted-out, **stop**;
if the step's `condition` is unmet, **skip** (advance, no send); else run the
**compliance gate** → send (emit `realty.cadence.step_sent`) or skip. Steps are
scheduled absolutely from `started_at + day_offset`, so D1/D3/D7 stays honest.

## Compliance gate (`compliance.util.ts`, pure + fully unit-tested)

Priority: opted-out → **blocked** (absolute) · no/unapproved template → **blocked** ·
inside the 24h service window → any category allowed · outside the window →
UTILITY allowed, **MARKETING blocked**. Returns a typed `ComplianceDecision`.

## Events

**Emits:** `realty.cadence.started`, `realty.cadence.step_sent`, `realty.cadence.completed`.
The actual WhatsApp dispatch is a downstream listener on `step_sent` — this module
decides *whether/what* to send, not *how*.

## Tables owned

`realty_message_templates` · `realty_cadences` · `realty_cadence_steps` ·
`realty_cadence_enrollments` (per-lead run state: `current_step`, `next_run_at`, `status`).

## Key gotchas

- **Depends on `realty-leads`** for lead state (opt-out, stage, temperature, last activity).
- **Seeded templates ship APPROVED** so defaults work on day one; user-edited bodies re-open approval.
- The engine emits sends — it does **not** call WhatsApp directly (keeps it testable + decoupled).
- **Soft delete** on templates/cadences/steps; enrollments are terminal (COMPLETED/STOPPED), not deleted.

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-cadence
```
