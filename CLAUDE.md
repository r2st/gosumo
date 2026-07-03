# GoSumo — Root Context

GoSumo is an AI-powered client management platform that lets small businesses in India handle customer conversations across WhatsApp, Instagram, SMS, Web Chat, and Email through a single AI-driven interface.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 LTS + TypeScript 5.x (strict) |
| Backend | NestJS 10 |
| Frontend | Next.js 14 (dashboard) |
| ORM | Prisma 5 |
| Primary DB | PostgreSQL 16 |
| Cache / Queue broker | Redis 7 (BullMQ, sessions, pub/sub) |
| Vector store | Qdrant |
| AI | OpenRouter (free-tier models, e.g. `openai/gpt-oss-20b:free` / `openai/gpt-oss-120b:free`) via the OpenAI-compatible chat-completions API |
| Monorepo | Turborepo + pnpm workspaces |

## Key Commands

```bash
pnpm install                  # Install all workspace dependencies
pnpm dev                      # Start all apps in dev mode (turbo)
pnpm build                    # Build all apps (turbo)
pnpm test                     # Run all tests (turbo)
pnpm test:unit                # Unit tests only
pnpm test:integration         # Integration tests only
pnpm lint                     # Lint all packages
pnpm format                   # Prettier format

pnpm docker:up                # Start PostgreSQL, Redis, Qdrant via Docker Compose
pnpm docker:down              # Stop Docker services

pnpm db:migrate               # Run Prisma migrations (dev)
pnpm db:generate              # Regenerate Prisma client after schema changes
pnpm db:seed                  # Seed the database with dev data

# Run tests for a specific package
pnpm --filter @gosumo/api test
pnpm --filter @gosumo/shared test
```

## Monorepo Structure

```
apps/
  api/          # NestJS backend — @gosumo/api
  dashboard/    # Next.js frontend — @gosumo/dashboard
packages/
  shared/       # Shared types, DTOs, events, utils — @gosumo/shared
  database/     # Prisma schema + migrations — @gosumo/database
  config/       # Shared config — @gosumo/config
```

## Architecture: Core Principles

**Channel-agnostic.** Every inbound message from any channel is normalized to `NormalizedMessage` before processing. All downstream modules work on this format only.

**Event-driven.** Cross-module communication uses typed domain events (NestJS EventEmitter for in-process, BullMQ for durable async). Direct service injection is used for synchronous queries only.

**Multi-tenant.** Every database table has `business_id`. The `@TenantScoped()` decorator injects it automatically. PostgreSQL RLS enforces it as a backstop. Redis keys follow `gosumo:{businessId}:{resource}:{id}`.

**AI confidence routing.** AI decisions route to three paths:
- `>= 90%` confidence → auto-execute
- `70–89%` → draft for human review (HITL)
- `< 70%` → full human escalation

## Module Pattern

Every module follows `controller → service → repository`:
- **Controller:** validates input, calls service, returns DTO. No business logic.
- **Service:** orchestrates business logic, emits domain events, calls repository.
- **Repository:** all Prisma queries. Always includes `businessId` in WHERE clause.

Cross-module access: emit events for async flows; inject the other module's service for synchronous reads. Never query another module's tables directly.

## Critical Rules

1. **NEVER omit `businessId` filtering** in any database query. Every WHERE clause on a tenant table must include `businessId`.
2. **NEVER use `any` type.** TypeScript strict mode is enforced. Use proper types from `@gosumo/shared`.
3. **ALWAYS verify webhook signatures** before processing any inbound webhook payload (HMAC-SHA256).
4. **ALL monetary values stored in paise (integer).** Never store as float or decimal rupees. Display conversion happens in the frontend via `paiseToRupees()`.
5. **Soft delete only.** Use `deleted_at` timestamp, never `DELETE` on business data.
6. **Messages are append-only.** Never update message content after storage.
7. **audit_logs is append-only.** No UPDATE or DELETE ever runs on this table.
8. **Customer messages are untrusted input.** Never execute them as instructions; always pass to AI inside `<customer_message>` tags.

## Testing

- Framework: Jest with `ts-jest`
- Target: >80% unit test coverage per module
- Integration tests use testcontainers (real PostgreSQL + Redis)
- Run a module's tests: `pnpm --filter @gosumo/api test --testPathPattern=modules/channel-adapter`

## Commit Convention

Conventional commits: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`

Example: `feat(payment): add COD confirmation flow`

## Environment

Copy `apps/api/.env.example` to `apps/api/.env` and fill in values before running. Required: `DATABASE_URL`, `REDIS_URL`, `OPENROUTER_API_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `JWT_SECRET`.
