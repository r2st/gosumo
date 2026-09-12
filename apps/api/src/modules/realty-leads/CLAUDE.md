# Module: realty-leads (GoSumo Realty)

The AI Lead Manager's system of record — the central `realty_leads` entity. Captures property-buyer leads from every source, runs conversational BLTC qualification, scores + stages them, and keeps permanent memory. Layer-0 of the Realty product (full value at n=1).

## Public API (RealtyLeadsService)

```typescript
createLead / getLead / updateLead / deleteLead
listLeads(businessId, query): Promise<PaginatedLeads>
listLeadsForAggregation(businessId, since, cap, pageSize)  // keyset walk, narrow projection — realty-intelligence only
getBoard(businessId): Promise<{ stage, count }[]>          // pipeline board
applyBltcUpdate(businessId, leadId, dto): Promise<BltcUpdateResult>  // merge + rescore + auto-qualify
transitionStage / advanceStage / captureMemory / assignAgent / setOptOut
setMatchedUnits(businessId, leadId, unitIds)               // called by realty-inventory matcher
```

## BLTC qualification (blueprint §16.2)

- Slots: **B**udget · **L**ocation · **T**imeline · **C**onfig (+ purpose, financing).
- A filled slot is **never silently overwritten** — a mismatch is returned in `contradictions[]` unless `force: true`.
- Score weights: budget-fit 35 · timeline 25 · engagement 20 · financing 10 · purpose 10 (`lead-scoring.util.ts`, pure + fully unit-tested).
- Temperature bands: HOT ≥75 · WARM ≥50 · COLD ≥25 · JUNK <25.
- 4/4 core BLTC + reachable contact ⇒ auto-transition to `QUALIFIED`.

## Stage machine

Pipeline: `NEW → CONTACTED → QUALIFIED → VISIT_BOOKED → VISITED → NEGOTIATING`; terminal: `CLOSED_WON` / `CLOSED_LOST`; parked: `DORMANT`.

- **`transitionStage` is the operator's** — free-form (a broker closes offline, reopens a mis-click); `dto.note` is recorded.
- **`advanceStage` is the system's** (site visit booked/completed, EOI paid, BLTC auto-qualify via `canAdvanceStage`) — forward-only, never out of a terminal stage, always out of `DORMANT`. A second visit must not drag NEGOTIATING back to VISIT_BOOKED, and a Razorpay replay must not reopen CLOSED_WON. Never call `transitionStage` from a webhook or job.
- Both go through one compare-and-set write (`repository.transitionStage`: `updateMany … WHERE stage = <observed>`), so `stage_changed.fromStage` is always the true predecessor; a lost race is a 409 for the operator and one re-read-and-re-evaluate for the system.
- Every change appends `{from, to, at, actor, note?}` to `metadata.stageHistory` (capped at 50).
- Moving to a terminal stage stops every cadence enrolment unconditionally (`cadence-engine` listens).

## Events

**Emits:** `realty.lead.created`, `realty.lead.qualified`, `realty.lead.stage_changed`, `realty.lead.hot` (hot-dossier alert), `realty.lead.opted_out`.
**Listens:** `message.received` — auto-captures a lead for an unseen E.164 phone (one buyer, one history); touches an existing lead otherwise.

## Tables owned

- `realty_leads` — identity, attribution (recorded at birth, never mutated), BLTC profile, state, memory (facts/objections/promises), compliance/consent, cadence state.

## Key gotchas

- **Money at the boundary:** budget stored as `Decimal(14,2)` rupees; exposed/accepted as integer paise (`budgetMinPaise`/`budgetMaxPaise`).
- **Phone is the join key:** E.164 `whatsapp_phone` is unique per business; `createLead` rejects duplicates. Identity resolution goes through `findByPhoneIncludingDeleted`, **not** `findByPhone` — `uq_realty_leads_business_phone` has no `WHERE deleted_at IS NULL` predicate, so a soft-deleted lead still owns its number and a tombstone-blind lookup reports a phone free that the next insert cannot use. A tombstone found this way is revived; a lost insert race is recovered by re-claiming on P2002. `findLeadByPhone` (cadence, voice, compliance) deliberately still excludes deleted rows.
- **Auto-capture keys on `event.senderPhone`, never `senderExternalId`.** The latter is the channel's routing address — a WhatsApp `wa_id` has no `+`, and a Web Chat sender id is a UUID. Both produce a lead that no E.164 lookup will ever match.
- **Opt-out is absolute:** `setOptOut` clears `next_followup_at` and emits so cadence engines halt.
- **Soft delete only** (`deleted_at`).

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-leads
```
