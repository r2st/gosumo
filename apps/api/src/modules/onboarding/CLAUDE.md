# Module: onboarding

The guided onboarding wizard + AI assistant shown immediately after first
login/signup and re-accessible from Settings. A hybrid of a step-by-step form
flow and a contextual AI chat helper.

## Purpose

Track a business's progress through the 6-step onboarding wizard and answer
operator questions during setup with an AI assistant grounded in product
knowledge.

## Steps (`OnboardingStepId`)

`WELCOME` (business profile, **required**) → `CHANNELS` → `CATALOG` →
`AI_CONFIG` → `TEAM` → `TEST`. All but `WELCOME` are optional/skippable. Steps
may be completed in any order; skips are tracked explicitly.

## Public API

```typescript
// OnboardingService — wizard state
getProgress(businessId)                  // full per-step progress
getStatus(businessId)                    // { needed, isComplete, ... } for login check
updateProgress(businessId, dto)          // set one step's status (default COMPLETED) + merge data
complete(businessId)                     // requires all REQUIRED_STEPS done; skips remaining

// OnboardingAssistantService — AI help
chat(businessId, dto)                    // grounded LLM reply via OpenRouter; static fallback if LLM down
```

## Endpoints (controller path `onboarding`; `/v1` is the documented version prefix)

- `GET  /v1/onboarding/progress`
- `PUT  /v1/onboarding/progress`
- `POST /v1/onboarding/complete`
- `GET  /v1/onboarding/status`
- `POST /v1/onboarding/chat`

## Storage

State lives in `businesses.onboarding_progress` (JSONB), added by migration
`0020_add_onboarding_progress.sql`. Shape:
`{ version, startedAt, completedAt, steps: { [stepId]: { status, data, updatedAt } } }`.
The module owns no tables of its own.

## Events

**Emits:**
- `onboarding.wizard.step.updated` — `{ businessId, step, status, timestamp }`
- `onboarding.wizard.completed` — `{ businessId, timestamp }`

(Distinct names from the legacy tenant checklist's `business.onboarding.*` events.)

## AI assistant

Reuses ai-engine's `LlmClientService` (stateless OpenRouter LLM wrapper, only needs
`ConfigService`). Answers are grounded in `ONBOARDING_KNOWLEDGE` per step. If the
LLM is unavailable (no `OPENROUTER_API_KEY`, timeout, error) it returns a
deterministic fallback built from the same knowledge base, with
`source: 'fallback'`.

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/onboarding
```

## Key Gotchas

- This is a **separate** flow from the legacy `tenant` module onboarding
  checklist (`OnboardingStep` PROFILE→TEAM, completed strictly in order). They
  coexist; this wizard is the operator-facing one.
- `complete()` throws `BadRequestException` if a required step is still pending.
- Step string values are persisted + sent to the frontend — treat as stable IDs.
