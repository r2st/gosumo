# Module: realty-leads (GoSumo Realty)

The AI Lead Manager's system of record — the central `realty_leads` entity. Captures property-buyer leads from every source, runs conversational BLTC qualification, scores + stages them, and keeps permanent memory. Layer-0 of the Realty product (full value at n=1).

## Public API (RealtyLeadsService)

```typescript
createLead / getLead / updateLead / deleteLead
listLeads(businessId, query): Promise<PaginatedLeads>
getBoard(businessId): Promise<{ stage, count }[]>          // pipeline board
applyBltcUpdate(businessId, leadId, dto): Promise<BltcUpdateResult>  // merge + rescore + auto-qualify
transitionStage / captureMemory / assignAgent / setOptOut
setMatchedUnits(businessId, leadId, unitIds)               // called by realty-inventory matcher
```

## BLTC qualification (blueprint §16.2)

- Slots: **B**udget · **L**ocation · **T**imeline · **C**onfig (+ purpose, financing).
- A filled slot is **never silently overwritten** — a mismatch is returned in `contradictions[]` unless `force: true`.
- Score weights: budget-fit 35 · timeline 25 · engagement 20 · financing 10 · purpose 10 (`lead-scoring.util.ts`, pure + fully unit-tested).
- Temperature bands: HOT ≥75 · WARM ≥50 · COLD ≥25 · JUNK <25.
- 4/4 core BLTC + reachable contact ⇒ auto-transition to `QUALIFIED`.

## Events

**Emits:** `realty.lead.created`, `realty.lead.qualified`, `realty.lead.stage_changed`, `realty.lead.hot` (hot-dossier alert), `realty.lead.opted_out`.
**Listens:** `message.received` — auto-captures a lead for an unseen E.164 phone (one buyer, one history); touches an existing lead otherwise.

## Tables owned

- `realty_leads` — identity, attribution (recorded at birth, never mutated), BLTC profile, state, memory (facts/objections/promises), compliance/consent, cadence state.

## Key gotchas

- **Money at the boundary:** budget stored as `Decimal(14,2)` rupees; exposed/accepted as integer paise (`budgetMinPaise`/`budgetMaxPaise`).
- **Phone is the join key:** E.164 `whatsapp_phone` is unique per business; `createLead` rejects duplicates.
- **Opt-out is absolute:** `setOptOut` clears `next_followup_at` and emits so cadence engines halt.
- **Soft delete only** (`deleted_at`).

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-leads
```
