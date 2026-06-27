# GoSumo — System Architecture

> AI-powered client management platform for small businesses in emerging markets.
> **Design Principle:** Channel-agnostic, AI-agent-developed, event-driven, multi-tenant.

---

## 1. Architecture Overview

GoSumo is a **channel-agnostic AI operating layer** where customers communicate through any messaging channel, AI reasons and decides, connected systems execute actions, and humans intervene only when required.

### Core Processing Loop

```
Message In → Channel Adapter → Normalize → Event Bus → AI Pipeline → Route → Execute → Message Out
```

Every incoming message flows through the same pipeline regardless of source channel (WhatsApp, Instagram DM, SMS, Web Chat, Email). The system uses an **event-driven architecture** where each stage emits domain events consumed by downstream processors.

### Key Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Monorepo tool | Turborepo + pnpm | Fast builds, caching, simpler than Nx for this scale |
| Backend framework | NestJS (TypeScript strict) | Module system maps 1:1 to domain boundaries, built-in DI, guards, interceptors |
| Primary DB | PostgreSQL 16 | JSONB for flexible schemas, row-level security for multi-tenancy, mature ecosystem |
| Cache / Queue broker | Redis 7 | BullMQ job queues, session cache, pub/sub for real-time |
| Vector store | Qdrant | Self-hostable, fast, good filtering for RAG |
| AI provider | Anthropic Claude (primary) | Best reasoning for complex business decisions |
| Frontend | Next.js 14 + React | SSR for dashboard, API routes for BFF |
| Real-time | Socket.IO | Dashboard live updates, typing indicators |
| Container orchestration | Docker Compose (dev), K8s (prod) | Local simplicity, production scalability |

---

## 2. High-Level System Diagram

```mermaid
graph TB
    subgraph Channels["Channel Layer"]
        WA[WhatsApp Business API]
        IG[Instagram DM API]
        SMS[SMS Gateway]
        WEB[Web Chat Widget]
        EMAIL[Email SMTP/IMAP]
    end

    subgraph Gateway["API Gateway"]
        WEBHOOK[Webhook Receiver]
        REST[REST API]
        WS[WebSocket Server]
    end

    subgraph Core["Core Services"]
        CA[Channel Adapter]
        EB[Event Bus]
        MP[Message Processor]
        AI[AI Engine]
        RE[Routing Engine]
        AE[Action Executor]
        SM[State Manager]
    end

    subgraph Intelligence["Intelligence Layer"]
        CC[Confidence Calculator]
        IC[Intent Classifier]
        RAG[RAG Pipeline]
        PE[Prompt Engine]
        CL[Client Intelligence]
    end

    subgraph Business["Business Logic"]
        CAT[Catalog Service]
        BK[Booking Service]
        PAY[Payment Service]
        SHP[Shipping Service]
        CMP[Campaign Service]
        INV[Inventory Service]
    end

    subgraph Human["Human-in-the-Loop"]
        TQ[Task Queue]
        IC2[Internal Chat]
        ESC[Escalation Manager]
    end

    subgraph Data["Data Layer"]
        PG[(PostgreSQL)]
        RD[(Redis)]
        VDB[(Qdrant Vector DB)]
        S3[(Object Storage)]
    end

    subgraph External["External Integrations"]
        GCAL[Google Calendar]
        RAZR[Razorpay]
        SHIP[Shiprocket/Logistics]
        META[Meta APIs]
    end

    WA & IG & SMS & WEB & EMAIL --> WEBHOOK
    WEBHOOK --> CA
    CA --> EB
    EB --> MP
    MP --> AI
    AI --> IC & CC & RAG & PE
    AI --> RE
    RE -->|Auto-execute| AE
    RE -->|Needs review| TQ
    TQ --> IC2
    IC2 --> AE
    AE --> SM
    AE --> CA
    CA --> WA & IG & SMS & WEB & EMAIL

    AI --> CL
    CL --> PG & VDB

    CAT & BK & PAY & SHP & CMP & INV --> PG
    BK --> GCAL
    PAY --> RAZR
    SHP --> SHIP

    REST --> Core
    WS --> Core
    SM --> PG & RD
    RAG --> VDB
```

---

## 3. Module Boundary Map

The system is organized into **13 bounded modules**, each independently deployable and testable. Every module has a single owner, clear public interface, and its own CLAUDE.md for AI agent context.

```mermaid
graph LR
    subgraph Platform["Platform Layer"]
        AUTH[auth]
        TENANT[tenant]
        CONFIG[config]
    end

    subgraph Messaging["Messaging Layer"]
        CHANNEL[channel-adapter]
        CONV[conversation]
        MSG[message]
    end

    subgraph Intelligence["Intelligence Layer"]
        AIENG[ai-engine]
        CLIENTI[client-intelligence]
    end

    subgraph Commerce["Commerce Layer"]
        CATALOG[catalog]
        BOOKING[booking]
        PAYMENT[payment]
        SHIPPING[shipping]
        ORDER[order]
    end

    subgraph Engagement["Engagement Layer"]
        CAMPAIGN[campaign]
        LIFECYCLE[lifecycle]
    end

    subgraph Operations["Operations Layer"]
        HITL[human-in-the-loop]
        ANALYTICS[analytics]
        ADMIN[admin]
    end

    CHANNEL --> CONV
    CONV --> MSG
    MSG --> AIENG
    AIENG --> CLIENTI
    AIENG --> HITL
    AIENG --> CATALOG & BOOKING & PAYMENT & ORDER
    HITL --> CONV
    CAMPAIGN --> MSG
    LIFECYCLE --> CAMPAIGN
    ORDER --> PAYMENT & SHIPPING & CATALOG
    BOOKING --> CATALOG
```

### Module Dependency Rules

1. **No circular dependencies.** If module A imports from B, B cannot import from A.
2. **Shared types live in `@gosumo/shared`.** DTOs, events, enums, and interfaces shared across modules.
3. **Each module exposes only its public API** via an `index.ts` barrel export.
4. **Cross-module communication** uses the Event Bus (domain events) for async flows and direct service injection for sync queries.
5. **Database access** is scoped per module — each module owns its tables and exposes data via service methods, never raw queries.

---

## 4. Module Inventory

| Module | Package | Responsibility | Key Dependencies |
|---|---|---|---|
| `channel-adapter` | `@gosumo/channel-adapter` | Normalize inbound/outbound messages across all channels | Redis, channel SDKs |
| `conversation` | `@gosumo/conversation` | Manage conversation lifecycle, state machine | PostgreSQL, Redis |
| `message` | `@gosumo/message` | Store, retrieve, search messages | PostgreSQL |
| `ai-engine` | `@gosumo/ai-engine` | Intent classification, confidence scoring, response generation | Anthropic SDK, Qdrant, Redis |
| `client-intelligence` | `@gosumo/client-intelligence` | Profile building, sentiment, churn scoring, LTV | PostgreSQL, Qdrant |
| `catalog` | `@gosumo/catalog` | Products, services, variants, pricing | PostgreSQL |
| `booking` | `@gosumo/booking` | Appointment scheduling, calendar sync | PostgreSQL, Google Calendar API |
| `payment` | `@gosumo/payment` | Payment links, webhooks, refunds, COD | Razorpay SDK, PostgreSQL |
| `order` | `@gosumo/order` | Order lifecycle, fulfillment coordination | PostgreSQL |
| `shipping` | `@gosumo/shipping` | Logistics provider abstraction, tracking | Shiprocket SDK, PostgreSQL |
| `campaign` | `@gosumo/campaign` | Promotional messaging, lifecycle campaigns | BullMQ, PostgreSQL |
| `human-in-the-loop` | `@gosumo/hitl` | Task queue, escalation, internal chat, approval workflows | PostgreSQL, Redis, Socket.IO |
| `auth` | `@gosumo/auth` | Authentication, RBAC, JWT, 2FA | PostgreSQL, Redis |
| `tenant` | `@gosumo/tenant` | Business profile, onboarding, settings | PostgreSQL |
| `analytics` | `@gosumo/analytics` | Metrics, reporting, autonomy KPIs | PostgreSQL, Redis |
| `admin` | `@gosumo/admin` | GoSumo internal admin dashboard backend | PostgreSQL |
| `shared` | `@gosumo/shared` | DTOs, events, enums, interfaces, utilities | None |

---

## 5. Channel Adapter Architecture

The Channel Adapter is the cornerstone of GoSumo's platform-agnostic design. It translates between channel-specific protocols and GoSumo's internal normalized message format.

```mermaid
graph TB
    subgraph Adapters["Channel Adapters"]
        WAA[WhatsApp Adapter]
        IGA[Instagram Adapter]
        SMSA[SMS Adapter]
        WEBA[Web Chat Adapter]
        EMAILA[Email Adapter]
    end

    subgraph Core["Channel Adapter Core"]
        NRM[Message Normalizer]
        VAL[Webhook Validator]
        OUT[Outbound Router]
        REG[Channel Registry]
    end

    subgraph Internal["Internal Format"]
        NM[NormalizedMessage]
        NC[NormalizedChannel]
    end

    WAA -->|Inbound| VAL
    IGA -->|Inbound| VAL
    SMSA -->|Inbound| VAL
    WEBA -->|Inbound| VAL
    EMAILA -->|Inbound| VAL

    VAL --> NRM
    NRM --> NM
    NM -->|"Event: message.received"| EB[Event Bus]

    EB -->|"Event: message.send"| OUT
    OUT --> REG
    REG --> WAA & IGA & SMSA & WEBA & EMAILA
```

### Normalized Message Interface

```typescript
interface NormalizedMessage {
  id: string;                          // GoSumo internal ID
  externalId: string;                  // Channel-specific message ID
  channel: ChannelType;                // WHATSAPP | INSTAGRAM | SMS | WEB_CHAT | EMAIL
  channelAccountId: string;            // Business's account on that channel
  direction: 'INBOUND' | 'OUTBOUND';
  sender: {
    externalId: string;                // Phone number, IG user ID, email, etc.
    displayName?: string;
  };
  content: MessageContent;             // Polymorphic content
  timestamp: Date;
  metadata: Record<string, unknown>;   // Channel-specific extras
}

type MessageContent =
  | { type: 'TEXT'; text: string }
  | { type: 'IMAGE'; url: string; caption?: string; mimeType: string }
  | { type: 'DOCUMENT'; url: string; filename: string; mimeType: string }
  | { type: 'LOCATION'; latitude: number; longitude: number; name?: string }
  | { type: 'INTERACTIVE'; interactiveType: string; payload: Record<string, unknown> }
  | { type: 'PAYMENT_LINK'; url: string; amount: number; currency: string }
  | { type: 'TEMPLATE'; templateName: string; parameters: Record<string, string> };
```

### Adding a New Channel

Adding a new channel requires implementing one interface:

```typescript
interface ChannelAdapter {
  readonly channelType: ChannelType;

  // Webhook handling
  validateWebhook(req: RawRequest): boolean;
  parseInbound(req: RawRequest): NormalizedMessage;

  // Outbound
  sendMessage(message: OutboundMessage): Promise<SendResult>;
  sendTemplate(template: TemplateMessage): Promise<SendResult>;
  sendInteractive(interactive: InteractiveMessage): Promise<SendResult>;

  // Channel capabilities
  getCapabilities(): ChannelCapabilities;

  // Media
  downloadMedia(mediaId: string): Promise<Buffer>;
  uploadMedia(buffer: Buffer, mimeType: string): Promise<string>;
}
```

---

## 6. Event-Driven Architecture

### Domain Events

All cross-module communication uses typed domain events published to the internal event bus (NestJS EventEmitter for in-process, BullMQ for durable async jobs).

```typescript
// Core events
'message.received'        // New inbound message normalized
'message.sent'            // Outbound message delivered
'message.failed'          // Outbound delivery failed

'conversation.created'    // New conversation started
'conversation.resolved'   // Conversation marked resolved
'conversation.escalated'  // Conversation needs human input

'ai.intent.classified'    // Intent + confidence computed
'ai.response.generated'   // AI draft ready
'ai.response.approved'    // Human approved AI draft
'ai.response.rejected'    // Human rejected AI draft

'task.created'            // New HITL task
'task.resolved'           // Task completed by human

'order.created'           // New order placed
'order.paid'              // Payment confirmed
'order.shipped'           // Shipment created
'order.delivered'         // Delivery confirmed

'payment.created'         // Payment link generated
'payment.success'         // Payment received
'payment.failed'          // Payment failed
'payment.refund.initiated'// Refund started
'payment.refund.completed'// Refund processed

'booking.created'         // Appointment booked
'booking.cancelled'       // Appointment cancelled
'booking.reminder'        // Reminder trigger

'client.profile.updated'  // Client intelligence updated
'client.churn.risk'       // Churn risk detected

'campaign.triggered'      // Campaign message queued
'campaign.sent'           // Campaign message delivered
```

### Event Flow Example: Message Processing

```mermaid
sequenceDiagram
    participant CH as Channel (WhatsApp)
    participant CA as Channel Adapter
    participant EB as Event Bus
    participant MP as Message Processor
    participant AI as AI Engine
    participant RE as Routing Engine
    participant HITL as HITL Queue
    participant AE as Action Executor
    participant DB as PostgreSQL

    CH->>CA: Webhook POST
    CA->>CA: Validate signature
    CA->>CA: Normalize message
    CA->>DB: Store raw + normalized message
    CA->>EB: emit('message.received')

    EB->>MP: Handle message.received
    MP->>DB: Load conversation context
    MP->>DB: Load client profile
    MP->>AI: Process message

    AI->>AI: Classify intent
    AI->>AI: Load RAG context
    AI->>AI: Generate response
    AI->>AI: Score confidence
    AI->>EB: emit('ai.intent.classified')

    alt Confidence >= 90%
        AI->>RE: Auto-execute
        RE->>AE: Execute action
        AE->>CA: Send response
        CA->>CH: Deliver message
        AE->>DB: Log decision
    else Confidence 70-89%
        AI->>RE: Draft for review
        RE->>HITL: Create review task
        RE->>EB: emit('task.created')
        Note over HITL: Human reviews...
        HITL->>EB: emit('ai.response.approved')
        EB->>AE: Execute approved action
        AE->>CA: Send response
    else Confidence < 70%
        AI->>RE: Full escalation
        RE->>HITL: Create escalation task
        RE->>CA: Send holding message
    end
```

---

## 7. Multi-Tenant Architecture

Every request is scoped by `businessId`. Tenant isolation is enforced at four layers:

### Layer 1: API Gateway
Every authenticated request carries a `businessId` claim in the JWT. Middleware rejects requests missing this claim.

### Layer 2: Service Layer
A `@TenantScoped()` decorator automatically injects `businessId` into every database query via NestJS request-scoped providers.

### Layer 3: Database
PostgreSQL Row-Level Security (RLS) policies enforce tenant isolation at the database level as a defense-in-depth measure.

```sql
-- Example RLS policy
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  USING (business_id = current_setting('app.current_business_id')::uuid);
```

### Layer 4: Cache & Queue
Redis keys are namespaced: `gosumo:{businessId}:{resource}:{id}`. BullMQ job payloads always include `businessId` and processors validate it.

### Layer 5: Vector Store
Qdrant collections are partitioned by `businessId` using payload filtering, ensuring RAG queries never cross tenant boundaries.

```mermaid
graph TB
    REQ[API Request] --> AUTH[Auth Guard]
    AUTH -->|Extract businessId from JWT| MW[Tenant Middleware]
    MW -->|Set request scope| SVC[Service Layer]
    SVC -->|businessId in WHERE| DB[(PostgreSQL + RLS)]
    SVC -->|Namespaced keys| CACHE[(Redis)]
    SVC -->|Filtered by businessId| VEC[(Qdrant)]
    SVC -->|businessId in payload| QUEUE[(BullMQ)]
```

---

## 8. AI Pipeline Architecture

```mermaid
graph TB
    subgraph Input["Input Assembly"]
        MSG[Incoming Message]
        CTX[Context Loader]
        PROF[Client Profile]
        HIST[Conversation History]
        RULES[Business Rules]
        CAT2[Catalog Data]
        CAL[Calendar State]
    end

    subgraph Processing["AI Processing"]
        INTENT[Intent Classifier]
        CONF[Confidence Calculator]
        RAGP[RAG Pipeline]
        PROMPT[Prompt Assembler]
        LLM[LLM Call - Claude]
        PARSE[Response Parser]
    end

    subgraph Output["Output & Routing"]
        VALIDATE[Response Validator]
        ROUTE[Confidence Router]
        AUTO[Auto-Execute Path]
        DRAFT[Draft Review Path]
        ESC[Escalation Path]
    end

    MSG --> CTX
    CTX --> PROF & HIST & RULES & CAT2 & CAL
    CTX --> INTENT
    INTENT --> CONF
    CTX --> RAGP
    RAGP --> PROMPT
    PROMPT --> LLM
    LLM --> PARSE
    PARSE --> VALIDATE
    VALIDATE --> ROUTE
    ROUTE -->|90-100%| AUTO
    ROUTE -->|70-89%| DRAFT
    ROUTE -->|<70%| ESC
```

### Confidence Scoring Formula

```
confidence = (data_availability × 0.5) + (policy_clarity × 0.5)
```

**Hard overrides (force confidence < 50):**
- Price not in catalog
- Refund exceeds policy limit
- Customer mentions legal action
- Loop detection (>3 exchanges, no intent change)
- Sentiment drops below threshold

---

## 9. Data Flow Architecture

### Write Path (Command)
```
Channel → Adapter → Validate → Store Message → Emit Event → Process → Execute → Store Result
```

### Read Path (Query)
```
Dashboard/API → Auth Guard → Tenant Scope → Service → PostgreSQL/Redis → Response
```

### Real-Time Path
```
Event Bus → Socket.IO Gateway → Dashboard Client
```

### Background Job Path
```
Event/Schedule → BullMQ Producer → Redis Queue → BullMQ Worker → Execute → Store Result
```

---

## 10. Deployment Topology

### Development (Docker Compose)

```mermaid
graph TB
    subgraph DockerCompose["Docker Compose"]
        API[gosumo-api :3000]
        DASH[gosumo-dashboard :3001]
        PG[PostgreSQL :5432]
        REDIS[Redis :6379]
        QDRANT[Qdrant :6333]
        BULL[BullMQ Dashboard :3002]
    end

    API --> PG & REDIS & QDRANT
    DASH --> API
    API --> BULL
```

### Production (Kubernetes)

```mermaid
graph TB
    subgraph Edge["Edge"]
        CF[CloudFlare CDN + WAF]
        LB[Load Balancer]
    end

    subgraph K8s["Kubernetes Cluster"]
        subgraph API["API Pods (auto-scaled)"]
            API1[API Pod 1]
            API2[API Pod 2]
            API3[API Pod N]
        end

        subgraph Workers["Worker Pods"]
            W1[AI Worker]
            W2[Campaign Worker]
            W3[Analytics Worker]
        end

        subgraph WS["WebSocket Pods"]
            WS1[Socket.IO Pod]
        end
    end

    subgraph Data["Managed Data Services"]
        RDS[(RDS PostgreSQL)]
        EC[(ElastiCache Redis)]
        QD[(Qdrant Cloud)]
        S3B[(S3 Object Storage)]
    end

    subgraph Monitoring["Observability"]
        SENTRY[Sentry]
        DD[Datadog/Grafana]
        LOKI[Loki Logs]
    end

    CF --> LB --> API & WS
    API --> RDS & EC & QD & S3B
    Workers --> RDS & EC & QD
    API & Workers --> SENTRY & DD & LOKI
```

---

## 11. Security Architecture

### Defense Layers

| Layer | Mechanism |
|---|---|
| Network | CloudFlare WAF, rate limiting, DDoS protection |
| Transport | TLS 1.3 everywhere, HSTS |
| Authentication | JWT (15min access + 7d refresh), mandatory 2FA |
| Authorization | RBAC (Owner/Manager/Staff), server-side enforcement |
| Tenant isolation | RLS + middleware + namespaced caches |
| AI safety | Confidence gating, anti-hallucination rules, PII filtering |
| Webhook security | HMAC-SHA256 signature verification per channel |
| Data at rest | AES-256, field-level encryption for PII |
| Key management | AWS KMS, 90-day rotation |
| Audit | Append-only logs, tamper-evident, 12-month retention |

### AI-Specific Security

- Customer messages are **untrusted input** — never executed as instructions
- System prompts are hardened against prompt injection
- AI **cannot** invent prices, policies, or product information
- All AI responses validated against business rules before sending
- PII filtered from all logs and external API calls
- Financial actions capped by configurable limits

---

## 12. Monorepo Structure

```
gosumo/
├── apps/
│   ├── api/                        # NestJS backend API
│   │   ├── src/
│   │   │   ├── modules/            # Feature modules
│   │   │   │   ├── channel-adapter/
│   │   │   │   ├── conversation/
│   │   │   │   ├── message/
│   │   │   │   ├── ai-engine/
│   │   │   │   ├── client-intelligence/
│   │   │   │   ├── catalog/
│   │   │   │   ├── booking/
│   │   │   │   ├── payment/
│   │   │   │   ├── order/
│   │   │   │   ├── shipping/
│   │   │   │   ├── campaign/
│   │   │   │   ├── hitl/
│   │   │   │   ├── auth/
│   │   │   │   ├── tenant/
│   │   │   │   ├── analytics/
│   │   │   │   └── admin/
│   │   │   ├── common/             # Guards, interceptors, filters
│   │   │   ├── config/             # Environment config
│   │   │   ├── database/           # Migrations, seeds
│   │   │   └── main.ts
│   │   ├── test/
│   │   ├── CLAUDE.md               # AI agent context for API
│   │   └── package.json
│   │
│   └── dashboard/                  # Next.js frontend
│       ├── src/
│       ├── CLAUDE.md
│       └── package.json
│
├── packages/
│   ├── shared/                     # @gosumo/shared
│   │   ├── src/
│   │   │   ├── dto/                # Shared DTOs
│   │   │   ├── events/             # Domain event types
│   │   │   ├── enums/              # Shared enums
│   │   │   ├── interfaces/         # Shared interfaces
│   │   │   └── utils/              # Shared utilities
│   │   └── package.json
│   │
│   ├── database/                   # @gosumo/database
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   └── migrations/
│   │   └── package.json
│   │
│   └── config/                     # @gosumo/config
│       ├── src/
│       └── package.json
│
├── docker/
│   ├── docker-compose.yml
│   ├── docker-compose.prod.yml
│   └── Dockerfile
│
├── docs/                           # Design documents
│   ├── ARCHITECTURE.md
│   ├── API_DESIGN.md
│   ├── DATABASE_DESIGN.md
│   ├── AI_ENGINE_DESIGN.md
│   ├── MODULES.md
│   ├── DEVELOPMENT_GUIDE.md
│   └── SPRINT_PLAN.md
│
├── CLAUDE.md                       # Root AI agent context
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── .eslintrc.js
├── .prettierrc
└── README.md
```

---

## 13. Technology Stack Summary

### Runtime & Frameworks
- **Node.js 20 LTS** + **TypeScript 5.x** (strict mode)
- **NestJS 10** — Backend framework with module system
- **Next.js 14** — Dashboard frontend with SSR
- **Prisma** — Type-safe ORM with migrations

### Data Stores
- **PostgreSQL 16** — Primary relational database
- **Redis 7** — Caching, sessions, BullMQ broker, pub/sub
- **Qdrant** — Vector database for RAG and semantic search
- **S3-compatible** — Object storage for media files

### AI & ML
- **Anthropic Claude** — Primary LLM for reasoning
- **Qdrant** — Vector embeddings for RAG retrieval
- **BullMQ** — Async AI job processing

### Infrastructure
- **Docker** + **Docker Compose** (dev)
- **Kubernetes** (production)
- **CloudFlare** — CDN, WAF, DDoS protection
- **GitHub Actions** — CI/CD pipeline

### Observability
- **Sentry** — Error tracking
- **Datadog/Grafana** — APM and metrics
- **Loki** — Log aggregation
- **BullMQ Board** — Queue monitoring

### External Integrations
- **Meta WhatsApp Business API** — Primary messaging channel
- **Google Calendar API** — Booking/scheduling
- **Razorpay** — Payment processing (India)
- **Shiprocket** — Logistics aggregator (India)

---

## 14. Performance Targets

| Metric | Target | Measurement Point |
|---|---|---|
| API response time | < 200ms (p95) | Server-side latency |
| AI response time | < 4 seconds | Message received → response generated |
| End-to-end response | < 30 seconds | Message received → customer receives reply |
| Concurrent conversations | 100+ per business | Simultaneous active threads |
| System uptime | 99.9% | Monitoring SLA |
| Webhook processing | < 100ms | Receive → acknowledge |
| Dashboard load | < 2 seconds | Initial page load |

---

## 15. AI-Agent Development Considerations

This architecture is designed to be developed and maintained entirely by AI coding agents. Key design decisions supporting this:

1. **Strong module boundaries** — Each module has a single responsibility and well-defined interface. An AI agent can work on any module without understanding the entire system.

2. **Type-safe contracts** — TypeScript strict mode + Prisma generated types ensure compile-time safety. AI agents get immediate feedback on type errors.

3. **Event-driven decoupling** — Modules communicate via typed events, reducing the need to understand other modules' internals.

4. **CLAUDE.md per module** — Each module contains a CLAUDE.md with concise context: purpose, public API, test commands, and conventions. Under 150 lines each.

5. **Comprehensive test specifications** — Every module defines its test strategy. AI agents can verify their changes in isolation.

6. **Prisma schema as single source of truth** — Database schema is defined once and generates TypeScript types, eliminating drift between code and database.

7. **Consistent patterns** — Every module follows the same NestJS structure: controller → service → repository. An agent that understands one module understands them all.

8. **Independent deployability** — Each module can be tested independently with `pnpm test --filter @gosumo/module-name`.
