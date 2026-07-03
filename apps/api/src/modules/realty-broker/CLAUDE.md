# Module: realty-broker (GoSumo Realty — Phase 6)

The broker surface — everything a broker sees and controls: **hot-lead alerts**,
the **morning briefing**, the AI-draft **approval queue**, the **takeover protocol**,
the **autonomy dial**, and the **broker-console** metrics (blueprint §16).

## Public API (RealtyBrokerService)

```typescript
// Settings / autonomy dial (one row per business, lazily created)
getSettings / getSettingsDto / updateSettings
evaluateAutonomy(businessId, confidence, conversationId?)   // may the AI auto-send now?

// Approval queue (70–89% confidence band)
createApproval / listApprovals / getApproval
resolveApproval(businessId, id, { status: APPROVED|EDITED|REJECTED, editedText?, reason? }, reviewedBy?)

// Notification centre
listAlerts / markAlertRead / markAllAlertsRead

// Takeover protocol (AI ⇄ human ownership of a conversation)
takeOver / release / getControl        // getControl defaults to AI when no row exists

// Briefing + console
buildBriefing(businessId, now?)         // pure read
generateAndPushBriefing(businessId)     // build + push a MORNING_BRIEFING alert (the 7:30 job)
getConsoleMetrics(businessId)
```

## The autonomy dial (`evaluateAutonomy`)

The one call the AI loop asks before an autonomous send. Hard-noes first:
**kill switch on** → no · **human owns the conversation** (takeover) → no ·
**SUGGEST** mode → no. Otherwise (ASSISTED / AUTONOMOUS) auto-send iff
`confidence ≥ auto_approve_threshold`. Returns `{ autoSend, reason }`.

## Hot-lead dossier (blueprint §16)

`@OnEvent('realty.lead.hot')` builds a `HotLeadDossier` (name · BLTC summary ·
source · matched units · takeover handle) and pushes a `HOT_LEAD` alert instantly.

## Events

**Emits:** `realty.broker.alert`, `realty.approval.created`, `realty.approval.resolved`,
`realty.conversation.taken_over`.
**Listens:** `realty.lead.hot` (→ dossier alert).

## Tables owned

`realty_approvals` · `realty_account_settings` (autonomy dial + kill switch + briefing
config; one row per business) · `realty_broker_alerts` (notification feed) ·
`realty_conversation_control` (AI/human ownership for takeover).

## Key gotchas

- **Depends on `realty-leads`** (lead/pipeline data) and **`realty-cadence`** (active-cadence counts).
- **Settings are lazily created** — the first read of a business creates the default row.
- **A resolved approval is terminal** — re-resolving a non-PENDING draft throws.
- **Takeover is the AI's off-switch per conversation**: `evaluateAutonomy` returns `human_owned` while a human holds it.
- Briefing/console derive from `realty-leads` reads only (no hard dep on site-visits) — visits are proxied via the `VISIT_BOOKED` stage.

## Test

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/realty-broker
```
