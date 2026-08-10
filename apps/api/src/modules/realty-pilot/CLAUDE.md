# Module: realty-pilot (GoSumo Realty — Phase 8)

Pilot-firm onboarding + launch readiness (blueprint §22 "8-week build" / §24 KPIs).
Three concerns behind one console: **data migration**, the **evidence-driven
autonomy dial**, and the **launch-readiness gate** (with its **no-ship ledger**).

## Public surface (`realty/pilot`)

```
POST migrate/leads        importLeads(dto{rows, dryRun?, kind?})     — E.164 identity-merge (reuses realty-ingestion)
POST migrate/inventory    importInventory(dto{rows, dryRun?})        — projects + units (reuses realty-inventory)
GET  migrations           listRuns / GET migrations/:id              — the import audit history

GET  autonomy             evaluate (preview, no change)
POST autonomy/advance     advance({apply}) — OPEN/CLOSE writes broker settings + ledger; HOLD is a no-op
GET  autonomy/events      the append-only autonomy-change ledger

POST no-ship              recordIncident (QA / soak-drill / manual)
GET  no-ship              list incidents

GET  launch-gate          evaluate with auto metrics (response-P95 → INSUFFICIENT_DATA)
POST launch-gate/evaluate evaluate with a measured responseP95Seconds + windowDays
```

## Services

- **MigrationService** — validates then (unless `dryRun`) commits. Leads/contacts go through `RealtyIngestionService.importCsv` (one buyer, one history). Inventory rows are grouped into projects-with-units by `inventory-import.util.ts` and committed via `RealtyInventoryService`. Every run is persisted to `realty_migration_runs`.
- **AutonomyService** — gathers evidence (resolved-draft accuracy, days live, hot-alert action rate, no-ship count), runs the pure `autonomy-ladder.util.ts`, and on `advance` moves the broker dial (`RealtyBrokerService.updateSettings`) + appends an immutable `realty_autonomy_events` row. The dial only opens one rung at a time; **any no-ship incident forces a CLOSE to the supervised floor**.
- **NoShipService** — owns the append-only `realty_no_ship_incidents` ledger. Explicit `recordIncident`, plus an `@OnEvent('realty.ai.turn_completed')` regression watch that records an incident if a BLOCK-severity guardrail violation ever co-occurred with an `AUTO` send (guardrails normally force ESCALATE, so this stays empty).
- **LaunchGateService** — assembles the §24 KPIs from leads/visits/broker + no-ship counts and runs the pure `launch-gate.util.ts` → GO / NO_GO / NOT_READY.

## The §24 gate

KPIs: response P95 <60s · engagement ≥40% · qualification ≥60% · **site visits/100 leads ≥8** · show-up ≥60% · AI autonomy ≥70% · hot-alert action <30 min ≥70%.
No-ship (each must be 0): unverified price · availability for SOLD/HOLD/UNVERIFIED · send to an opted-out number · RERA claim beyond sheet · cross-buyer disclosure.
Verdict: any FAIL → **NO_GO**; else any unmeasured KPI → **NOT_READY**; else **GO**.

## Tables owned

`realty_migration_runs` (soft-delete) · `realty_autonomy_events` (**append-only**) · `realty_no_ship_incidents` (**append-only** — DB rules block UPDATE/DELETE, mirroring `audit_logs`).

## Key gotchas

- **Response-P95 has no realty-table source** — it is supplied from observability via `POST launch-gate/evaluate`; absent ⇒ that check is INSUFFICIENT_DATA (NOT_READY, not a hard fail).
- **Money at the boundary:** import prices are rupees (plain / comma-grouped / `85L` / `1.2Cr`) → paise on commit.
- **`dryRun` writes nothing** but still records a VALIDATED run for the audit trail.
- **Pure utils** (`autonomy-ladder`, `launch-gate`, `inventory-import`) take an injected clock/`generatedAt` — no `Date.now()` inside — so they are deterministic.

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-pilot
```
