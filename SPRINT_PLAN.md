# GoSumo — Sprint Plan

> AI-agent-executable ticket backlog for the 15-week GoSumo build.
> Each ticket is designed to be completed by a single AI agent in one session.

---

## Quick Reference

| Symbol | Meaning |
|---|---|
| P0 | Blocker — nothing else ships without this |
| P1 | Critical path — sprint cannot close without this |
| P2 | Important — ships in same sprint if possible |
| P3 | Nice-to-have — defer to next sprint if needed |
| S | Small: 1-2 hours |
| M | Medium: 4-8 hours |
| L | Large: 1-2 days |
| XL | Extra Large: 3-5 days |

---

## Critical Path Diagram

```mermaid
graph LR
    GS001[GS-001 Monorepo] --> GS002[GS-002 Shared Types]
    GS001 --> GS003[GS-003 Docker Compose]
    GS001 --> GS004[GS-004 CI/CD]
    GS002 --> GS005[GS-005 Prisma Schema]
    GS003 --> GS005
    GS005 --> GS006[GS-006 Auth Module]
    GS005 --> GS007[GS-007 Tenant Module]
    GS005 --> GS008[GS-008 DB Migrations]
    GS006 --> GS009[GS-009 RBAC Guards]
    GS007 --> GS009
    GS009 --> GS010[GS-010 WhatsApp Adapter]
    GS008 --> GS010
    GS010 --> GS011[GS-011 Channel Registry]
    GS011 --> GS012[GS-012 Conversation Service]
    GS012 --> GS013[GS-013 Message Service]
    GS013 --> GS014[GS-014 Event Bus]
    GS014 --> GS015[GS-015 AI Engine Core]
    GS015 --> GS016[GS-016 Intent Classifier]
    GS015 --> GS017[GS-017 RAG Pipeline]
    GS016 --> GS018[GS-018 Confidence Calculator]
    GS017 --> GS018
    GS018 --> GS019[GS-019 Confidence Router]
    GS019 --> GS020[GS-020 HITL Task Queue]
    GS020 --> GS021[GS-021 HITL Internal Chat]
    GS019 --> GS022[GS-022 Client Intelligence]
    GS022 --> GS023[GS-023 Churn Scoring]
    GS008 --> GS024[GS-024 Catalog Service]
    GS024 --> GS025[GS-025 Booking Service]
    GS024 --> GS026[GS-026 Payment Service]
    GS026 --> GS027[GS-027 Razorpay Integration]
    GS024 --> GS028[GS-028 Order Service]
    GS028 --> GS029[GS-029 Shipping Service]
    GS029 --> GS030[GS-030 Shiprocket Integration]
    GS026 --> GS031[GS-031 Order-Payment Link]
    GS031 --> GS032[GS-032 Order-Shipping Link]
    GS013 --> GS033[GS-033 Campaign Service]
    GS033 --> GS034[GS-034 Campaign Scheduler]
    GS033 --> GS035[GS-035 Lifecycle Triggers]
    GS009 --> GS036[GS-036 Dashboard Shell]
    GS036 --> GS037[GS-037 Conversation UI]
    GS036 --> GS038[GS-038 Analytics Dashboard]
    GS020 --> GS039[GS-039 HITL Dashboard]
    GS037 --> GS040[GS-040 Socket.IO Real-time]
    GS038 --> GS041[GS-041 Analytics Service]
    GS041 --> GS042[GS-042 Autonomy KPIs]
    GS004 --> GS043[GS-043 E2E Test Suite]
    GS043 --> GS044[GS-044 Load Testing]
    GS044 --> GS045[GS-045 Security Audit]
    GS045 --> GS046[GS-046 Beta Prep]
```

---

## Sprint 0 — Project Foundation
**Weeks 1 (Days 1-5) | Goal: Working monorepo, local dev stack, CI pipeline**

---

### GS-001 — Initialize Turborepo Monorepo
**Module:** Infrastructure
**Priority:** P0
**Effort:** M

**Dependencies:** None

**Acceptance Criteria:**
- `pnpm install` completes without errors from the root
- `turbo build` succeeds and caches correctly on second run
- `apps/api`, `apps/dashboard`, `packages/shared`, `packages/database`, `packages/config` directories exist with valid `package.json` files
- `pnpm-workspace.yaml` correctly references all packages
- `turbo.json` defines `build`, `test`, `lint`, `dev` pipelines
- Root `tsconfig.base.json` with strict mode enabled
- `.eslintrc.js` and `.prettierrc` at root, shared across all packages
- `.gitignore` covers node_modules, dist, .env files, Prisma generated files

**AI Agent Notes:**
- Use `npx create-turbo@latest` as the starting scaffold, then restructure to match the ARCHITECTURE.md layout
- pnpm version should be pinned in `packageManager` field of root package.json (use pnpm@9.x)
- Node.js engine constraint: `>=20.0.0`
- The `packages/shared` package is `@gosumo/shared`, `packages/database` is `@gosumo/database`, `packages/config` is `@gosumo/config`
- Add `"@gosumo/*": ["packages/*/src/index.ts"]` path aliases in tsconfig.base.json

---

### GS-002 — Build @gosumo/shared Package
**Module:** Shared
**Priority:** P0
**Effort:** M

**Dependencies:** GS-001

**Acceptance Criteria:**
- Package exports compile cleanly with `tsc --noEmit`
- `src/enums/` contains: `ChannelType`, `MessageContentType`, `ConversationStatus`, `IntentType`, `OrderStatus`, `PaymentStatus`, `BookingStatus`, `CampaignStatus`, `UserRole`, `TaskStatus`
- `src/interfaces/` contains: `NormalizedMessage`, `MessageContent` (discriminated union), `ChannelAdapter`, `ChannelCapabilities`
- `src/events/` contains typed domain event interfaces for all 30+ events listed in ARCHITECTURE.md section 6
- `src/dto/` contains base DTOs: `PaginationDto`, `TenantScopedDto`
- `src/utils/` contains: `generateId()` (CUID2), `slugify()`, `maskPII()`
- All exports available via single `index.ts` barrel

**AI Agent Notes:**
- Use `@paralleldrive/cuid2` for ID generation
- ChannelType enum values: `WHATSAPP`, `INSTAGRAM`, `SMS`, `WEB_CHAT`, `EMAIL`
- Domain event types should follow the pattern `{ eventName: string; businessId: string; timestamp: Date; payload: T }`
- NormalizedMessage interface must exactly match the TypeScript interface in ARCHITECTURE.md section 5
- No runtime dependencies except `@paralleldrive/cuid2` and `class-validator`

---

### GS-003 — Configure Docker Compose Development Stack
**Module:** Infrastructure
**Priority:** P0
**Effort:** M

**Dependencies:** GS-001

**Acceptance Criteria:**
- `docker compose up -d` starts all services without errors
- Services: `postgres` (16-alpine, port 5432), `redis` (7-alpine, port 6379), `qdrant` (latest, port 6333/6334), `api` (port 3000), `dashboard` (port 3001)
- Postgres has a persistent named volume, initializes with `gosumo` database
- Redis has persistence enabled (AOF)
- Qdrant has a persistent volume at `./docker/qdrant_storage`
- Health checks defined for postgres, redis, qdrant
- `api` service depends_on postgres, redis, qdrant with condition: service_healthy
- `.env.example` documents all required environment variables
- `docker/Dockerfile` for the API uses multi-stage build: builder stage (compiles TS), runner stage (node:20-alpine, non-root user)
- `make dev` shortcut starts compose stack

**AI Agent Notes:**
- Use `docker-compose.yml` at root `docker/` directory
- Postgres connection string format: `postgresql://gosumo:gosumo@localhost:5432/gosumo`
- Redis URL: `redis://localhost:6379`
- Qdrant REST: `http://localhost:6333`, gRPC: `http://localhost:6334`
- Add a `docker/wait-for-it.sh` script for service readiness in CI
- BullMQ Board (bull-board) should run as a separate Express app on port 3002, mounted at `/queues`

---

### GS-004 — Configure GitHub Actions CI/CD Pipeline
**Module:** Infrastructure
**Priority:** P1
**Effort:** M

**Dependencies:** GS-001

**Acceptance Criteria:**
- `.github/workflows/ci.yml` runs on every PR and push to `main`
- CI steps: install (pnpm), lint (ESLint), type-check (tsc), unit tests (jest), build (turbo build)
- Turbo remote caching configured (Vercel Remote Cache or self-hosted)
- Separate `.github/workflows/deploy.yml` for `main` branch push: builds Docker image, pushes to registry, placeholder deploy step
- PR checks must pass before merge (branch protection rules documented in README)
- CI runs in under 5 minutes on a warm cache
- `.github/PULL_REQUEST_TEMPLATE.md` with checklist: tests added, types updated, CLAUDE.md updated

**AI Agent Notes:**
- Use `pnpm/action-setup@v4` for pnpm in GitHub Actions
- Cache pnpm store with `actions/cache` using `pnpm-lock.yaml` as cache key
- Use `turbo` with `--filter=[HEAD^1]` to only build/test affected packages on PRs
- Docker image name: `ghcr.io/gosumo/api:${{ github.sha }}`
- Add Dependabot config for npm and Docker dependencies

---

### GS-005 — Design and Initialize Prisma Schema
**Module:** Database
**Priority:** P0
**Effort:** L

**Dependencies:** GS-002, GS-003

**Acceptance Criteria:**
- `packages/database/prisma/schema.prisma` defines all core models
- Models: `Business`, `User`, `UserBusinessMember`, `Channel`, `Contact`, `Conversation`, `Message`, `AIDecision`, `Task`, `Product`, `ProductVariant`, `Service`, `Booking`, `Order`, `OrderItem`, `Payment`, `Shipment`, `Campaign`, `CampaignMessage`, `ClientProfile`
- Every model has `id String @id @default(cuid())`, `createdAt DateTime @default(now())`, `updatedAt DateTime @updatedAt`
- Every tenant-scoped model has `businessId String` with a relation to `Business`
- `prisma generate` succeeds and produces typed client
- `prisma migrate dev --name init` creates the initial migration without errors
- `packages/database/src/index.ts` exports the PrismaClient singleton and all generated types

**AI Agent Notes:**
- Use `datasource db { provider = "postgresql" url = env("DATABASE_URL") }`
- Add `generator client { provider = "prisma-client-js" binaryTargets = ["native", "linux-musl-openssl-3-0-x"] }` for Docker compatibility
- Business model: `id`, `name`, `slug @unique`, `phone`, `email`, `settings Json @default("{}")`, `isActive Boolean @default(true)`
- Conversation model: `status ConversationStatus`, `channel ChannelType`, `contactId`, `businessId`, `assignedUserId?`, `metadata Json @default("{}")`
- Message model: `conversationId`, `direction MessageDirection`, `contentType MessageContentType`, `content Json`, `externalId?`, `channelAccountId`
- AIDecision model: `messageId`, `intent String`, `confidence Decimal`, `action String`, `reasoning String?`, `wasOverridden Boolean @default(false)`
- Add `@@index([businessId])` to all tenant-scoped models

---

## Sprint 1 — Auth, Tenant & First Channel
**Weeks 1-2 (Days 6-14) | Goal: Authenticated API with WhatsApp receiving messages**

---

### GS-006 — Implement Auth Module (JWT + Refresh Tokens)
**Module:** auth
**Priority:** P0
**Effort:** L

**Dependencies:** GS-005

**Acceptance Criteria:**
- `POST /auth/register` creates a new user + business, returns access + refresh tokens
- `POST /auth/login` validates credentials, returns tokens
- `POST /auth/refresh` rotates refresh token, returns new pair
- `POST /auth/logout` invalidates refresh token in Redis
- Access token TTL: 15 minutes, Refresh token TTL: 7 days
- Passwords hashed with bcrypt (rounds=12)
- JWT payload: `{ sub: userId, businessId, role, iat, exp }`
- `JwtAuthGuard` and `JwtStrategy` implemented using `@nestjs/passport` + `passport-jwt`
- Refresh tokens stored in Redis with key `gosumo:{businessId}:refresh:{tokenId}`
- `GET /auth/me` returns current user profile
- All endpoints have integration tests passing

**AI Agent Notes:**
- Use `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt`, `bcrypt`
- Register `JwtModule.registerAsync` in `AuthModule` pulling secret from `ConfigService`
- Refresh token should be a random UUID stored as a hash; the token sent to client is the UUID
- `AuthModule` should export `JwtAuthGuard` for use in other modules
- Store user's last login timestamp on successful login
- Email must be lowercased and trimmed before storing

---

### GS-007 — Implement Tenant Module (Business Profiles)
**Module:** tenant
**Priority:** P0
**Effort:** M

**Dependencies:** GS-005

**Acceptance Criteria:**
- `GET /tenant/profile` returns the authenticated business's full profile
- `PATCH /tenant/profile` updates name, phone, email, settings
- `GET /tenant/members` lists all staff members with roles
- `POST /tenant/members/invite` sends invite (stub email, store pending invite in DB)
- `DELETE /tenant/members/:userId` removes member (Owner only)
- `TenantMiddleware` injects `businessId` from JWT into `request.businessId` for all routes
- `@TenantScoped()` decorator marks services that auto-scope queries to `businessId`
- `TenantService.getBusinessOrThrow(businessId)` used by other modules for validation
- All routes protected by `JwtAuthGuard`

**AI Agent Notes:**
- Tenant middleware should be applied globally in `AppModule` via `configure(consumer)`
- The `@TenantScoped()` decorator is a class decorator that signals to the request-scoped provider pattern
- Use NestJS `REQUEST` scope for `TenantContextService` so each request gets its own instance
- `TenantContextService` provides `getBusinessId(): string` — throws if not set
- Settings should be stored as `JSONB` and merged (not replaced) on PATCH

---

### GS-008 — Run Database Migrations and Seed Script
**Module:** Database
**Priority:** P0
**Effort:** S

**Dependencies:** GS-005

**Acceptance Criteria:**
- `pnpm db:migrate` runs all pending migrations against the Docker Postgres instance
- `pnpm db:seed` creates: 1 demo business ("Priya's Boutique"), 2 users (owner + staff), 5 sample products, 3 sample conversations
- `pnpm db:reset` drops all data and re-seeds (for development)
- `pnpm db:studio` opens Prisma Studio on port 5555
- Migration scripts are idempotent (safe to run multiple times)
- Seed data uses realistic Indian business context (INR prices, Indian names, WhatsApp numbers)

**AI Agent Notes:**
- Seed file at `packages/database/prisma/seed.ts`
- Add `"prisma": { "seed": "ts-node prisma/seed.ts" }` to database package.json
- Use `prisma.$transaction([...])` for atomic seed operations
- Demo business phone: `+919876543210`, business slug: `priyas-boutique`
- Products should include: kurta, saree, lehenga, dupatta, jewelry — all with INR pricing

---

### GS-009 — Implement RBAC Guards and Role System
**Module:** auth
**Priority:** P0
**Effort:** M

**Dependencies:** GS-006, GS-007

**Acceptance Criteria:**
- `UserRole` enum: `OWNER`, `MANAGER`, `STAFF`
- `@Roles(UserRole.OWNER, UserRole.MANAGER)` decorator applied to controller methods
- `RolesGuard` checks JWT role claim against required roles, returns 403 if insufficient
- `@Public()` decorator bypasses `JwtAuthGuard` for public endpoints (webhook receivers)
- Permission matrix documented in code comments:
  - OWNER: all operations
  - MANAGER: all except billing, member management
  - STAFF: read conversations, send messages, resolve tasks
- `CurrentUser()` parameter decorator extracts user from request
- `CurrentBusiness()` parameter decorator extracts businessId
- Unit tests for each role scenario

**AI Agent Notes:**
- Use `SetMetadata` for `@Roles()` and `@Public()` decorators
- `RolesGuard` must implement `CanActivate` and use `Reflector` to read metadata
- Apply `JwtAuthGuard` and `RolesGuard` as global guards in `AppModule`; use `@Public()` to exempt webhook routes
- The `CurrentUser` decorator: `createParamDecorator((_, ctx) => ctx.switchToHttp().getRequest().user)`

---

### GS-010 — Implement WhatsApp Business API Channel Adapter
**Module:** channel-adapter
**Priority:** P0
**Effort:** L

**Dependencies:** GS-009, GS-008

**Acceptance Criteria:**
- `POST /webhooks/whatsapp` receives Meta webhook verification (GET) and message events (POST)
- HMAC-SHA256 signature verification using `X-Hub-Signature-256` header
- Parses inbound message types: text, image, document, location, interactive (button reply, list reply)
- Normalizes to `NormalizedMessage` format (matches `@gosumo/shared` interface exactly)
- Sends text messages via `POST https://graph.facebook.com/v19.0/{phoneNumberId}/messages`
- Sends template messages with parameter substitution
- Sends interactive messages (buttons, lists)
- Media download: downloads WhatsApp media and stores URL reference
- `WhatsAppAdapter` implements the `ChannelAdapter` interface from `@gosumo/shared`
- Webhook endpoint is `@Public()` — no auth required
- All incoming messages persisted to `Message` table before emitting events

**AI Agent Notes:**
- Use `axios` for Meta Graph API calls; set timeout to 10s
- WhatsApp webhook verification: check `hub.mode === 'subscribe'` and `hub.verify_token` matches env var `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Message types to handle: `type: 'text'`, `type: 'image'`, `type: 'document'`, `type: 'location'`, `type: 'interactive'`
- For interactive messages: `interactive.type === 'button_reply'` → `INTERACTIVE` content type
- Store `phoneNumberId` as `channelAccountId` on the message
- Rate limit: WhatsApp allows 80 messages/second per phone number — add a token bucket in Redis

---

### GS-011 — Build Channel Registry and Adapter Factory
**Module:** channel-adapter
**Priority:** P1
**Effort:** M

**Dependencies:** GS-010

**Acceptance Criteria:**
- `ChannelRegistry` is a NestJS injectable that maps `ChannelType` → `ChannelAdapter` instance
- `ChannelRegistry.getAdapter(channelType)` returns the correct adapter or throws `ChannelNotSupportedException`
- `ChannelRegistry.getSupportedChannels()` returns list of registered adapters
- `OutboundRouter` uses registry to route outbound messages to correct adapter
- `ChannelAdapterModule` provides `ChannelRegistry` and `OutboundRouter`
- Web Chat adapter stub registered (returns `UnsupportedOperationException` for sends — placeholder)
- Integration test: send a normalized message through the registry, verify it routes to WhatsApp adapter

**AI Agent Notes:**
- Registry should be populated in `ChannelAdapterModule` via `onModuleInit`
- Each adapter should declare its `channelType` as a readonly property
- `OutboundRouter.send(message: OutboundMessage)` resolves channel from `message.channel` then calls adapter
- Export `ChannelRegistry` and `OutboundRouter` from the module's `index.ts`

---

### GS-012 — Implement Conversation Service and State Machine
**Module:** conversation
**Priority:** P0
**Effort:** L

**Dependencies:** GS-008, GS-011

**Acceptance Criteria:**
- `ConversationService.findOrCreate(contactExternalId, channelType, businessId)` — idempotent conversation lookup/creation
- Conversation state machine: `OPEN` → `WAITING_AI` → `WAITING_HUMAN` → `RESOLVED` → `REOPENED`
- `ConversationService.transition(conversationId, newStatus, actorId?)` validates state transitions
- Invalid transitions throw `InvalidTransitionException` with current + target state in message
- `GET /conversations` lists conversations with pagination, filters (status, channel, assignee)
- `GET /conversations/:id` returns conversation with recent 50 messages
- `PATCH /conversations/:id/assign` assigns conversation to a staff user
- `PATCH /conversations/:id/resolve` marks conversation resolved
- Contact auto-created if not exists (keyed on `externalId + businessId`)
- All queries scoped by `businessId`

**AI Agent Notes:**
- Valid transitions: `OPEN→WAITING_AI`, `WAITING_AI→WAITING_HUMAN`, `WAITING_AI→OPEN`, `WAITING_HUMAN→OPEN`, `OPEN→RESOLVED`, `WAITING_HUMAN→RESOLVED`, `RESOLVED→REOPENED`, `REOPENED→OPEN`
- Use Redis to cache active conversation IDs per business: `gosumo:{businessId}:active_conversations` (sorted set by last message time)
- `findOrCreate` must be wrapped in a Prisma transaction with a unique constraint on `(contactId, businessId, channel, status NOT IN ['RESOLVED'])`
- Emit `conversation.created` event on new conversation

---

### GS-013 — Implement Message Service and Storage
**Module:** message
**Priority:** P0
**Effort:** M

**Dependencies:** GS-012

**Acceptance Criteria:**
- `MessageService.store(normalizedMessage)` persists a `NormalizedMessage` to PostgreSQL
- `MessageService.getHistory(conversationId, limit, cursor)` returns paginated messages (keyset pagination)
- `MessageService.markDelivered(externalId)` updates delivery status
- `MessageService.search(businessId, query, filters)` performs full-text search on message content
- Full-text search uses PostgreSQL `tsvector` on the `content->>'text'` field
- Messages with non-text content store searchable text in a generated column
- `GET /messages/search?q=&conversationId=&channel=&dateFrom=&dateTo=` endpoint
- Message deduplication: `externalId + channelAccountId` must be unique; duplicate inserts are silently ignored

**AI Agent Notes:**
- Keyset pagination: use `(createdAt, id)` as cursor, encoded as base64 JSON
- Add GIN index on the tsvector column: `CREATE INDEX messages_content_fts ON messages USING GIN(content_tsvector)`
- For `content Json` storage: store the full `MessageContent` discriminated union object
- `MessageService` should emit `message.received` event after successful storage

---

### GS-014 — Implement Event Bus (NestJS EventEmitter + BullMQ)
**Module:** Infrastructure
**Priority:** P0
**Effort:** M

**Dependencies:** GS-003, GS-013

**Acceptance Criteria:**
- `EventBusModule` provides two event mechanisms:
  1. `InProcessEventBus` — NestJS `EventEmitter2` for in-process synchronous events
  2. `DurableEventBus` — BullMQ for async durable jobs that survive restarts
- `EventBusService.emit(eventName, payload)` publishes to in-process bus
- `EventBusService.enqueue(queueName, jobName, payload, opts?)` publishes to BullMQ
- All 30+ domain events from ARCHITECTURE.md are typed and routable
- BullMQ queues defined: `ai-processing`, `campaign`, `analytics`, `notifications`
- Bull Board UI mounted at `/queues` (admin only, behind `@Roles(UserRole.OWNER)`)
- Dead letter queue configured for failed jobs (max 3 retries, exponential backoff)
- `pnpm dev:queues` opens Bull Board in browser

**AI Agent Notes:**
- Use `@nestjs/event-emitter` for in-process, `bullmq` + `@nestjs/bullmq` for durable
- `EventEmitter2` with `wildcard: true` allows `message.*` pattern subscriptions
- BullMQ connection uses Redis from `ConfigService`
- Job retry: `{ attempts: 3, backoff: { type: 'exponential', delay: 2000 } }`
- All job payloads must include `businessId` as a top-level field for tenant validation in workers

---

## Sprint 2 — AI Engine Core
**Weeks 3-4 | Goal: Messages flow through AI pipeline, responses generated**

---

### GS-015 — Build AI Engine Module Core
**Module:** ai-engine
**Priority:** P0
**Effort:** L

**Dependencies:** GS-014

**Acceptance Criteria:**
- `AIEngineService.process(message: NormalizedMessage, context: ConversationContext)` is the main entry point
- `ConversationContext` type: `{ conversation: Conversation; history: Message[]; contact: Contact; businessProfile: Business }`
- Subscribes to `message.received` event via `@OnEvent('message.received')`
- Loads conversation context before calling AI pipeline
- Calls Anthropic Claude API using `@anthropic-ai/sdk`
- Returns `AIResult`: `{ intent: string; confidence: number; response: string; action?: AIAction; reasoning: string }`
- Persists `AIDecision` to database for every processed message
- Handles Anthropic API errors gracefully: retries up to 2x with 1s delay, then escalates to HITL
- Processing time logged and stored; alerts if >4 seconds

**AI Agent Notes:**
- Anthropic model: `claude-opus-4-5` (configurable via env `ANTHROPIC_MODEL`)
- Set `max_tokens: 1024` for responses, `temperature: 0` for deterministic intent classification
- Use streaming for response generation (collect full response before routing)
- `ConversationContext` loaded by `ContextLoaderService` in parallel (Promise.all for speed)
- The `ai-processing` BullMQ queue should be consumed by a separate worker process for isolation

---

### GS-016 — Implement Intent Classifier
**Module:** ai-engine
**Priority:** P0
**Effort:** M

**Dependencies:** GS-015

**Acceptance Criteria:**
- `IntentClassifierService.classify(message, context)` returns `{ intent: IntentType; confidence: number; entities: Record<string, unknown> }`
- Intent types: `PRODUCT_INQUIRY`, `PRICE_CHECK`, `PLACE_ORDER`, `ORDER_STATUS`, `BOOKING_REQUEST`, `CANCEL_BOOKING`, `PAYMENT_QUERY`, `REFUND_REQUEST`, `COMPLAINT`, `COMPLIMENT`, `GENERAL_INQUIRY`, `ESCALATION_REQUEST`, `OUT_OF_SCOPE`
- Classification uses a dedicated Claude call with a structured output prompt
- Claude returns JSON: `{ intent, confidence, entities, reasoning }`
- `entities` extracted per intent: product name, quantity, date/time, order ID, amount
- Falls back to `GENERAL_INQUIRY` with 0.5 confidence if Claude response is malformed
- Emits `ai.intent.classified` event after classification
- Unit tests with 15+ real WhatsApp message examples covering all intent types

**AI Agent Notes:**
- System prompt for classification should include the full intent list with descriptions and examples in Indian English
- Use `zod` to validate Claude's JSON response; re-prompt once if validation fails
- Entity extraction for `BOOKING_REQUEST` must parse date/time in formats: "kal dopahar 2 baje", "tomorrow 3pm", "15th March at 4"
- Confidence should be a number 0-100 from Claude, not a probability — prompt Claude to use this scale
- Cache classification results for identical messages (same business + message text) for 1 hour in Redis

---

### GS-017 — Build RAG Pipeline (Qdrant + Embeddings)
**Module:** ai-engine
**Priority:** P1
**Effort:** L

**Dependencies:** GS-015

**Acceptance Criteria:**
- `RAGService.search(query, businessId, filters?)` returns top-5 relevant chunks
- Qdrant collection per business: `gosumo_{businessId}` with vector size 1536 (OpenAI ada-002 compatible)
- `RAGService.index(document, businessId, metadata)` chunks and indexes a document
- Document types indexable: product descriptions, business FAQs, policy documents, previous resolved conversations
- Chunk size: 512 tokens, 50-token overlap
- Each chunk stored with metadata: `{ businessId, sourceType, sourceId, chunkIndex }`
- `GET /rag/index` endpoint (Owner only) to trigger re-indexing of all business data
- `DELETE /rag/index/:sourceType/:sourceId` removes chunks for a specific source
- Similarity threshold: only return chunks with score > 0.75

**AI Agent Notes:**
- Use `@qdrant/js-client-rest` for Qdrant operations
- For embeddings: use Anthropic's `voyage-3` model via the Voyage API (env: `VOYAGE_API_KEY`) — it's better for Indian English
- Collection config: `{ vectors: { size: 1024, distance: 'Cosine' } }` (voyage-3 outputs 1024 dimensions)
- Auto-index products when `product.created` / `product.updated` events fire
- Chunk text using a simple sentence-boundary splitter; do not split mid-sentence

---

### GS-018 — Implement Confidence Calculator
**Module:** ai-engine
**Priority:** P0
**Effort:** M

**Dependencies:** GS-016, GS-017

**Acceptance Criteria:**
- `ConfidenceCalculatorService.calculate(intent, ragContext, businessContext)` returns final confidence score 0-100
- Formula: `(data_availability × 0.5) + (policy_clarity × 0.5)` per ARCHITECTURE.md
- Hard overrides that force confidence < 50:
  - Price requested but not in catalog → confidence = 40
  - Refund exceeds policy limit → confidence = 30
  - Customer message contains legal keywords ("consumer forum", "case", "police") → confidence = 20
  - Loop detection: >3 exchanges with same intent, no resolution → confidence = 35
  - Negative sentiment score < -0.7 → confidence = 45
- Override reason stored in `AIDecision.reasoning`
- Unit tests cover all 5 hard override scenarios plus normal scoring

**AI Agent Notes:**
- `data_availability`: 100 if RAG returned 3+ high-quality chunks, 70 if 1-2 chunks, 30 if no chunks
- `policy_clarity`: derived from Claude's own confidence estimate in the intent classification response
- Legal keywords list (in English + Hindi transliteration): ["consumer forum", "court", "police", "FIR", "advocate", "case file", "cheating", "fraud", "grahak", "adalat"]
- Loop detection uses Redis counter: `gosumo:{businessId}:loop:{conversationId}` incremented per turn, reset on intent change

---

### GS-019 — Implement Confidence Router
**Module:** ai-engine
**Priority:** P0
**Effort:** M

**Dependencies:** GS-018

**Acceptance Criteria:**
- `ConfidenceRouterService.route(aiResult, conversationId)` routes based on confidence:
  - ≥ 90: auto-execute — send response immediately
  - 70-89: create HITL draft review task
  - < 70: full escalation — create HITL escalation task + send holding message
- Auto-execute path: calls `OutboundRouter.send()` directly
- Draft review path: creates Task with `type: REVIEW_DRAFT`, attaches AI response as draft
- Escalation path: creates Task with `type: ESCALATION`, sends holding message to customer
- Holding message templates configurable per business (default: "We're looking into your query and will get back to you shortly.")
- Routing decision logged to `AIDecision` record
- Emits appropriate events: `ai.response.generated`, `task.created`

**AI Agent Notes:**
- Thresholds should be configurable per business via `Business.settings.confidenceThresholds`
- Default thresholds stored in `@gosumo/config` as `AI_AUTO_THRESHOLD=90`, `AI_REVIEW_THRESHOLD=70`
- The holding message must be sent within 5 seconds of receiving a low-confidence message — use BullMQ `delay: 0` for priority

---

### GS-020 — Build HITL Task Queue Service
**Module:** hitl
**Priority:** P1
**Effort:** L

**Dependencies:** GS-019

**Acceptance Criteria:**
- `TaskService.create(dto: CreateTaskDto)` creates a task with status `PENDING`
- Task types: `REVIEW_DRAFT`, `ESCALATION`, `APPROVAL_REQUIRED`
- `TaskService.claim(taskId, userId)` assigns task to a user, sets status `IN_PROGRESS`
- `TaskService.resolve(taskId, resolution: TaskResolution)` closes task
- `TaskResolution`: `{ action: 'APPROVE' | 'REJECT' | 'EDIT'; editedResponse?: string; note?: string }`
- On APPROVE: emit `ai.response.approved`, trigger message send
- On REJECT: emit `ai.response.rejected`, task marked rejected, conversation stays open
- On EDIT: send edited response, emit `ai.response.approved` with edited flag
- `GET /tasks` lists tasks with filters (type, status, assignee, conversationId)
- Tasks auto-expire after 24 hours (BullMQ delayed job to auto-escalate)
- SLA tracking: time from task creation to resolution stored per task

**AI Agent Notes:**
- Task model needs: `type`, `status`, `conversationId`, `messageId`, `aiDecisionId`, `assignedUserId?`, `draftResponse?`, `resolution Json?`, `slaDeadline DateTime`
- Use a BullMQ delayed job `hitl-sla-check` scheduled 24h after task creation to auto-escalate unresolved tasks
- Emit `task.created` event via Socket.IO to push real-time notification to dashboard

---

### GS-021 — Implement HITL Internal Chat
**Module:** hitl
**Priority:** P2
**Effort:** M

**Dependencies:** GS-020

**Acceptance Criteria:**
- Internal notes can be added to any task or conversation by staff users
- `POST /tasks/:id/notes` adds an internal note (not visible to customer)
- `POST /conversations/:id/notes` adds a conversation note
- Notes are typed: `INTERNAL_NOTE`, `HANDOFF_NOTE`, `RESOLUTION_NOTE`
- `@mention` support: parse `@userId` in note text, emit notification to mentioned user
- Notes retrieved with task/conversation detail endpoints
- All notes are tenant-scoped and staff-only (not surfaced to customers)

**AI Agent Notes:**
- Note model: `{ id, taskId?, conversationId?, authorId, content, type, mentionedUserIds String[] }`
- `@mention` parsing: regex `/\@([a-zA-Z0-9_]+)/g` matched against business member list
- Mentions trigger `notification.mention` event consumed by Socket.IO gateway

---

## Sprint 3 — Client Intelligence & HITL Polish
**Weeks 5-6 | Goal: Rich client profiles, full HITL workflow operational**

---

### GS-022 — Build Client Intelligence Service
**Module:** client-intelligence
**Priority:** P1
**Effort:** L

**Dependencies:** GS-013, GS-017

**Acceptance Criteria:**
- `ClientProfileService.buildProfile(contactId, businessId)` aggregates all contact data into a rich profile
- Profile includes: total orders, total spend (INR), last purchase date, preferred categories, average order value, communication frequency, preferred channel
- Profile updated asynchronously on `message.received`, `order.created`, `payment.success` events
- `ClientProfileService.getSentiment(contactId)` returns sentiment trend over last 30 days
- Sentiment derived from message content using Claude (cached per day)
- Profile stored in `ClientProfile` table + embedded in Qdrant for semantic search
- `GET /clients/:contactId/profile` returns full client profile
- `GET /clients/:contactId/history` returns interaction timeline (messages + orders + payments)

**AI Agent Notes:**
- Sentiment scoring: call Claude with last 10 messages, return score -1 to +1 and label (POSITIVE/NEUTRAL/NEGATIVE)
- Use `Promise.all` to load profile components in parallel
- Qdrant embedding for client profile: embed a text summary of the profile for "find similar customers" queries
- Cache profiles in Redis for 1 hour: `gosumo:{businessId}:client:{contactId}:profile`

---

### GS-023 — Implement Churn Risk Scoring
**Module:** client-intelligence
**Priority:** P2
**Effort:** M

**Dependencies:** GS-022

**Acceptance Criteria:**
- `ChurnScoringService.score(contactId, businessId)` returns `{ score: number; risk: 'LOW'|'MEDIUM'|'HIGH'; factors: string[] }`
- Churn factors: days since last message, days since last purchase, sentiment trend, complaint count, order frequency drop
- Score 0-100: 0=loyal, 100=churned
- HIGH risk (>70) emits `client.churn.risk` event
- `client.churn.risk` triggers a campaign check: if matching re-engagement campaign exists, auto-enqueue
- Scheduled BullMQ job runs churn scoring nightly for all active contacts
- `GET /clients/at-risk` returns paginated list of high-risk contacts

**AI Agent Notes:**
- Score formula: weighted sum of factors. Days since last contact >30d = +30pts, >60d = +60pts. Negative sentiment = +20pts. Complaint count >2 = +15pts.
- Nightly job: BullMQ repeatable job with `{ pattern: '0 2 * * *' }` (2am IST)
- Store churn score in `ClientProfile.churnScore` and `churnScoredAt` — only update if >24h old

---

### GS-024 — Implement Catalog Service (Products & Services)
**Module:** catalog
**Priority:** P1
**Effort:** L

**Dependencies:** GS-008

**Acceptance Criteria:**
- `POST /catalog/products` creates a product with variants
- `GET /catalog/products` lists products with pagination, search, category filter
- `GET /catalog/products/:id` returns product detail with all variants
- `PATCH /catalog/products/:id` updates product (partial update)
- `DELETE /catalog/products/:id` soft-deletes (sets `isActive: false`)
- Product model fields: `name`, `description`, `sku`, `category`, `basePrice` (Decimal), `currency` (default INR), `images String[]`, `tags String[]`, `isActive`
- `ProductVariant` fields: `name`, `sku`, `price`, `stock`, `attributes Json` (size/color/etc.)
- `POST /catalog/services` creates a bookable service (name, duration, price, availability)
- On product create/update, auto-index to Qdrant via `RAGService.index()`
- `CatalogService.search(query, businessId)` uses both PostgreSQL FTS and Qdrant for hybrid search

**AI Agent Notes:**
- `basePrice` and variant prices stored as `Decimal` in Prisma (maps to `DECIMAL(10,2)` in Postgres)
- Currency defaults to `INR` — this is an Indian market product
- Images stored as URL array (S3 URLs); upload handled separately by media endpoint
- Hybrid search: PostgreSQL FTS for exact matches, Qdrant for semantic matches; merge and de-duplicate results ranked by relevance

---

### GS-025 — Implement Booking Service (Calendar + Scheduling)
**Module:** booking
**Priority:** P2
**Effort:** L

**Dependencies:** GS-024

**Acceptance Criteria:**
- `BookingService.getAvailability(serviceId, date, businessId)` returns available time slots
- `BookingService.create(dto)` creates a booking, blocks the slot
- `BookingService.cancel(bookingId, reason)` cancels and frees slot
- Availability computed from: service duration, business hours (from `Business.settings.businessHours`), existing bookings
- `POST /bookings` creates a booking
- `GET /bookings` lists bookings with filters (date range, status, serviceId)
- `GET /bookings/:id` returns booking detail
- Google Calendar sync: on booking create, creates a Google Calendar event (stub — OAuth flow TBD, use service account for now)
- Reminder jobs: BullMQ delayed job 24h and 1h before appointment emits `booking.reminder`
- `booking.reminder` event triggers WhatsApp reminder message to customer

**AI Agent Notes:**
- Business hours stored as: `{ mon: { open: '09:00', close: '18:00' }, tue: ..., sun: null }` — null means closed
- Slot duration is `Service.duration` in minutes
- Generate slots by iterating from open to close in duration-sized increments, filtering out booked slots
- Google Calendar: use `googleapis` npm package; for now use a dummy service account JSON from env `GOOGLE_SERVICE_ACCOUNT_JSON`

---

### GS-026 — Implement Payment Service (Razorpay)
**Module:** payment
**Priority:** P1
**Effort:** L

**Dependencies:** GS-008

**Acceptance Criteria:**
- `PaymentService.createLink(amount, contactId, orderId?, description)` creates a Razorpay payment link
- Returns `{ paymentLinkId, shortUrl, amount, currency, expiresAt }`
- `POST /webhooks/razorpay` handles Razorpay webhook events
- Webhook events handled: `payment_link.paid`, `payment.failed`, `refund.created`, `refund.processed`
- Webhook signature verified using Razorpay HMAC-SHA256
- On `payment_link.paid`: update `Payment` record, emit `payment.success`
- `PaymentService.initiateRefund(paymentId, amount?, reason)` calls Razorpay refund API
- `GET /payments` lists payments with filters (status, dateRange, contactId)
- `GET /payments/:id` returns payment with associated order and contact
- All payment amounts in smallest currency unit (paise); display layer converts to INR

**AI Agent Notes:**
- Use `razorpay` npm package (official Razorpay Node.js SDK)
- Razorpay credentials from env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
- Payment link expiry: 24 hours by default (configurable per business)
- Payment webhook must respond with 200 within 5 seconds — queue heavy processing via BullMQ
- Store `razorpayPaymentId` and `razorpayOrderId` on `Payment` model for reconciliation

---

### GS-027 — Build Razorpay Integration Tests
**Module:** payment
**Priority:** P2
**Effort:** M

**Dependencies:** GS-026

**Acceptance Criteria:**
- Test suite uses Razorpay test mode credentials (not mocked — real test API calls)
- Tests cover: create payment link, simulate payment success via webhook, check payment record updated
- Webhook signature generation tested with known test vectors
- Refund flow tested end-to-end in test mode
- All tests tagged `@integration` and excluded from unit test run
- `.env.test` documented with required Razorpay test keys

**AI Agent Notes:**
- Razorpay test mode: use `rzp_test_*` keys
- Use `supertest` for webhook endpoint tests
- Mock only the Razorpay API calls that cannot run in test mode (refund processing)

---

## Sprint 4 — Commerce Layer
**Weeks 7-8 | Goal: Full order lifecycle, shipping, payment flows working**

---

### GS-028 — Implement Order Service
**Module:** order
**Priority:** P1
**Effort:** L

**Dependencies:** GS-024

**Acceptance Criteria:**
- `OrderService.create(dto: CreateOrderDto)` creates order with items
- Order status machine: `PENDING_PAYMENT` → `CONFIRMED` → `PROCESSING` → `SHIPPED` → `DELIVERED` → `CANCELLED` / `REFUNDED`
- `OrderService.addItem(orderId, productId, variantId, quantity)` adds line items
- `OrderService.calculateTotal(orderId)` sums line items + tax (18% GST default) + shipping
- `POST /orders` creates a new order
- `GET /orders` lists orders with filters (status, contactId, dateRange)
- `GET /orders/:id` returns order with items, payment, shipment
- `PATCH /orders/:id/cancel` cancels order (only if PENDING_PAYMENT or CONFIRMED)
- On `order.created`: if COD order → move to CONFIRMED; if prepaid → create payment link via PaymentService
- On `payment.success` event: transition order to CONFIRMED
- Tax calculation: store tax breakdown in order (CGST 9% + SGST 9%)

**AI Agent Notes:**
- `CreateOrderDto`: `{ contactId, items: [{productId, variantId, quantity}], paymentMethod: 'PREPAID'|'COD', deliveryAddress: AddressDto }`
- Order number format: `GS-{YYYYMMDD}-{5-digit-sequence}` e.g. `GS-20241115-00001`
- Use a Postgres sequence for the numeric part: `CREATE SEQUENCE order_number_seq`
- Inventory check: call `CatalogService.checkStock(variantId, quantity)` before confirming order

---

### GS-029 — Implement Shipping Service
**Module:** shipping
**Priority:** P2
**Effort:** L

**Dependencies:** GS-028

**Acceptance Criteria:**
- `ShippingService.createShipment(orderId, dto)` creates a Shiprocket shipment
- Returns `{ shipmentId, awb, trackingUrl, estimatedDelivery }`
- `ShippingService.track(shipmentId)` returns current tracking status
- `POST /webhooks/shiprocket` handles Shiprocket webhook for status updates
- On tracking update: update `Shipment` record, emit `order.shipped` or `order.delivered`
- Delivery notification: on `order.delivered` emit → send WhatsApp "Your order has been delivered" message
- `GET /shipments/:orderId` returns shipment detail with tracking history
- Shiprocket integration: create order, generate AWB, fetch tracking

**AI Agent Notes:**
- Use Shiprocket REST API: base URL `https://apiv2.shiprocket.in/v1/external/`
- Auth: Shiprocket uses JWT — `POST /auth/login` with email/password, token valid 24h, auto-refresh
- Store Shiprocket token in Redis with TTL
- Tracking webhook from Shiprocket sends `awb_code`, `current_status`, `delivered_date`

---

### GS-030 — Build Shiprocket Integration Tests
**Module:** shipping
**Priority:** P3
**Effort:** M

**Dependencies:** GS-029

**Acceptance Criteria:**
- Shiprocket sandbox environment tests
- Tests: auth token generation, create shipment, fetch tracking
- Webhook handler tested with sample Shiprocket payloads
- Integration tests tagged `@integration`

**AI Agent Notes:**
- Use Shiprocket staging credentials from `.env.test`
- Mock Shiprocket AWB assignment (it requires physical pickup in real environment)

---

### GS-031 — Wire Order-Payment Integration
**Module:** order
**Priority:** P1
**Effort:** M

**Dependencies:** GS-026, GS-028

**Acceptance Criteria:**
- `payment.success` event handler in OrderModule transitions order `PENDING_PAYMENT` → `CONFIRMED`
- `payment.failed` event handler sends WhatsApp message with retry payment link
- Payment link embedded in WhatsApp message as clickable URL (use `PAYMENT_LINK` message content type)
- Order confirmation WhatsApp message sent on `order.paid` (order ID, items, total, delivery address)
- COD order confirmation sent immediately on `order.created` with order summary
- End-to-end test: create order → receive payment webhook → verify order status + customer notified

**AI Agent Notes:**
- Message templates: store order confirmation and payment templates in `Business.settings.messageTemplates`
- Use approved WhatsApp Business templates for order confirmation (these are pre-approved templates, not free-form)
- Payment link message must be sent within 30 seconds of order creation

---

### GS-032 — Wire Order-Shipping Integration
**Module:** order
**Priority:** P1
**Effort:** M

**Dependencies:** GS-029, GS-031

**Acceptance Criteria:**
- On `order.confirmed` (CONFIRMED status): auto-trigger `ShippingService.createShipment()` if business has Shiprocket configured
- On `order.shipped` event: send WhatsApp message with AWB number and tracking URL
- On `order.delivered` event: send delivery confirmation + request review message
- Tracking URL formatted as: `https://shiprocket.co/tracking/{awb}`
- Manual shipping override: `PATCH /orders/:id/mark-shipped` for businesses without Shiprocket

**AI Agent Notes:**
- Auto-trigger shipping is gated on `Business.settings.autoShipping === true`
- Review request sent 2 days after delivery (BullMQ delayed job)

---

## Sprint 5 — Campaigns & Lifecycle
**Weeks 9-10 | Goal: Campaign engine running, lifecycle automations active**

---

### GS-033 — Implement Campaign Service
**Module:** campaign
**Priority:** P2
**Effort:** L

**Dependencies:** GS-013

**Acceptance Criteria:**
- `CampaignService.create(dto)` creates a campaign with target audience and message template
- Campaign types: `BROADCAST` (one-time blast), `TRIGGERED` (event-based), `DRIP` (sequence)
- Target audience filters: all contacts, segment by tag, last purchase date range, churn risk level
- `CampaignService.schedule(campaignId, scheduledAt)` sets campaign send time
- `CampaignService.preview(campaignId)` returns estimated audience size and sample message
- `POST /campaigns` creates campaign
- `GET /campaigns` lists campaigns with status
- `POST /campaigns/:id/activate` activates scheduled or triggered campaign
- `POST /campaigns/:id/pause` pauses active campaign
- Campaign sends via WhatsApp Business templates only (no free-form for broadcast)
- Rate limiting: max 50 messages/minute per business (WhatsApp policy)

**AI Agent Notes:**
- Use BullMQ rate-limited queue for campaign sends: `{ limiter: { max: 50, duration: 60000 } }`
- `CampaignMessage` table tracks: `campaignId`, `contactId`, `status` (QUEUED/SENT/FAILED/DELIVERED), `sentAt`
- Audience query built dynamically using Prisma `where` clauses from filter criteria
- Drip campaigns: each step is a separate `CampaignStep` with `delayMinutes` from previous step

---

### GS-034 — Implement Campaign Scheduler (BullMQ)
**Module:** campaign
**Priority:** P2
**Effort:** M

**Dependencies:** GS-033

**Acceptance Criteria:**
- Scheduled campaigns use BullMQ delayed jobs: job enqueued at creation with delay until `scheduledAt`
- `CampaignWorker` processes jobs: loads audience, splits into chunks of 50, enqueues per-message jobs
- Per-message jobs: `SendCampaignMessageJob` calls `OutboundRouter.send()` with template
- Delivery receipts update `CampaignMessage.status` via WhatsApp webhook
- `GET /campaigns/:id/stats` returns: total sent, delivered, failed, delivery rate %
- Failed sends retried once after 5 minutes; marked FAILED permanently after 2 attempts

**AI Agent Notes:**
- Chunk audience into batches of 50 to avoid memory pressure on large campaigns
- Each chunk spawns child BullMQ jobs with `parent` reference for job grouping
- Campaign stats computed from `CampaignMessage` aggregates (not real-time; cached 5 min)

---

### GS-035 — Implement Lifecycle Trigger Automations
**Module:** campaign
**Priority:** P2
**Effort:** M

**Dependencies:** GS-033, GS-023

**Acceptance Criteria:**
- Lifecycle triggers fire campaigns automatically based on events:
  - `client.churn.risk` → fire re-engagement campaign if one matches
  - `booking.reminder` → send appointment reminder via WhatsApp
  - `order.delivered` → send review request (2 day delay)
  - `payment.failed` → send retry payment link immediately
  - New contact first message → send welcome message
- `LifecycleTriggerService.register(trigger)` registers a trigger definition
- Trigger definition: `{ event, conditions, campaignId | templateMessage, delay? }`
- Businesses configure triggers via `POST /lifecycle/triggers`
- Default triggers pre-configured for all businesses (can be disabled)

**AI Agent Notes:**
- Lifecycle triggers stored in DB: `LifecycleTrigger` model with `event`, `conditions Json`, `action Json`, `isActive`, `businessId`
- Event handler: `@OnEvent('*')` with event name matching against registered triggers
- Conditions evaluation: simple JSON path conditions e.g. `{ field: 'churnScore', op: 'gt', value: 70 }`

---

## Sprint 6 — Dashboard & Analytics
**Weeks 11-12 | Goal: Full Next.js dashboard operational with real-time updates**

---

### GS-036 — Build Next.js Dashboard Shell
**Module:** dashboard
**Priority:** P1
**Effort:** L

**Dependencies:** GS-009

**Acceptance Criteria:**
- Next.js 14 app with App Router at `apps/dashboard`
- Authentication: NextAuth.js or custom JWT cookie flow calling `/auth/login`
- Layout: sidebar navigation (Conversations, Tasks, Catalog, Orders, Campaigns, Analytics, Settings)
- Sidebar shows unread conversation count and pending task count (real-time badges)
- Responsive: works on desktop (primary) and tablet
- Dark mode support via Tailwind CSS `dark:` classes
- Loading states and error boundaries on all routes
- `GET /health` API route returns dashboard build info
- Deployed at port 3001 in Docker Compose

**AI Agent Notes:**
- Use Tailwind CSS + shadcn/ui component library
- API calls from dashboard use `fetch` with base URL from `NEXT_PUBLIC_API_URL` env var
- Auth token stored in httpOnly cookie (not localStorage)
- Use `nuqs` for URL state management (filters, pagination params)
- Icon library: `lucide-react`

---

### GS-037 — Build Conversation Management UI
**Module:** dashboard
**Priority:** P1
**Effort:** L

**Dependencies:** GS-036, GS-012

**Acceptance Criteria:**
- `/conversations` page: list of conversations with last message preview, contact name, channel icon, status badge
- Conversation list filterable by: status, channel, assignee, date range
- Click conversation → opens detail panel with full message thread
- Message thread renders all content types: text, image thumbnails, document links, location maps
- Reply box at bottom: type and send message directly from dashboard
- `POST /conversations/:id/messages` sends outbound message via channel adapter
- Assign conversation to staff member via dropdown
- Resolve/reopen conversation button
- Show AI decision badge on AI-generated messages (intent, confidence %)
- "Take over" button: staff can disable AI for this conversation and respond manually

**AI Agent Notes:**
- Message thread: virtualized list (use `@tanstack/react-virtual`) for conversations with many messages
- Channel icon: use simple SVG icons for WhatsApp (green), Instagram (purple), SMS (blue), Email (gray)
- Reply box should show character count for SMS channel (160 char limit warning)
- "Take over" sets `Conversation.aiDisabled = true` — AI skips processing for this conversation

---

### GS-038 — Build Analytics Dashboard
**Module:** dashboard
**Priority:** P2
**Effort:** L

**Dependencies:** GS-036, GS-041

**Acceptance Criteria:**
- `/analytics` page with date range picker (today, 7d, 30d, 90d, custom)
- KPI cards: Total conversations, Avg response time, AI autonomy %, HITL tasks resolved, Revenue (INR)
- Charts (use Recharts):
  - Conversations over time (line chart)
  - Channel distribution (pie chart)
  - Intent breakdown (horizontal bar chart)
  - AI confidence distribution (histogram)
  - Revenue over time (area chart)
- All charts filterable by date range
- Export to CSV button for raw data

**AI Agent Notes:**
- Use `recharts` for all charts
- AI autonomy % = (auto-executed / total processed) × 100
- Charts should show loading skeletons while data fetches
- Date range stored in URL params for shareable links

---

### GS-039 — Build HITL Task Dashboard
**Module:** dashboard
**Priority:** P1
**Effort:** L

**Dependencies:** GS-036, GS-020

**Acceptance Criteria:**
- `/tasks` page: list of pending HITL tasks sorted by SLA deadline (most urgent first)
- Task card shows: conversation preview, AI draft response, confidence score, intent, time until SLA
- Actions on task card: Approve, Edit & Send, Reject, Reassign
- Edit & Send: opens edit modal with AI draft pre-filled, staff edits and sends
- SLA countdown timer shown in red when < 1 hour remaining
- Real-time updates: new tasks appear without page refresh (Socket.IO)
- Filters: type (REVIEW_DRAFT, ESCALATION), status, assignee, SLA status
- Task detail modal shows full conversation history for context

**AI Agent Notes:**
- SLA countdown: use `setInterval` updating every minute; switch to seconds in final hour
- Socket.IO event: `task.created` pushes to all staff in the business's room
- Approve action: `PATCH /tasks/:id/resolve` with `{ action: 'APPROVE' }`

---

### GS-040 — Implement Socket.IO Real-Time Gateway
**Module:** hitl / dashboard
**Priority:** P1
**Effort:** M

**Dependencies:** GS-020

**Acceptance Criteria:**
- NestJS `@WebSocketGateway()` using Socket.IO
- Clients authenticate via JWT token passed in socket handshake `auth.token`
- On connection: join room `business:{businessId}` and `user:{userId}`
- Events pushed to `business:{businessId}` room:
  - `conversation.new` — new conversation created
  - `message.new` — new message in any conversation
  - `task.new` — new HITL task created
  - `task.updated` — task status changed
  - `conversation.resolved` — conversation closed
- Typing indicator: `conversation.typing.start` and `conversation.typing.stop` from staff
- Frontend connects via `socket.io-client`, reconnects automatically on disconnect
- Connection count metric tracked in Redis

**AI Agent Notes:**
- Use `@nestjs/websockets` and `socket.io`
- Redis adapter for Socket.IO (`@socket.io/redis-adapter`) to support multi-pod in production
- Typing indicators have 3s timeout: if no `typing.stop` received, auto-clear
- Broadcast limit: max 100 events/second per business room

---

### GS-041 — Implement Analytics Service
**Module:** analytics
**Priority:** P2
**Effort:** L

**Dependencies:** GS-014

**Acceptance Criteria:**
- `AnalyticsService.getConversationMetrics(businessId, dateRange)` returns conversation KPIs
- `AnalyticsService.getAIMetrics(businessId, dateRange)` returns AI performance KPIs
- `AnalyticsService.getRevenueMetrics(businessId, dateRange)` returns revenue KPIs
- Metrics computed from existing tables (no separate analytics DB in MVP)
- `GET /analytics/overview` returns all KPIs for dashboard
- `GET /analytics/conversations` returns time-series conversation data
- `GET /analytics/ai-performance` returns intent breakdown, confidence distribution, autonomy rate
- `GET /analytics/revenue` returns revenue time-series, top products, top customers
- All endpoints cached in Redis for 5 minutes (cache busted on significant events)

**AI Agent Notes:**
- Use Prisma aggregations (`groupBy`, `aggregate`, `count`) for metrics
- Conversation metrics: total, by channel, by status, avg duration, avg response time
- AI metrics: total processed, auto-executed count, HITL count, avg confidence, intent distribution
- Revenue: sum of `Payment.amount` where status=SUCCESS, grouped by date

---

### GS-042 — Build Autonomy KPI Tracking
**Module:** analytics
**Priority:** P2
**Effort:** M

**Dependencies:** GS-041

**Acceptance Criteria:**
- `AutonomyKPIService.calculate(businessId, period)` returns:
  - `autonomyRate`: % of messages handled without human intervention
  - `avgConfidence`: mean confidence score across all AI decisions
  - `hitlRate`: % requiring human review
  - `escalationRate`: % fully escalated
  - `overrideRate`: % where human overrode AI
- KPIs stored daily in `AnalyticsSnapshot` table for historical trending
- Nightly job computes and stores KPIs for all businesses
- `GET /analytics/autonomy` returns current + 30-day trend
- Target benchmarks stored in config: autonomy rate target 80%+

**AI Agent Notes:**
- `AnalyticsSnapshot` model: `{ businessId, date Date @unique, metrics Json }`
- Nightly job: BullMQ repeatable `{ pattern: '0 3 * * *' }` (3am IST)
- If autonomy rate drops below 60% for 3 consecutive days, emit alert event

---

### GS-043 — Build Admin Module (GoSumo Internal)
**Module:** admin
**Priority:** P3
**Effort:** M

**Dependencies:** GS-007

**Acceptance Criteria:**
- `/admin` routes require `GOSUMO_ADMIN` role (separate from business roles)
- `GET /admin/businesses` lists all businesses with KPIs
- `GET /admin/businesses/:id` returns full business profile + usage stats
- `POST /admin/businesses/:id/suspend` suspends a business (all API calls return 402)
- `GET /admin/health` returns system health: DB connections, Redis, Qdrant, queue lengths
- `GET /admin/queues` returns BullMQ queue stats for all queues
- Admin auth: separate JWT with `role: GOSUMO_ADMIN` claim, issued via separate endpoint
- All admin actions logged to append-only `AdminAuditLog` table

**AI Agent Notes:**
- Admin role stored in `User.systemRole` (separate from per-business `UserBusinessMember.role`)
- Suspend: set `Business.isActive = false`; middleware checks this on every request
- Admin endpoints are a separate controller with its own guard: `AdminGuard`

---

## Sprint 7 — Testing, Security & Beta Prep
**Weeks 13-15 | Goal: Production-ready, security-hardened, beta customers onboarded**

---

### GS-044 — Write E2E Test Suite (Happy Path)
**Module:** Testing
**Priority:** P1
**Effort:** L

**Dependencies:** GS-031, GS-039

**Acceptance Criteria:**
- E2E test framework: Jest + Supertest against running Docker Compose stack
- Happy path scenarios covered:
  1. Customer sends WhatsApp message → AI responds automatically (high confidence)
  2. Customer sends ambiguous message → HITL task created → staff approves → response sent
  3. Customer places order via AI → payment link sent → payment confirmed → order confirmed
  4. Customer books appointment → confirmation sent → reminder sent 24h before
  5. Campaign created → scheduled → sent to audience → delivery tracked
- Each scenario asserted end-to-end: input event → DB state → outbound message
- Tests run in isolated database (separate schema per test run)
- `pnpm test:e2e` runs the full suite

**AI Agent Notes:**
- Use `@testcontainers/postgresql` and `@testcontainers/redis` for isolated test databases
- WhatsApp webhook calls mocked via `nock` (intercept Axios calls to Meta Graph API)
- Qdrant: use a test collection prefix `test_{runId}_`
- Test data factories: use `@faker-js/faker` with `faker.setLocale('en_IN')` for realistic Indian data

---

### GS-045 — Write Unit Tests for Core Modules
**Module:** Testing
**Priority:** P1
**Effort:** L

**Dependencies:** All core modules

**Acceptance Criteria:**
- Unit test coverage ≥ 80% for: ai-engine, channel-adapter, conversation, payment, order
- Test each service method independently with mocked dependencies
- AI engine tests use recorded Claude API responses (cassettes) via `nock`
- Confidence calculator tested with all 5 hard override scenarios
- Confidence router tested for all three routing paths
- WhatsApp adapter tested with real webhook payload fixtures (saved from Meta documentation)
- `pnpm test:unit` runs in < 60 seconds

**AI Agent Notes:**
- Use NestJS testing utilities: `Test.createTestingModule()`
- Mock Prisma using `jest-mock-extended` for the PrismaService
- Store API response cassettes in `test/fixtures/` directory
- Mock Anthropic SDK: `jest.mock('@anthropic-ai/sdk')` with realistic response shapes

---

### GS-046 — Security Audit and Hardening
**Module:** Security
**Priority:** P0
**Effort:** L

**Dependencies:** GS-045

**Acceptance Criteria:**
- All webhook endpoints verify HMAC signatures (WhatsApp, Razorpay, Shiprocket)
- SQL injection: verified Prisma parameterizes all queries (no raw SQL with user input)
- JWT secret minimum 256 bits (32 bytes random)
- Rate limiting: `@nestjs/throttler` applied globally (100 req/min default, 10/min for auth routes)
- CORS: only dashboard origin allowed for non-webhook routes
- Helmet.js applied (CSP, HSTS, X-Frame-Options)
- PII masking: phone numbers and emails masked in application logs
- All dependency vulnerabilities resolved: `pnpm audit --audit-level=high` passes
- PostgreSQL RLS policies verified with integration test: business A cannot read business B's data
- `SECURITY.md` documents all security controls

**AI Agent Notes:**
- Use `@nestjs/throttler` with Redis store for distributed rate limiting across pods
- PII masking in logs: custom NestJS logger interceptor that redacts phone/email patterns
- RLS test: create two businesses, insert data as business A, attempt to query as business B via raw SQL with wrong `app.current_business_id`
- CORS origins: `process.env.DASHBOARD_URL` (default `http://localhost:3001`)

---

### GS-047 — Performance Optimization Pass
**Module:** Infrastructure
**Priority:** P1
**Effort:** L

**Dependencies:** GS-044

**Acceptance Criteria:**
- API response time p95 < 200ms for all non-AI endpoints (measured with k6)
- AI processing time < 4 seconds p95 (message received → response generated)
- Dashboard initial page load < 2 seconds (Lighthouse score)
- DB query optimization: all slow queries (>100ms) identified and indexed
- `EXPLAIN ANALYZE` run on all critical queries; no sequential scans on large tables
- Redis hit rate > 80% for conversation context and client profiles
- k6 load test: 100 concurrent users, 10 min duration, < 1% error rate
- Memory usage: API pod < 512MB under load

**AI Agent Notes:**
- k6 test script at `test/performance/load.js`
- Critical indexes to verify: `messages(conversationId, createdAt)`, `conversations(businessId, status)`, `orders(businessId, status, createdAt)`, `payments(businessId, status)`
- Redis caching audit: add cache-miss logging to identify uncached hot paths
- Next.js bundle analysis: `pnpm --filter dashboard analyze` to find large dependencies

---

### GS-048 — Implement Observability Stack
**Module:** Infrastructure
**Priority:** P2
**Effort:** M

**Dependencies:** GS-003

**Acceptance Criteria:**
- Sentry integrated in both API (`@sentry/node`) and Dashboard (`@sentry/nextjs`)
- All unhandled exceptions captured with full context (businessId, userId, requestId)
- Custom Sentry tags: `business_id`, `channel`, `intent`, `confidence`
- Structured logging: `pino` logger with JSON output, log level configurable via env
- Request ID middleware: generates UUID per request, adds to all logs and response headers
- Datadog APM traces for: API request lifecycle, AI pipeline stages, DB queries, Redis ops
- Custom metrics: `ai.processing.duration`, `ai.confidence.score`, `hitl.task.sla_remaining`
- `GET /health` returns: `{ status: 'ok', version, uptime, db: 'connected', redis: 'connected', qdrant: 'connected' }`

**AI Agent Notes:**
- Use `pino` + `pino-pretty` (dev) + `pino-http` for HTTP request logging
- Sentry DSN from env: `SENTRY_DSN`
- Add `requestId` to every Prisma query via middleware: `prisma.$use((params, next) => { ... })`
- Datadog agent: add to Docker Compose as `datadog-agent` service

---

### GS-049 — Build Beta Onboarding Flow
**Module:** tenant
**Priority:** P1
**Effort:** M

**Dependencies:** GS-007, GS-036

**Acceptance Criteria:**
- New business registration wizard in dashboard (4 steps):
  1. Business profile (name, phone, category, GST number optional)
  2. WhatsApp Business API setup (phone number ID, access token, webhook URL displayed)
  3. Catalog setup (upload products via CSV or manual entry, minimum 1 product)
  4. AI configuration (confidence thresholds, language preference, holding message text)
- CSV import for products: parse CSV, validate fields, bulk insert via `CatalogService`
- Webhook URL displayed with copy button: `https://api.gosumo.in/webhooks/whatsapp`
- Completion triggers welcome email (stub — log to console in MVP)
- Onboarding progress stored in `Business.settings.onboardingStep`
- Can skip to any step (steps are independent)

**AI Agent Notes:**
- CSV product format: `name,description,sku,price,category,stock`
- Max CSV file size: 5MB, max 1000 products per import
- Use `papaparse` for CSV parsing in the browser (client-side validation before upload)
- Webhook setup step shows QR code for WhatsApp channel link (future feature — show placeholder)

---

### GS-050 — Write CLAUDE.md Files for All Modules
**Module:** Documentation
**Priority:** P2
**Effort:** M

**Dependencies:** All modules

**Acceptance Criteria:**
- `CLAUDE.md` created in each module directory (16 total)
- Each CLAUDE.md is ≤ 150 lines and covers:
  - Module purpose (2-3 sentences)
  - Public API (exported services and their key methods)
  - Key dependencies (what this module imports from others)
  - Domain events emitted and consumed
  - Test command (`pnpm test --filter @gosumo/module-name`)
  - Common gotchas / important conventions
- Root `CLAUDE.md` updated with monorepo navigation guide
- `apps/api/CLAUDE.md` covers NestJS conventions used in this project
- `apps/dashboard/CLAUDE.md` covers Next.js conventions and component patterns

**AI Agent Notes:**
- CLAUDE.md is for AI agent context, not end-user documentation — keep it dense and technical
- Focus on what an AI agent needs to know to make changes without breaking contracts
- Include example usage of the module's main service in code snippets
- List the Prisma models the module owns

---

### GS-051 — Configure Production Kubernetes Manifests
**Module:** Infrastructure
**Priority:** P3
**Effort:** L

**Dependencies:** GS-046, GS-047

**Acceptance Criteria:**
- `k8s/` directory with Helm chart or raw manifests
- Deployments: `api`, `worker-ai`, `worker-campaign`, `worker-analytics`, `dashboard`
- API deployment: 2 replicas min, HPA up to 10 pods (CPU 70% threshold)
- ConfigMap for non-secret env vars, Secrets for sensitive values
- Liveness probe: `GET /health` (10s period)
- Readiness probe: `GET /health` (5s period, 3 failures)
- Resource requests/limits: API pod `requests: {cpu: 250m, memory: 256Mi}`, `limits: {cpu: 1000m, memory: 512Mi}`
- Ingress with TLS termination (cert-manager Let's Encrypt)
- `pnpm k8s:deploy` applies manifests to current kubectl context

**AI Agent Notes:**
- Use `kustomize` base + overlays (staging, production)
- Worker pods: no HPA — fixed 1 replica per worker type (scale manually based on queue depth)
- PodDisruptionBudget: min 1 API pod always available during node drain

---

### GS-052 — Beta Launch Smoke Tests
**Module:** Testing
**Priority:** P0
**Effort:** M

**Dependencies:** GS-049, GS-051

**Acceptance Criteria:**
- Smoke test checklist that runs against production environment
- Tests: register business → setup WhatsApp → send test WhatsApp message → verify AI response received
- Automated smoke test script in `scripts/smoke-test.sh`
- All smoke tests pass in < 5 minutes
- Monitoring alerts configured: uptime check every 60s, alert if API down for >2 min
- Rollback plan documented: `scripts/rollback.sh` reverts to previous Docker image
- Beta access: 5 pilot businesses onboarded manually, credentials documented in 1Password (not in code)

**AI Agent Notes:**
- Smoke test uses `curl` commands with environment variables for base URL and test credentials
- Alert via Sentry uptime monitoring or UptimeRobot (free tier)
- Rollback: `kubectl rollout undo deployment/api --to-revision=N`

---

## Backlog (Post-Beta)

These tickets are defined but deferred to post-beta. Reference IDs reserved for future sprints.

| ID | Title | Module | Notes |
|---|---|---|---|
| GS-053 | Instagram DM Channel Adapter | channel-adapter | Same interface as WhatsApp; different webhook format |
| GS-054 | SMS Channel Adapter (Twilio) | channel-adapter | For fallback when WhatsApp unavailable |
| GS-055 | Web Chat Widget (Embeddable) | channel-adapter | React widget + WebSocket connection |
| GS-056 | Email Channel Adapter (IMAP/SMTP) | channel-adapter | Nodemailer + IMAP polling |
| GS-057 | Google Calendar OAuth Flow | booking | Replace service account with per-business OAuth |
| GS-058 | Inventory Management Service | catalog | Stock tracking, low-stock alerts, reorder triggers |
| GS-059 | Multi-language AI Responses | ai-engine | Hindi, Tamil, Telugu in addition to English |
| GS-060 | Customer-Facing WhatsApp Bot Menu | channel-adapter | Interactive list menus for self-service |
| GS-061 | PDF Invoice Generation | order | Automated invoice on order confirmation |
| GS-062 | Bulk Order Import (CSV) | order | For businesses migrating existing orders |
| GS-063 | Advanced Analytics (cohort, LTV) | analytics | Cohort analysis, LTV prediction |
| GS-064 | Stripe Integration (International) | payment | For non-India customers |
| GS-065 | Mobile Dashboard (React Native) | dashboard | Staff management on mobile |
| GS-066 | Franchise / Multi-location Support | tenant | One business, multiple outlet locations |
| GS-067 | AI Model Fine-tuning Pipeline | ai-engine | Fine-tune on business-specific historical data |
| GS-068 | WhatsApp Catalog Integration | channel-adapter | Native WhatsApp catalog for product browsing |

---

## Sprint Summary

| Sprint | Weeks | Tickets | Goal |
|---|---|---|---|
| Sprint 0 | 1 | GS-001 to GS-005 | Monorepo + infra foundation |
| Sprint 1 | 1-2 | GS-006 to GS-014 | Auth, tenant, WhatsApp, event bus |
| Sprint 2 | 3-4 | GS-015 to GS-021 | AI engine, HITL queue |
| Sprint 3 | 5-6 | GS-022 to GS-027 | Client intelligence, catalog, payments |
| Sprint 4 | 7-8 | GS-028 to GS-032 | Orders, shipping, integrations |
| Sprint 5 | 9-10 | GS-033 to GS-035 | Campaign engine, lifecycle |
| Sprint 6 | 11-12 | GS-036 to GS-043 | Dashboard, analytics, admin |
| Sprint 7 | 13-15 | GS-044 to GS-052 | Testing, security, beta launch |

**Total tickets: 52 core + 16 backlog = 68 tickets**

---

## Agent Execution Tips

1. **Always read the module's CLAUDE.md first** (once created in GS-050) before starting a ticket in that module.
2. **Check dependencies**: if a dependent ticket is not complete, stop and report — do not guess at the interface.
3. **Run tests before marking done**: `pnpm test --filter @gosumo/<module>` must pass.
4. **Type errors = blocking**: TypeScript strict mode is enforced. Fix type errors, do not use `any`.
5. **Emit events, don't call across modules directly**: if your module needs to trigger behavior in another module, emit a domain event. Only use direct service injection for synchronous read queries.
6. **Tenant-scope every DB query**: every query against a tenant-scoped table must have a `businessId` filter. This is not optional.
7. **Never log PII**: phone numbers, email addresses, and message content must not appear in logs. Use the `maskPII()` utility from `@gosumo/shared`.
