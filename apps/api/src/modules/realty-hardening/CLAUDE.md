# Module: realty-hardening (GoSumo Realty — Phase 7)

The cross-cutting **hardening** surface that makes the realty stack safe to run
unattended for 7 days on shadow traffic (blueprint §21 / plan P7). It adds no new
domain behaviour — it wraps the existing realty modules with audit, retries/DLQ,
rate limits, contradiction checks, and a readiness gate.

## What it provides

| Concern | Piece | Notes |
|---|---|---|
| **Audit every realty op** | `RealtyAuditInterceptor` (global) + `RealtyOperationsAuditService` | Auto-writes an append-only `audit_logs` row for every `POST/PUT/PATCH/DELETE` on a `realty/` route. Best-effort — never blocks the response. Complements the AI-decision-only `RealtyAuditService`. |
| **Retries + DLQ** | `RealtyDlqService` + `realty_dead_letters` + `realty-dlq` Bull queue | `runWithRetry()` wraps a fallible async op with bounded exponential backoff; on exhaustion it captures (never drops) the job. `replay()` re-runs it via a module-registered replayer. |
| **API rate limits** | `RealtyRateLimitGuard` (global) + `@RealtyRateLimit('<bucket>')` + `RealtyRateLimiter` | Per-(business, bucket) fixed-window; 429 + `Retry-After` on breach. Only engages on mutating `realty/` routes. In-memory now, Redis-swappable (mirrors `NotificationRateLimiter`). |
| **Contradiction checks** | `RealtyContradictionService` + `bltc-contradiction.util` | Full BLTC data-consistency validation (ERROR = impossible e.g. budget floor > ceiling; WARN = implausible e.g. 4BHK in ₹20L). |
| **Soak readiness** | `RealtyHealthService` → `GET realty/ops/health` | Worst-of DB reachability, DLQ backlog depth, rate-limiter pressure. |

## REST surface (`realty/ops`)

```
GET  realty/ops/health              # readiness gate (pass/warn/fail)
GET  realty/ops/dlq                 # list dead letters (filter: status/source/operation)
GET  realty/ops/dlq/stats           # counts by status
GET  realty/ops/dlq/:id             # one dead letter
POST realty/ops/dlq/:id/replay      # re-run via its registered replayer  (@RealtyRateLimit dlq-replay)
POST realty/ops/dlq/:id/resolve     # mark RESOLVED | DISCARDED
POST realty/ops/bltc/validate       # validate a supplied BLTC profile
GET  realty/ops/bltc/lead/:id       # validate a stored lead's BLTC
```

## Registering a replayer (producers of dead letters)

A module that dead-letters work registers how to replay it, in `onModuleInit`:

```typescript
this.dlq.registerReplayer('realty.visit.reminder', async (businessId, payload) => {
  await this.visitsService.fireReminder(businessId, payload.visitId, payload.minutesBefore);
});
```

`realty-sitevisits` is the reference integration: the reminder processor runs
each reminder through `runWithRetry({ swallow: true })` so a bad reminder is
captured + swallowed (the worker is never wedged) and stays replayable.

## Tables owned

- `realty_dead_letters` — captured failed operations (`source`, `operation`,
  `payload`, `error_message`, `attempts`, `status`, replay/resolve bookkeeping).
  Tenant-scoped + RLS; append-mostly (only status/replay columns mutate).

## Key gotchas

- **Interceptor + guard are global but self-gate** to mutating `realty/` routes,
  so the rest of the platform is untouched.
- **Guards run before the tenant interceptor**, so the rate-limit guard reads the
  tenant from `req.user.businessId` (JWT), not `req.tenantId`.
- **Audit is best-effort** — an `audit_logs` write failure is logged, never thrown.
- **`audit_logs` is append-only** — we only ever INSERT.
- **DLQ capture never throws** — even a failed persistence is logged, not raised.
- **Money in BLTC contradiction checks is paise** (`LAKH = 1e7 paise`).
- Auto-discard: a dead letter that fails `DLQ_MAX_REPLAYS` replays becomes `DISCARDED`.

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-hardening
```
