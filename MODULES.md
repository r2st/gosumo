# GoSumo — Module Reference

> **Purpose:** Define every module so that an AI coding agent can pick up any single module and implement it independently, using only this document and the module's own `CLAUDE.md`.
>
> **Stack:** NestJS 10 · TypeScript strict · PostgreSQL 16 · Prisma ORM · Redis 7 · BullMQ · Qdrant · Anthropic Claude
>
> **Conventions:** Every module follows controller → service → repository. All cross-module communication uses typed domain events. Each module owns its database tables and exposes data only through service methods.

---

## Module Dependency Graph

```mermaid
graph TD
    SHARED[@gosumo/shared]

    AUTH[auth] --> SHARED
    TENANT[tenant] --> SHARED
    TENANT --> AUTH

    CHANNEL[channel-adapter] --> SHARED
    CHANNEL --> TENANT

    CONV[conversation] --> SHARED
    CONV --> CHANNEL
    CONV --> TENANT

    MSG[message] --> SHARED
    MSG --> CONV

    AIENG[ai-engine] --> SHARED
    AIENG --> MSG
    AIENG --> CONV
    AIENG --> CATALOG
    AIENG --> BOOKING
    AIENG --> PAYMENT
    AIENG --> ORDER

    CLIENTI[client-intelligence] --> SHARED
    CLIENTI --> MSG
    CLIENTI --> CONV

    CATALOG[catalog] --> SHARED
    CATALOG --> TENANT

    BOOKING[booking] --> SHARED
    BOOKING --> CATALOG
    BOOKING --> TENANT

    PAYMENT[payment] --> SHARED
    PAYMENT --> TENANT
    PAYMENT --> ORDER

    ORDER[order] --> SHARED
    ORDER --> CATALOG
    ORDER --> TENANT

    SHIPPING[shipping] --> SHARED
    SHIPPING --> ORDER
    SHIPPING --> TENANT

    CAMPAIGN[campaign] --> SHARED
    CAMPAIGN --> MSG
    CAMPAIGN --> CHANNEL
    CAMPAIGN --> CLIENTI

    HITL[hitl] --> SHARED
    HITL --> CONV
    HITL --> MSG

    ANALYTICS[analytics] --> SHARED
    ANALYTICS --> CONV
    ANALYTICS --> MSG
    ANALYTICS --> ORDER
    ANALYTICS --> PAYMENT
    ANALYTICS --> BOOKING
    ANALYTICS --> CAMPAIGN
```

---

## 1. Module: `shared`

**Package:** `@gosumo/shared` · **Path:** `packages/shared/src/`

### Purpose

The `shared` package is the single source of truth for all cross-module TypeScript contracts. It contains zero business logic — only types, DTOs, enums, domain event payloads, utility functions, and interfaces. Every other module depends on `shared`; `shared` depends on nothing. Publishing a stable contract here is what enables AI agents to work on modules independently without reading each other's source code.

### Public Interface

```typescript
// Re-exported from packages/shared/src/index.ts
export * from './enums';
export * from './events';
export * from './interfaces';
export * from './dto';
export * from './utils';
```

### Internal Structure

```
packages/shared/src/
├── enums/
│   ├── channel.enum.ts          # ChannelType: WHATSAPP | INSTAGRAM | SMS | WEB_CHAT | EMAIL
│   ├── conversation.enum.ts     # ConversationStatus, EscalationReason
│   ├── message.enum.ts          # MessageDirection, MessageContentType, DeliveryStatus
│   ├── order.enum.ts            # OrderStatus, FulfillmentType
│   ├── payment.enum.ts          # PaymentStatus, PaymentMethod, RefundStatus
│   ├── booking.enum.ts          # BookingStatus, SlotStatus
│   ├── campaign.enum.ts         # CampaignStatus, CampaignType, AudienceSegment
│   ├── hitl.enum.ts             # TaskStatus, TaskType, EscalationLevel
│   ├── ai.enum.ts               # IntentCategory, ConfidenceBand
│   ├── user.enum.ts             # UserRole: OWNER | MANAGER | STAFF
│   └── index.ts
│
├── interfaces/
│   ├── normalized-message.interface.ts   # NormalizedMessage, MessageContent variants
│   ├── channel-adapter.interface.ts      # ChannelAdapter contract
│   ├── tenant-context.interface.ts       # TenantContext injected into every request
│   ├── paginated-result.interface.ts     # PaginatedResult<T>
│   ├── ai-result.interface.ts            # AIResult, IntentClassification, ConfidenceScore
│   └── index.ts
│
├── events/
│   ├── message.events.ts        # MessageReceivedEvent, MessageSentEvent, MessageFailedEvent
│   ├── conversation.events.ts   # ConversationCreatedEvent, ConversationResolvedEvent, ConversationEscalatedEvent
│   ├── ai.events.ts             # IntentClassifiedEvent, ResponseGeneratedEvent, ResponseApprovedEvent
│   ├── task.events.ts           # TaskCreatedEvent, TaskResolvedEvent
│   ├── order.events.ts          # OrderCreatedEvent, OrderPaidEvent, OrderShippedEvent, OrderDeliveredEvent
│   ├── payment.events.ts        # PaymentCreatedEvent, PaymentSuccessEvent, PaymentFailedEvent, RefundEvents
│   ├── booking.events.ts        # BookingCreatedEvent, BookingCancelledEvent, BookingReminderEvent
│   ├── client.events.ts         # ClientProfileUpdatedEvent, ChurnRiskEvent
│   ├── campaign.events.ts       # CampaignTriggeredEvent, CampaignSentEvent
│   └── index.ts
│
├── dto/
│   ├── pagination.dto.ts        # PaginationQueryDto, PaginatedResponseDto
│   ├── id-param.dto.ts          # UuidParamDto
│   └── index.ts
│
└── utils/
    ├── date.utils.ts            # toIST(), formatDateIST(), isBusinessHours()
    ├── phone.utils.ts           # normalizeIndianPhone(), maskPhone()
    ├── currency.utils.ts        # formatINR(), paiseToRupees(), rupeesToPaise()
    ├── slug.utils.ts            # toSlug(), generateSKU()
    ├── crypto.utils.ts          # generateOtp(), hashOtp(), maskPII()
    └── index.ts
```

### Domain Events

`shared` defines event payload types only. It does not emit or listen to events.

```typescript
// All events follow this base shape:
interface DomainEvent {
  eventId: string;        // uuid v4
  occurredAt: Date;
  businessId: string;     // tenant isolation
  version: number;        // schema version for forward compat
}
```

### Database Tables Owned

None. `shared` has no database access.

### Dependencies

None.

### Test Strategy

- **Unit tests only** — every utility function is pure and tested with jest
- Test file per utility: `date.utils.spec.ts`, `phone.utils.spec.ts`, etc.
- Test scenarios: Indian phone number normalization (91+, 0+, raw 10-digit), INR formatting (paise/rupees), IST conversion, PII masking correctness

### Key Business Rules

- All monetary amounts in the system are stored as **paise (integer)**, displayed as rupees
- All phone numbers are normalized to E.164 format: `+91XXXXXXXXXX`
- All timestamps stored as UTC in DB; displayed as IST in UI
- `businessId` is a UUID — always validate before use

### Error Handling

No runtime errors — shared contains pure utility functions. Invalid input throws `TypeError` with a descriptive message.

---

## 2. Module: `auth`

**Package:** `@gosumo/auth` · **Path:** `apps/api/src/modules/auth/`

### Purpose

The `auth` module owns all authentication and authorization for GoSumo's operator-facing dashboard. It issues and validates JWT access tokens (15-minute TTL) and refresh tokens (7-day TTL), enforces mandatory TOTP-based 2FA for all users, manages RBAC with three roles (OWNER, MANAGER, STAFF), and tracks active sessions. It does not handle customer (end-client) identity — customers are identified by their channel address (phone number, IG handle, etc.) and managed by `client-intelligence`.

### Public Interface

```typescript
export interface IAuthService {
  // Registration & login
  register(dto: RegisterDto): Promise<AuthTokensDto>;
  login(dto: LoginDto): Promise<{ requiresMfa: boolean; mfaToken?: string; tokens?: AuthTokensDto }>;
  verifyMfa(dto: VerifyMfaDto): Promise<AuthTokensDto>;
  refreshTokens(refreshToken: string): Promise<AuthTokensDto>;
  logout(userId: string, sessionId: string): Promise<void>;
  logoutAll(userId: string): Promise<void>;

  // 2FA management
  setupMfa(userId: string): Promise<MfaSetupDto>;
  confirmMfa(userId: string, totp: string): Promise<{ backupCodes: string[] }>;
  disableMfa(userId: string, totp: string): Promise<void>;
  validateMfaCode(userId: string, totp: string): Promise<boolean>;

  // Password
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(dto: ResetPasswordDto): Promise<void>;
  changePassword(userId: string, dto: ChangePasswordDto): Promise<void>;

  // Session management
  getActiveSessions(userId: string): Promise<SessionDto[]>;
  revokeSession(userId: string, sessionId: string): Promise<void>;

  // RBAC
  getUserPermissions(userId: string, businessId: string): Promise<PermissionsDto>;
  assignRole(dto: AssignRoleDto): Promise<void>;
  removeRole(userId: string, businessId: string): Promise<void>;
}
```

### Internal Structure

```
auth/
├── auth.module.ts
├── auth.controller.ts           # POST /auth/register, /login, /refresh, /logout, /mfa/*
├── auth.service.ts              # Orchestrates login flow, token lifecycle
├── auth.repository.ts           # DB queries for users, sessions, roles
├── strategies/
│   ├── jwt.strategy.ts          # Passport JWT strategy — validates access token
│   ├── jwt-refresh.strategy.ts  # Validates refresh token from cookie
│   └── local.strategy.ts        # Email+password validation
├── guards/
│   ├── jwt-auth.guard.ts        # Applied globally; allows @Public() routes
│   ├── roles.guard.ts           # Checks UserRole from JWT claim
│   └── mfa.guard.ts             # Enforces MFA completion before token upgrade
├── decorators/
│   ├── public.decorator.ts      # @Public() — skips JWT guard
│   ├── roles.decorator.ts       # @Roles(UserRole.OWNER)
│   └── current-user.decorator.ts # @CurrentUser() — extracts from request
├── dto/
│   ├── register.dto.ts          # email, password, businessName
│   ├── login.dto.ts             # email, password
│   ├── verify-mfa.dto.ts        # mfaToken, totp
│   ├── auth-tokens.dto.ts       # accessToken, refreshToken, expiresIn
│   ├── mfa-setup.dto.ts         # qrCodeUrl, secret
│   ├── reset-password.dto.ts    # token, newPassword
│   ├── change-password.dto.ts   # currentPassword, newPassword
│   └── assign-role.dto.ts       # userId, businessId, role
└── auth.constants.ts            # JWT_SECRET, REFRESH_SECRET, TTLs
```

### Domain Events

**Emits:** none (auth events are audit-logged, not broadcast)

**Listens to:** none

### Database Tables Owned

```sql
users              -- id, email, passwordHash, mfaSecret, mfaEnabled, backupCodes, createdAt
user_sessions      -- id, userId, sessionId, refreshTokenHash, deviceInfo, ipAddress, expiresAt, revokedAt
business_members   -- businessId, userId, role (OWNER|MANAGER|STAFF), invitedAt, joinedAt
password_resets    -- id, userId, tokenHash, expiresAt, usedAt
mfa_tokens         -- id, userId, tokenHash, expiresAt (short-lived pre-MFA JWT)
audit_log          -- id, businessId, userId, action, resourceType, resourceId, metadata, ip, createdAt
```

### Dependencies

- `@gosumo/shared` — UserRole enum, TenantContext interface
- `@nestjs/passport`, `passport-jwt`, `passport-local` — authentication strategies
- `bcrypt` — password hashing
- `otplib` — TOTP generation and verification
- `jsonwebtoken` — token signing and verification
- Redis — session invalidation blacklist, rate limiting login attempts

### Test Strategy

**Unit tests:**
- `auth.service.spec.ts` — mock repository, test all happy paths and error branches
- `jwt.strategy.spec.ts` — token validation with expired/invalid/valid tokens
- `roles.guard.spec.ts` — role hierarchy enforcement

**Integration tests:**
- Full login flow: register → login → MFA setup → MFA verify → access protected route
- Refresh flow: use refresh token → get new access token → old refresh token invalidated
- Session revocation: logout → refresh token rejected

**Test scenarios:**
- Login with wrong password → 401 after 5 attempts → 429 rate limit
- Login without MFA configured → force MFA setup redirect
- Expired access token → 401 → refresh → new tokens
- Revoked session → refresh rejected even with valid token format
- STAFF role accessing OWNER endpoint → 403

### Key Business Rules

- MFA is **mandatory** — no user can access the system without 2FA configured
- Access tokens: 15-minute TTL, signed RS256, stored in memory (not localStorage)
- Refresh tokens: 7-day TTL, stored as HttpOnly cookie, hashed in DB
- Maximum 5 concurrent sessions per user; oldest session evicted on 6th login
- Passwords: minimum 8 chars, 1 uppercase, 1 number, 1 special char; bcrypt cost 12
- Role OWNER: full access to their business. MANAGER: all except billing/member management. STAFF: conversations and tasks only.
- `businessId` in JWT must match the resource being accessed — cross-tenant access is forbidden even for valid tokens

### Error Handling

| Error | HTTP | Message |
|---|---|---|
| Invalid credentials | 401 | `INVALID_CREDENTIALS` |
| MFA required | 403 | `MFA_REQUIRED` |
| Invalid MFA code | 401 | `INVALID_MFA_CODE` |
| Token expired | 401 | `TOKEN_EXPIRED` |
| Insufficient role | 403 | `INSUFFICIENT_PERMISSIONS` |
| Too many login attempts | 429 | `RATE_LIMIT_EXCEEDED` |
| Account not found | 404 | `USER_NOT_FOUND` |

---

## 3. Module: `tenant`

**Package:** `@gosumo/tenant` · **Path:** `apps/api/src/modules/tenant/`

### Purpose

The `tenant` module manages business profiles and multi-tenant configuration. Each "business" in GoSumo is a tenant — a small business in India that uses the platform. This module owns onboarding flow, business profile data (name, category, address, GST number), channel account connections (which WhatsApp/Instagram/SMS accounts belong to this business), AI behavior settings (confidence thresholds, auto-reply hours, language preferences), and business policies (refund policy, SLA targets). It is the authority on what a business looks like and how it should behave.

### Public Interface

```typescript
export interface ITenantService {
  // Business profile
  createBusiness(dto: CreateBusinessDto, ownerId: string): Promise<BusinessDto>;
  getBusinessById(businessId: string): Promise<BusinessDto>;
  updateBusiness(businessId: string, dto: UpdateBusinessDto): Promise<BusinessDto>;
  getBusinessSettings(businessId: string): Promise<BusinessSettingsDto>;
  updateBusinessSettings(businessId: string, dto: UpdateSettingsDto): Promise<BusinessSettingsDto>;

  // Onboarding
  getOnboardingStatus(businessId: string): Promise<OnboardingStatusDto>;
  completeOnboardingStep(businessId: string, step: OnboardingStep): Promise<OnboardingStatusDto>;

  // Channel connections
  connectChannel(businessId: string, dto: ConnectChannelDto): Promise<ChannelConnectionDto>;
  disconnectChannel(businessId: string, channelConnectionId: string): Promise<void>;
  getChannelConnections(businessId: string): Promise<ChannelConnectionDto[]>;
  getChannelConnection(businessId: string, channelType: ChannelType): Promise<ChannelConnectionDto | null>;
  updateChannelCredentials(businessId: string, channelConnectionId: string, dto: UpdateChannelCredentialsDto): Promise<void>;

  // AI configuration
  getAIConfig(businessId: string): Promise<AIConfigDto>;
  updateAIConfig(businessId: string, dto: UpdateAIConfigDto): Promise<AIConfigDto>;

  // Business policies
  getPolicies(businessId: string): Promise<BusinessPoliciesDto>;
  updatePolicies(businessId: string, dto: UpdatePoliciesDto): Promise<BusinessPoliciesDto>;

  // Members (thin layer — auth owns roles)
  getMembers(businessId: string): Promise<MemberDto[]>;
  inviteMember(businessId: string, dto: InviteMemberDto): Promise<void>;
  removeMember(businessId: string, userId: string): Promise<void>;
}
```

### Internal Structure

```
tenant/
├── tenant.module.ts
├── tenant.controller.ts         # GET/PUT /tenant, /tenant/settings, /tenant/channels, etc.
├── tenant.service.ts            # Business logic, orchestrates sub-services
├── tenant.repository.ts         # DB queries for businesses, settings, channel connections
├── services/
│   ├── onboarding.service.ts    # Step tracking, completion events
│   └── channel-connection.service.ts  # Credential encryption, validation
├── dto/
│   ├── create-business.dto.ts   # name, category, phone, gstNumber, address
│   ├── update-business.dto.ts   # Partial of CreateBusiness
│   ├── business.dto.ts          # Full business response shape
│   ├── business-settings.dto.ts # autoReplyHours, language, timezone, currency
│   ├── ai-config.dto.ts         # confidenceThresholds, maxAutoReplies, enabledIntents
│   ├── business-policies.dto.ts # refundWindowDays, maxRefundAmount, slaHours
│   ├── connect-channel.dto.ts   # channelType, credentials (JSONB), webhookUrl
│   ├── channel-connection.dto.ts # id, channelType, status, connectedAt
│   └── member.dto.ts            # userId, email, role, joinedAt
└── tenant.constants.ts          # Default AI config, default policies
```

### Domain Events

**Emits:**
- `business.created` — payload: `{ businessId, ownerId, businessName, plan }`
- `business.channel.connected` — payload: `{ businessId, channelType, channelAccountId }`
- `business.channel.disconnected` — payload: `{ businessId, channelType }`
- `business.settings.updated` — payload: `{ businessId, changedFields: string[] }`

**Listens to:** none

### Database Tables Owned

```sql
businesses              -- id, name, slug, category, phone, email, gstNumber, address (JSONB),
                        --   plan, status, createdAt, updatedAt
business_settings       -- businessId (PK), timezone, language, currency, autoReplyEnabled,
                        --   autoReplyHours (JSONB), defaultLanguage
business_ai_config      -- businessId (PK), confidenceAutoExecute, confidenceDraftReview,
                        --   maxDailyAutoReplies, enabledIntentCategories (text[]),
                        --   systemPromptAddendum, ragEnabled
business_policies       -- businessId (PK), refundWindowDays, maxRefundAmountPaise,
                        --   slaFirstResponseMinutes, slaResolutionHours, codEnabled
channel_connections     -- id, businessId, channelType, channelAccountId, credentialsEncrypted (JSONB),
                        --   webhookUrl, status, connectedAt, lastVerifiedAt
onboarding_progress     -- businessId (PK), completedSteps (text[]), completedAt
member_invitations      -- id, businessId, email, role, invitedBy, token, expiresAt, acceptedAt
```

### Dependencies

- `@gosumo/shared` — ChannelType enum, UserRole enum
- `@gosumo/auth` — validates membership for invite/remove operations
- `aws-kms` or `@nestjs/config` with AES-256 — encrypting channel credentials at rest

### Test Strategy

**Unit tests:**
- `tenant.service.spec.ts` — mock repository; test onboarding step transitions, channel validation
- `channel-connection.service.spec.ts` — test credential encryption/decryption round-trip

**Integration tests:**
- Create business → onboarding steps complete → business marked active
- Connect channel → retrieve channel credentials → send outbound message (mocked)
- Update AI config → thresholds reflected in AIConfigDto

**Test scenarios:**
- Duplicate business slug → auto-append suffix
- GST number format validation (15-char alphanumeric)
- Channel connect with invalid credentials → status FAILED, error stored
- Update confidence threshold below 50 → validation error
- Member invite with existing email → resend invite (idempotent)

### Key Business Rules

- Every business must have at least one channel connected before activating
- `confidenceAutoExecute` default: 90 (out of 100); `confidenceDraftReview` default: 70
- Channel credentials are encrypted with AES-256 before storage; never logged
- `autoReplyHours` can be configured per day of week with start/end time in IST
- Business `plan` gates features: STARTER (1 channel, 3 staff), GROWTH (5 channels, 10 staff), SCALE (unlimited)
- GST number is optional but validated against 15-char format when provided

### Error Handling

| Error | HTTP | Message |
|---|---|---|
| Business not found | 404 | `BUSINESS_NOT_FOUND` |
| Channel already connected | 409 | `CHANNEL_ALREADY_CONNECTED` |
| Channel credential invalid | 422 | `INVALID_CHANNEL_CREDENTIALS` |
| Plan limit exceeded | 402 | `PLAN_LIMIT_EXCEEDED` |
| Onboarding step out of order | 422 | `INVALID_ONBOARDING_STEP` |

---

## 4. Module: `channel-adapter`

**Package:** `@gosumo/channel-adapter` · **Path:** `apps/api/src/modules/channel-adapter/`

### Purpose

The `channel-adapter` module is the translation layer between external messaging channels and GoSumo's internal normalized message format. It receives raw webhook payloads from all channels (WhatsApp Business API, Instagram Messaging API, SMS gateways, Web Chat, Email), validates HMAC signatures, normalizes messages to `NormalizedMessage`, stores the raw payload for debugging, emits `message.received` events, and routes outbound messages back to the correct channel. It is the only module that speaks channel-specific protocols. All other modules communicate using `NormalizedMessage` only.

### Public Interface

```typescript
export interface IChannelAdapterService {
  // Outbound — called by ai-engine / hitl after a decision is made
  sendMessage(businessId: string, dto: SendMessageDto): Promise<SendResultDto>;
  sendTemplate(businessId: string, dto: SendTemplateDto): Promise<SendResultDto>;
  sendInteractive(businessId: string, dto: SendInteractiveDto): Promise<SendResultDto>;

  // Media
  downloadMedia(businessId: string, channelType: ChannelType, mediaId: string): Promise<Buffer>;
  uploadMediaToStorage(buffer: Buffer, mimeType: string, businessId: string): Promise<string>;

  // Channel status
  getChannelStatus(businessId: string, channelType: ChannelType): Promise<ChannelStatusDto>;
  getChannelCapabilities(channelType: ChannelType): Promise<ChannelCapabilitiesDto>;
}
```

### Internal Structure

```
channel-adapter/
├── channel-adapter.module.ts
├── channel-adapter.controller.ts    # POST /webhooks/:channel — receives all webhooks
├── channel-adapter.service.ts       # Routes outbound; delegates to adapters
├── channel-registry.ts              # Map<ChannelType, ChannelAdapter>; DI registration
├── adapters/
│   ├── whatsapp/
│   │   ├── whatsapp.adapter.ts      # Implements ChannelAdapter interface
│   │   ├── whatsapp.normalizer.ts   # Raw WA payload → NormalizedMessage
│   │   ├── whatsapp.validator.ts    # HMAC-SHA256 signature check
│   │   └── whatsapp.types.ts        # Raw WA API payload types
│   ├── instagram/
│   │   ├── instagram.adapter.ts
│   │   ├── instagram.normalizer.ts
│   │   └── instagram.validator.ts
│   ├── sms/
│   │   ├── sms.adapter.ts
│   │   ├── sms.normalizer.ts
│   │   └── sms.validator.ts
│   ├── web-chat/
│   │   ├── web-chat.adapter.ts      # WebSocket-based; long-polling fallback
│   │   ├── web-chat.normalizer.ts
│   │   └── web-chat.gateway.ts      # Socket.IO gateway for web chat
│   └── email/
│       ├── email.adapter.ts
│       ├── email.normalizer.ts
│       └── email.validator.ts
├── dto/
│   ├── send-message.dto.ts          # to, channelType, content (NormalizedContent)
│   ├── send-template.dto.ts         # to, channelType, templateName, parameters
│   ├── send-interactive.dto.ts      # to, channelType, buttons/list payload
│   ├── send-result.dto.ts           # externalId, status, deliveredAt
│   └── channel-capabilities.dto.ts  # supportsTemplates, supportsInteractive, maxMessageLength
└── channel-adapter.constants.ts     # Webhook signature header names per channel
```

### Domain Events

**Emits:**
- `message.received` — payload: `{ businessId, normalizedMessage: NormalizedMessage }`
- `message.sent` — payload: `{ businessId, messageId, externalId, channel, deliveredAt }`
- `message.failed` — payload: `{ businessId, messageId, channel, error, retryCount }`

**Listens to:**
- `message.send` (from `ai-engine`/`hitl`) — triggers outbound routing

### Database Tables Owned

```sql
raw_webhook_payloads    -- id, businessId, channelType, headers (JSONB), body (JSONB),
                        --   receivedAt, processingStatus, errorMessage
outbound_message_log    -- id, businessId, channelType, externalId, normalizedMessageId,
                        --   status, attemptCount, lastAttemptAt, error
```

### Dependencies

- `@gosumo/shared` — ChannelType, NormalizedMessage, MessageContent, DomainEvents
- `@gosumo/tenant` — `getChannelConnection()` to retrieve credentials per business
- `@nestjs/event-emitter` — publishing `message.received`
- Redis — rate limiting outbound sends, deduplication of duplicate webhook deliveries
- S3 client — storing downloaded media files

### Test Strategy

**Unit tests:**
- Each adapter normalizer: `whatsapp.normalizer.spec.ts` — exhaustive tests for every message type (text, image, document, location, interactive, template)
- Each validator: test valid signature, tampered payload, missing header
- `channel-adapter.service.spec.ts` — outbound routing to correct adapter

**Integration tests:**
- POST `/webhooks/whatsapp` with valid signed payload → `message.received` event fired
- POST `/webhooks/whatsapp` with invalid signature → 400 rejected
- Duplicate webhook delivery (same `externalId`) → deduplicated, not double-processed
- Send message via service → adapter called → `message.sent` event emitted

**Test scenarios:**
- WhatsApp: text, image, document, audio, location, button reply, list reply, payment
- Instagram: text, image, story reply, quick reply
- SMS: inbound text, delivery receipt webhook
- Unknown channel type → `UNSUPPORTED_CHANNEL` error

### Key Business Rules

- Every inbound webhook must be signature-verified before processing — invalid signatures return 200 (to prevent retries) but are not processed
- Duplicate detection: store `externalId` per channel in Redis with 24h TTL; skip if seen
- Media files are downloaded from channel CDN and re-uploaded to GoSumo S3 storage immediately — never store channel CDN URLs directly (they expire)
- Outbound sends have a retry policy: 3 attempts with exponential backoff (1s, 4s, 16s)
- Rate limits per channel must be respected: WhatsApp 80 messages/second per phone number
- Web Chat webhook is actually a Socket.IO gateway — not an HTTP endpoint

### Error Handling

| Error | Behavior |
|---|---|
| Invalid webhook signature | Return 200, log and discard |
| Channel credentials expired/invalid | Emit `channel.credential.error`, alert via HITL |
| Outbound send failure | Retry 3x; emit `message.failed` on final failure |
| Media download failure | Store message without media URL; flag for human review |
| Unsupported message type | Normalize as `{ type: 'UNSUPPORTED' }`, still emit event |

---

## 5. Module: `conversation`

**Package:** `@gosumo/conversation` · **Path:** `apps/api/src/modules/conversation/`

### Purpose

The `conversation` module manages the lifecycle of conversations between a business and its customers. A conversation is a stateful thread — it has a status (OPEN, RESOLVED, ESCALATED, SNOOZED), an assigned agent (human or AI), a channel, and a client identifier. The module implements a state machine that governs valid status transitions, ensures no conversation is lost between AI and human handling, tracks conversation metadata (first response time, resolution time, satisfaction score), and provides the context window that `ai-engine` reads before generating a response. It is the central coordination point between messages arriving and AI/humans deciding what to do.

### Public Interface

```typescript
export interface IConversationService {
  // Lifecycle
  findOrCreateConversation(businessId: string, dto: FindOrCreateConversationDto): Promise<ConversationDto>;
  getConversation(businessId: string, conversationId: string): Promise<ConversationDto>;
  listConversations(businessId: string, query: ListConversationsQueryDto): Promise<PaginatedResult<ConversationDto>>;
  updateConversationStatus(businessId: string, conversationId: string, dto: UpdateStatusDto): Promise<ConversationDto>;
  assignConversation(businessId: string, conversationId: string, dto: AssignConversationDto): Promise<ConversationDto>;
  snoozeConversation(businessId: string, conversationId: string, snoozeUntil: Date): Promise<ConversationDto>;

  // Context for AI engine
  getConversationContext(businessId: string, conversationId: string): Promise<ConversationContextDto>;

  // Tags & metadata
  addTag(businessId: string, conversationId: string, tag: string): Promise<void>;
  removeTag(businessId: string, conversationId: string, tag: string): Promise<void>;
  updateConversationNote(businessId: string, conversationId: string, note: string): Promise<void>;

  // Stats
  getConversationStats(businessId: string, query: StatsQueryDto): Promise<ConversationStatsDto>;
}
```

### Internal Structure

```
conversation/
├── conversation.module.ts
├── conversation.controller.ts   # GET/PUT/POST /conversations
├── conversation.service.ts      # Orchestration, state machine transitions
├── conversation.repository.ts   # DB queries
├── state-machine/
│   ├── conversation.states.ts   # State enum: OPEN, AI_HANDLING, DRAFT_REVIEW, ESCALATED, SNOOZED, RESOLVED
│   └── conversation.transitions.ts  # Allowed transition map; throws on invalid transition
├── dto/
│   ├── find-or-create.dto.ts    # clientExternalId, channelType, channelAccountId
│   ├── conversation.dto.ts      # Full response shape with status, assignee, channel, lastMessage
│   ├── update-status.dto.ts     # status, reason
│   ├── assign-conversation.dto.ts # assigneeId, assigneeType (AI|HUMAN)
│   ├── conversation-context.dto.ts # last N messages, clientProfile snippet, open tasks
│   └── list-conversations-query.dto.ts # status filter, channel filter, assignee, dateRange
└── conversation.constants.ts    # CONTEXT_WINDOW_SIZE = 20, SNOOZE_MAX_DAYS = 7
```

### Domain Events

**Emits:**
- `conversation.created` — payload: `{ businessId, conversationId, clientId, channelType }`
- `conversation.resolved` — payload: `{ businessId, conversationId, resolvedBy, resolutionTimeMs }`
- `conversation.escalated` — payload: `{ businessId, conversationId, escalationReason, triggeredBy }`
- `conversation.status.changed` — payload: `{ businessId, conversationId, from, to, changedBy }`
- `conversation.assigned` — payload: `{ businessId, conversationId, assigneeId, assigneeType }`

**Listens to:**
- `message.received` — find or create conversation, update `lastMessageAt`
- `task.resolved` — transition conversation from ESCALATED → OPEN or RESOLVED
- `ai.response.approved` — transition conversation from DRAFT_REVIEW → AI_HANDLING

### Database Tables Owned

```sql
conversations       -- id, businessId, clientId, channelType, channelAccountId,
                    --   status, assigneeId, assigneeType, firstMessageAt, lastMessageAt,
                    --   resolvedAt, resolutionTimeMs, firstResponseTimeMs,
                    --   tags (text[]), internalNote, satisfactionScore, createdAt
conversation_events -- id, conversationId, businessId, event, fromStatus, toStatus,
                    --   actorId, actorType, metadata (JSONB), createdAt
```

### Dependencies

- `@gosumo/shared` — ConversationStatus enum, domain event types
- `@gosumo/channel-adapter` — `getChannelCapabilities()` for knowing what's sendable
- Redis — active conversation ID cache for sub-millisecond lookup; snoozed conversation wake-up queue

### Test Strategy

**Unit tests:**
- `conversation.state-machine.spec.ts` — test every valid and invalid transition
- `conversation.service.spec.ts` — mock repo; test `findOrCreateConversation` idempotency

**Integration tests:**
- Inbound message → conversation created → second message → same conversation returned
- Conversation escalated → task resolved → conversation auto-resolved
- Snoozed conversation → wakes at correct time → re-enters OPEN

**Test scenarios:**
- Same client sends message on two channels → two separate conversations
- Conversation in RESOLVED state receives new message → auto-reopens
- Attempt invalid transition (RESOLVED → AI_HANDLING without reopening) → error
- Context window returns exactly last 20 messages (not more)

### Key Business Rules

- One conversation per (businessId, clientId, channelType) at a time — reopened, not duplicated
- A conversation in RESOLVED status is auto-reopened when a new message arrives from that client
- Context window for AI: last 20 messages + last 5 conversation events + client profile summary
- First response time SLA: measured from `firstMessageAt` to first outbound message timestamp
- A conversation cannot be manually resolved while an open HITL task exists for it
- Satisfaction score is set by client sending a rating (1-5) in response to a post-resolution prompt

### Error Handling

| Error | HTTP | Message |
|---|---|---|
| Conversation not found | 404 | `CONVERSATION_NOT_FOUND` |
| Invalid status transition | 422 | `INVALID_STATUS_TRANSITION` |
| Cannot resolve with open tasks | 422 | `OPEN_TASKS_EXIST` |
| Snooze duration too long | 422 | `SNOOZE_DURATION_EXCEEDED` |

---

## 6. Module: `message`

**Package:** `@gosumo/message` · **Path:** `apps/api/src/modules/message/`

### Purpose

The `message` module is responsible for persistent storage, retrieval, and search of all messages flowing through GoSumo — both inbound from customers and outbound from the AI or human agents. It stores every message exactly once, maintaining the full conversation history that feeds the AI context window and the dashboard conversation view. Messages are stored with their normalized content, delivery status, and any AI metadata (intent, confidence) attached. The module supports full-text search across message content (for searching customer history) and provides pagination-aware retrieval for dashboard rendering.

### Public Interface

```typescript
export interface IMessageService {
  // Storage
  storeInboundMessage(businessId: string, dto: StoreInboundMessageDto): Promise<MessageDto>;
  storeOutboundMessage(businessId: string, dto: StoreOutboundMessageDto): Promise<MessageDto>;
  updateDeliveryStatus(businessId: string, messageId: string, dto: UpdateDeliveryStatusDto): Promise<void>;

  // Retrieval
  getMessage(businessId: string, messageId: string): Promise<MessageDto>;
  getConversationMessages(businessId: string, conversationId: string, query: PaginationQueryDto): Promise<PaginatedResult<MessageDto>>;
  getLastNMessages(businessId: string, conversationId: string, n: number): Promise<MessageDto[]>;

  // Search
  searchMessages(businessId: string, query: SearchMessagesDto): Promise<PaginatedResult<MessageDto>>;

  // AI metadata attachment
  attachAIMetadata(businessId: string, messageId: string, dto: AIMetadataDto): Promise<void>;

  // Stats
  getMessageStats(businessId: string, conversationId: string): Promise<MessageStatsDto>;
}
```

### Internal Structure

```
message/
├── message.module.ts
├── message.controller.ts        # GET /conversations/:id/messages, GET /messages/:id, POST /messages/search
├── message.service.ts
├── message.repository.ts        # All Prisma queries; handles JSONB content column
├── dto/
│   ├── store-inbound-message.dto.ts  # conversationId, channelMessageId, content (NormalizedContent), sender
│   ├── store-outbound-message.dto.ts # conversationId, content, generatedBy (AI|HUMAN), taskId?
│   ├── update-delivery-status.dto.ts # status (SENT|DELIVERED|READ|FAILED), timestamp
│   ├── message.dto.ts                # Full response: id, direction, content, status, aiMetadata, timestamps
│   ├── search-messages.dto.ts        # query string, conversationId?, dateRange, channel?
│   └── ai-metadata.dto.ts            # intentCategory, confidenceScore, ragContextUsed, promptTokens
└── message.constants.ts              # MAX_SEARCH_RESULTS = 50, FULL_TEXT_SEARCH_CONFIG
```

### Domain Events

**Emits:**
- `message.stored` — payload: `{ businessId, messageId, conversationId, direction }`

**Listens to:**
- `message.received` (from `channel-adapter`) — calls `storeInboundMessage()`
- `message.sent` (from `channel-adapter`) — calls `storeOutboundMessage()` if not already stored
- `message.failed` — calls `updateDeliveryStatus()` with FAILED

### Database Tables Owned

```sql
messages            -- id, businessId, conversationId, direction (INBOUND|OUTBOUND),
                    --   channelMessageId, channelType, content (JSONB),
                    --   senderId, senderDisplayName, deliveryStatus,
                    --   sentAt, deliveredAt, readAt, failedAt,
                    --   generatedBy (AI|HUMAN|SYSTEM), taskId,
                    --   aiIntentCategory, aiConfidenceScore, aiRagUsed,
                    --   createdAt
-- Index: (businessId, conversationId, createdAt DESC)
-- Index: Full-text search on content->>'text' using pg_trgm
```

### Dependencies

- `@gosumo/shared` — NormalizedMessage, MessageDirection, DeliveryStatus
- `@gosumo/conversation` — validates conversationId exists before storing

### Test Strategy

**Unit tests:**
- `message.repository.spec.ts` — test JSONB content storage and retrieval for each content type
- `message.service.spec.ts` — test pagination, last-N retrieval, search query construction

**Integration tests:**
- Store inbound text message → retrieve via `getConversationMessages` → correct shape
- Store image message → retrieve → URL preserved
- Search "delivery" → returns messages containing that word
- Pagination: 5 messages, page size 2 → 3 pages returned correctly

**Test scenarios:**
- Store message with JSONB image content → retrieve → content.url intact
- Full-text search across multiple conversations for same business → no cross-tenant leakage
- Update delivery status on non-existent message → 404
- Retrieve last 20 messages from a conversation with 100 → returns exactly 20, newest first

### Key Business Rules

- Messages are **append-only** — never update message content after storage
- Outbound messages generated by AI must have `generatedBy: 'AI'` and `aiConfidenceScore` set
- `channelMessageId` (the external message ID from the channel) must be unique per business — used for deduplication
- Full-text search indexes only `TEXT` content type messages; other types are excluded from search
- Message content of type `DOCUMENT` or `IMAGE` must reference GoSumo S3 URLs, never external channel CDN URLs

### Error Handling

| Error | HTTP | Message |
|---|---|---|
| Message not found | 404 | `MESSAGE_NOT_FOUND` |
| Conversation not found | 404 | `CONVERSATION_NOT_FOUND` |
| Duplicate channelMessageId | 409 | `DUPLICATE_MESSAGE` (silently skip in event handler) |
| Content too large | 413 | `MESSAGE_CONTENT_TOO_LARGE` |

---

## 7. Module: `ai-engine`

**Package:** `@gosumo/ai-engine` · **Path:** `apps/api/src/modules/ai-engine/`

### Purpose

The `ai-engine` module is the cognitive core of GoSumo. It receives a conversation context (recent messages, client profile, business rules, catalog data, calendar state), classifies the customer's intent, retrieves relevant business knowledge via RAG from Qdrant, assembles a system prompt, calls Anthropic Claude, parses the structured response, scores confidence using a deterministic formula, and routes the result to one of three paths: auto-execute (≥90% confidence), draft review (70–89%), or full escalation (<70%). It also owns the knowledge base ingestion pipeline — turning business documents, FAQs, and catalog data into vector embeddings.

### Public Interface

```typescript
export interface IAIEngineService {
  // Main pipeline — called when message.received fires
  processMessage(businessId: string, dto: ProcessMessageDto): Promise<AIDecisionDto>;

  // Knowledge base management
  ingestKnowledgeBase(businessId: string, dto: IngestKnowledgeDto): Promise<IngestResultDto>;
  deleteKnowledgeEntry(businessId: string, entryId: string): Promise<void>;
  searchKnowledgeBase(businessId: string, query: string, limit?: number): Promise<KnowledgeEntryDto[]>;

  // Intent classification (standalone, for analytics)
  classifyIntent(businessId: string, text: string): Promise<IntentClassificationDto>;

  // Confidence scoring (standalone, for testing thresholds)
  scoreConfidence(businessId: string, dto: ConfidenceScoringInputDto): Promise<ConfidenceScoreDto>;

  // Draft management (called by HITL module)
  getDraftDecision(businessId: string, decisionId: string): Promise<AIDecisionDto>;
  regenerateDraft(businessId: string, decisionId: string, feedback?: string): Promise<AIDecisionDto>;
}
```

### Internal Structure

```
ai-engine/
├── ai-engine.module.ts
├── ai-engine.controller.ts       # POST /ai/process, /ai/knowledge, GET /ai/knowledge/search
├── ai-engine.service.ts          # Pipeline orchestrator
├── pipeline/
│   ├── context-loader.ts         # Assembles all context: messages, profile, catalog, calendar
│   ├── intent-classifier.ts      # Claude call for intent classification; returns IntentCategory + entities
│   ├── rag-retriever.ts          # Qdrant semantic search; returns top-K chunks
│   ├── prompt-assembler.ts       # Builds final system + user prompt from all context
│   ├── llm-client.ts             # Anthropic SDK wrapper; handles retries, streaming, token counting
│   ├── response-parser.ts        # Parses structured JSON response from Claude
│   ├── confidence-calculator.ts  # Deterministic confidence formula
│   └── action-router.ts          # Decides auto-execute vs draft vs escalate
├── knowledge/
│   ├── knowledge-ingestion.service.ts   # Chunk documents, embed, upsert to Qdrant
│   ├── knowledge-embedding.service.ts   # Calls embedding model; caches in Redis
│   └── knowledge.repository.ts          # Postgres metadata for knowledge entries
├── prompts/
│   ├── system.prompt.ts          # Base system prompt template
│   ├── intent.prompt.ts          # Intent classification prompt
│   └── response.prompt.ts        # Response generation prompt with structured output schema
├── dto/
│   ├── process-message.dto.ts    # conversationId, latestMessageId, forceEscalate?
│   ├── ai-decision.dto.ts        # intentCategory, confidence, band, action, draftResponse, entities
│   ├── ingest-knowledge.dto.ts   # content (text|url|file), type, tags
│   ├── intent-classification.dto.ts # category, subcategory, entities, confidence
│   ├── confidence-scoring-input.dto.ts # dataAvailability, policyClarity, hardOverrides
│   └── knowledge-entry.dto.ts    # id, content, similarity, tags
├── workers/
│   └── ai-processing.worker.ts   # BullMQ worker processing 'ai-process' queue
└── ai-engine.constants.ts        # CONFIDENCE_AUTO_EXECUTE=90, CONFIDENCE_DRAFT=70,
                                  --   MAX_RAG_CHUNKS=5, CONTEXT_MESSAGES=20
```

### Domain Events

**Emits:**
- `ai.intent.classified` — payload: `{ businessId, conversationId, messageId, intentCategory, confidence }`
- `ai.response.generated` — payload: `{ businessId, conversationId, decisionId, band, draftResponse }`
- `ai.auto.executed` — payload: `{ businessId, conversationId, decisionId, action }`
- `ai.escalated` — payload: `{ businessId, conversationId, reason, suggestedAction }`

**Listens to:**
- `message.received` → triggers `processMessage()` via BullMQ queue
- `ai.response.approved` (from `hitl`) → `sendApprovedDraft()`
- `business.settings.updated` → invalidates cached AI config

### Database Tables Owned

```sql
ai_decisions        -- id, businessId, conversationId, messageId, intentCategory,
                    --   intentEntities (JSONB), confidenceScore, confidenceBand,
                    --   ragChunksUsed (JSONB), promptTokens, completionTokens,
                    --   draftResponse, finalResponse, hardOverrides (text[]),
                    --   status (PENDING|AUTO_EXECUTED|DRAFT|ESCALATED|APPROVED|REJECTED),
                    --   processedAt, createdAt
knowledge_entries   -- id, businessId, content, contentType, sourceUrl, tags (text[]),
                    --   qdrantPointId, embeddingModel, tokenCount, createdAt, updatedAt
```

### Dependencies

- `@gosumo/shared` — IntentCategory, ConfidenceBand enums, event types
- `@gosumo/message` — `getLastNMessages()`, `attachAIMetadata()`
- `@gosumo/conversation` — `getConversationContext()`
- `@gosumo/catalog` — `searchCatalog()` for pricing and availability
- `@gosumo/booking` — `getAvailableSlots()` for appointment queries
- `@gosumo/payment` — `getPaymentLink()` to include in responses
- `@gosumo/order` — `getOrderStatus()` for order inquiry intents
- `@gosumo/tenant` — `getAIConfig()`, `getPolicies()`
- Anthropic SDK — LLM calls
- Qdrant client — vector search and upsert
- BullMQ — async job processing queue
- Redis — embedding cache (TTL 24h), in-progress job deduplication

### Test Strategy

**Unit tests:**
- `intent-classifier.spec.ts` — mock LLM; test each intent category with sample messages
- `confidence-calculator.spec.ts` — test formula with all combinations; verify hard overrides force <50
- `response-parser.spec.ts` — test parsing valid structured output; test malformed response handling
- `rag-retriever.spec.ts` — mock Qdrant; test query construction and result ranking

**Integration tests:**
- Full pipeline: ingest FAQ → process relevant question → correct intent, RAG context used, response generated
- Confidence routing: high confidence message → auto-executed; ambiguous → draft; legal mention → escalated

**Test scenarios:**
- "What's the price of X?" — product in catalog → data_availability=1, policy_clarity=1 → high confidence
- "What's the price of X?" — product NOT in catalog → hard override → confidence <50 → escalate
- Customer says "I'll sue you" → legal action hard override → confidence <50 → immediate escalation
- Same message processed twice → deduplicated via BullMQ job ID → processed once
- RAG retrieval: 10 matching chunks → only top 5 returned, sorted by similarity score

### Key Business Rules

```
confidence = (data_availability × 0.5) + (policy_clarity × 0.5)
```

**Hard overrides (force confidence to 0, regardless of formula):**
- Price requested but item not in catalog
- Refund requested but exceeds policy limit (`maxRefundAmountPaise`)
- Customer message contains legal threat keywords
- Loop detected: >3 consecutive exchanges with identical intent classification
- Client sentiment score below configured threshold

- AI **cannot** invent prices, policies, availability, or product details — all factual claims must come from RAG-retrieved business data or catalog queries
- System prompts are hardened against prompt injection — customer message is wrapped in `<customer_message>` tags and explicitly marked as untrusted input
- Every LLM call must include a `max_tokens` limit to prevent runaway costs
- Token usage (prompt + completion) must be logged per decision for cost tracking

### Error Handling

| Error | Behavior |
|---|---|
| LLM API timeout (>8s) | Retry once; if still fails → escalate conversation |
| Qdrant unavailable | Proceed without RAG; confidence calculator penalizes `data_availability` |
| Intent classification fails | Default to `UNKNOWN` intent; escalate |
| Response parsing fails | Log raw response; escalate with note |
| Context assembly fails (missing catalog/booking data) | Proceed with available context; log warning |

---

## 8. Module: `client-intelligence`

**Package:** `@gosumo/client-intelligence` · **Path:** `apps/api/src/modules/client-intelligence/`

### Purpose

The `client-intelligence` module builds and maintains rich profiles of each business's customers (end-clients). It processes every inbound message to extract facts (name mentions, preferences, constraints), tracks sentiment over time, computes a churn risk score, estimates lifetime value (LTV), and stores structured client profiles that are read by `ai-engine` to personalize responses. It also maintains the Qdrant vector index for semantic search over client interaction history, enabling the AI to recall relevant past conversations when responding. This module turns raw message volume into actionable intelligence.

### Public Interface

```typescript
export interface IClientIntelligenceService {
  // Profile management
  findOrCreateClient(businessId: string, dto: FindOrCreateClientDto): Promise<ClientProfileDto>;
  getClientProfile(businessId: string, clientId: string): Promise<ClientProfileDto>;
  getClientByExternalId(businessId: string, externalId: string, channelType: ChannelType): Promise<ClientProfileDto | null>;
  updateClientProfile(businessId: string, clientId: string, dto: UpdateClientProfileDto): Promise<ClientProfileDto>;
  listClients(businessId: string, query: ListClientsQueryDto): Promise<PaginatedResult<ClientProfileDto>>;
  mergeClients(businessId: string, primaryId: string, secondaryId: string): Promise<ClientProfileDto>;

  // Fact extraction (called after each message)
  extractAndStoreFacts(businessId: string, clientId: string, messageId: string, text: string): Promise<ClientFactDto[]>;

  // Sentiment tracking
  recordSentiment(businessId: string, clientId: string, messageId: string, score: number): Promise<void>;
  getClientSentimentTrend(businessId: string, clientId: string, days: number): Promise<SentimentTrendDto>;

  // Intelligence scores
  getChurnScore(businessId: string, clientId: string): Promise<ChurnScoreDto>;
  getLTVEstimate(businessId: string, clientId: string): Promise<LTVEstimateDto>;
  refreshIntelligenceScores(businessId: string, clientId: string): Promise<void>;

  // Summary for AI context
  getClientSummaryForAI(businessId: string, clientId: string): Promise<ClientAISummaryDto>;
}
```

### Internal Structure

```
client-intelligence/
├── client-intelligence.module.ts
├── client-intelligence.controller.ts  # GET /clients, GET /clients/:id, PUT /clients/:id
├── client-intelligence.service.ts
├── client-intelligence.repository.ts
├── services/
│   ├── fact-extraction.service.ts     # LLM call to extract structured facts from message text
│   ├── sentiment-analysis.service.ts  # Scores each message; rolling average
│   ├── churn-scoring.service.ts       # Recency/frequency/monetary RFM model
│   └── ltv-estimation.service.ts      # Order history + booking history → LTV
├── dto/
│   ├── find-or-create-client.dto.ts   # externalId, channelType, displayName?
│   ├── client-profile.dto.ts          # Full client shape with all scores
│   ├── update-client-profile.dto.ts   # name, email, phone, preferences (JSONB)
│   ├── client-fact.dto.ts             # factType, value, confidence, messageId
│   ├── sentiment-trend.dto.ts         # daily scores array, average, trend direction
│   ├── churn-score.dto.ts             # score (0-100), riskLevel, lastInteractionDays, factors
│   ├── ltv-estimate.dto.ts            # estimatedLTVPaise, totalSpentPaise, orderCount
│   └── client-ai-summary.dto.ts       # Compact summary string for AI prompt injection
└── workers/
    └── intelligence-refresh.worker.ts # BullMQ worker for async score recalculation
```

### Domain Events

**Emits:**
- `client.profile.updated` — payload: `{ businessId, clientId, changedFields }`
- `client.churn.risk` — payload: `{ businessId, clientId, churnScore, riskLevel }`
- `client.fact.extracted` — payload: `{ businessId, clientId, factType, value }`

**Listens to:**
- `message.received` → extract facts, record sentiment (async via BullMQ)
- `order.delivered` → update LTV, reset churn risk
- `booking.created` → update last engagement date
- `payment.success` → update LTV

### Database Tables Owned

```sql
clients             -- id, businessId, externalId, channelType, displayName,
                    --   phone, email, language, preferences (JSONB),
                    --   firstSeenAt, lastSeenAt, totalConversations,
                    --   averageSentimentScore, churnScore, churnRiskLevel,
                    --   estimatedLTVPaise, totalSpentPaise, orderCount,
                    --   qdrantPointId, createdAt, updatedAt
client_facts        -- id, clientId, businessId, factType, value, confidence,
                    --   sourceMessageId, extractedAt
client_sentiment    -- id, clientId, businessId, messageId, score (-1.0 to 1.0), recordedAt
-- Qdrant collection: 'client_profiles_{businessId}' — vector per client, payload = summary
```

### Dependencies

- `@gosumo/shared` — ChannelType, ClientEvents
- `@gosumo/message` — reads message text for fact extraction
- Qdrant client — upsert and search client profile vectors
- BullMQ — async intelligence refresh jobs
- Anthropic SDK — fact extraction LLM calls (lightweight, cheap model)

### Test Strategy

**Unit tests:**
- `fact-extraction.service.spec.ts` — mock LLM; test fact types (name, city, preference, allergy, budget)
- `churn-scoring.service.spec.ts` — test RFM model with various recency/frequency combos
- `sentiment-analysis.service.spec.ts` — test score normalization, rolling average

**Integration tests:**
- New message from unknown client → client created, fact extraction queued, sentiment recorded
- Two channels, same phone number → detect as same client via `mergeClients`
- Client with no orders in 90 days → churn score > 70, risk event emitted

**Test scenarios:**
- Message "My name is Priya, I'm vegetarian and from Pune" → facts: name=Priya, dietary=vegetarian, city=Pune
- 5 consecutive negative messages → sentiment trend negative → churn risk triggered
- Order placed → LTV updated → churn score drops
- `getClientSummaryForAI` → compact string ≤300 chars suitable for prompt injection

### Key Business Rules

- One client record per (businessId, externalId, channelType). If same phone appears on WhatsApp and SMS, merge is manual (operator-triggered)
- Sentiment scores range from -1.0 (very negative) to +1.0 (very positive); 0 is neutral
- Churn risk levels: LOW (0-30), MEDIUM (31-60), HIGH (61-80), CRITICAL (81-100)
- Churn risk event fires only when score crosses a level boundary (not on every update)
- Facts with confidence < 0.7 are stored but excluded from the AI summary
- LTV is recalculated after every order payment or booking payment

### Error Handling

| Error | Behavior |
|---|---|
| Fact extraction LLM timeout | Skip extraction; log warning; process message normally |
| Qdrant upsert failure | Log error; continue; retry on next message from client |
| Merge of non-existent client | 404 error |
| Sentiment score out of range | Clamp to [-1.0, 1.0] |

---

## 9. Module: `catalog`

**Package:** `@gosumo/catalog` · **Path:** `apps/api/src/modules/catalog/`

### Purpose

The `catalog` module manages a business's products and services — the things customers can buy, book, or inquire about. It supports a hierarchical structure: categories contain items, items have variants (size/color/etc.), and items can be grouped into packages (bundles). Each item has a price, inventory count (optional), and rich metadata. The catalog is the primary data source the AI reads when answering pricing and availability questions — it must always return accurate data and never allow the AI to guess prices. It also supports pricing rules (flat discounts, percentage discounts, festive pricing) per item or category.

### Public Interface

```typescript
export interface ICatalogService {
  // Categories
  createCategory(businessId: string, dto: CreateCategoryDto): Promise<CategoryDto>;
  updateCategory(businessId: string, categoryId: string, dto: UpdateCategoryDto): Promise<CategoryDto>;
  deleteCategory(businessId: string, categoryId: string): Promise<void>;
  listCategories(businessId: string): Promise<CategoryDto[]>;

  // Items
  createItem(businessId: string, dto: CreateItemDto): Promise<CatalogItemDto>;
  updateItem(businessId: string, itemId: string, dto: UpdateItemDto): Promise<CatalogItemDto>;
  deleteItem(businessId: string, itemId: string): Promise<void>;
  getItem(businessId: string, itemId: string): Promise<CatalogItemDto>;
  listItems(businessId: string, query: ListItemsQueryDto): Promise<PaginatedResult<CatalogItemDto>>;
  searchCatalog(businessId: string, query: string, limit?: number): Promise<CatalogItemDto[]>;

  // Variants
  addVariant(businessId: string, itemId: string, dto: CreateVariantDto): Promise<VariantDto>;
  updateVariant(businessId: string, variantId: string, dto: UpdateVariantDto): Promise<VariantDto>;
  deleteVariant(businessId: string, variantId: string): Promise<void>;

  // Packages
  createPackage(businessId: string, dto: CreatePackageDto): Promise<PackageDto>;
  updatePackage(businessId: string, packageId: string, dto: UpdatePackageDto): Promise<PackageDto>;
  deletePackage(businessId: string, packageId: string): Promise<void>;
  listPackages(businessId: string): Promise<PackageDto[]>;

  // Pricing
  getEffectivePrice(businessId: string, itemId: string, variantId?: string, quantity?: number): Promise<EffectivePriceDto>;
  createPricingRule(businessId: string, dto: CreatePricingRuleDto): Promise<PricingRuleDto>;
  updatePricingRule(businessId: string, ruleId: string, dto: UpdatePricingRuleDto): Promise<PricingRuleDto>;
  deletePricingRule(businessId: string, ruleId: string): Promise<void>;

  // Inventory
  updateStock(businessId: string, itemId: string, variantId: string | null, delta: number): Promise<void>;
  getStockLevel(businessId: string, itemId: string, variantId?: string): Promise<StockLevelDto>;
}
```

### Internal Structure

```
catalog/
├── catalog.module.ts
├── catalog.controller.ts         # /catalog/categories, /catalog/items, /catalog/packages
├── catalog.service.ts
├── catalog.repository.ts
├── services/
│   ├── pricing.service.ts        # Effective price calculation with rule stacking
│   └── inventory.service.ts      # Stock tracking, low-stock alerts
├── dto/
│   ├── create-category.dto.ts    # name, slug, description, parentCategoryId?
│   ├── create-item.dto.ts        # name, sku, description, basePricePaise, categoryId,
│   │                             #   images[], taxRate, hsn, unit, trackInventory
│   ├── catalog-item.dto.ts       # Full item with variants, currentStock, effectivePrice
│   ├── create-variant.dto.ts     # name, attributes (JSONB: {size:L, color:Red}), priceDeltaPaise, sku
│   ├── create-package.dto.ts     # name, itemIds[], packagePricePaise, description
│   ├── create-pricing-rule.dto.ts # ruleType (FLAT|PERCENT), value, scope (ITEM|CATEGORY|GLOBAL),
│   │                              #   targetId?, validFrom, validTo, minQuantity?
│   └── effective-price.dto.ts    # basePricePaise, finalPricePaise, appliedRules[], taxAmountPaise
└── catalog.constants.ts          # MAX_VARIANTS_PER_ITEM=50, MAX_IMAGES_PER_ITEM=10
```

### Domain Events

**Emits:**
- `catalog.item.created` — payload: `{ businessId, itemId, sku, categoryId }`
- `catalog.item.updated` — payload: `{ businessId, itemId, changedFields }`
- `catalog.stock.low` — payload: `{ businessId, itemId, variantId, currentStock, threshold }`
- `catalog.stock.out` — payload: `{ businessId, itemId, variantId }`

**Listens to:**
- `order.created` — decrement stock for ordered items
- `order.cancelled` — restock cancelled items

### Database Tables Owned

```sql
catalog_categories  -- id, businessId, name, slug, description, parentCategoryId, sortOrder, isActive
catalog_items       -- id, businessId, categoryId, name, slug, sku, description,
                    --   basePricePaise, taxRate, hsnCode, unit,
                    --   images (JSONB), trackInventory, isActive, createdAt
catalog_variants    -- id, itemId, businessId, name, sku, attributes (JSONB),
                    --   priceDeltaPaise, stockQuantity, isActive
catalog_packages    -- id, businessId, name, description, packagePricePaise, isActive
catalog_package_items -- packageId, itemId, quantity
pricing_rules       -- id, businessId, ruleType, value, scope, targetId,
                    --   validFrom, validTo, minQuantity, isActive, priority
```

### Dependencies

- `@gosumo/shared` — currency utils (paiseToRupees), tenant isolation
- `@gosumo/tenant` — validates businessId

### Test Strategy

**Unit tests:**
- `pricing.service.spec.ts` — test rule stacking: global 10% off + item flat -50 + festive 5% → correct final price
- `inventory.service.spec.ts` — test stock decrement, increment, negative stock prevention

**Integration tests:**
- Create category → create item → add variants → search catalog → returns correct item
- Pricing rule with date range → before/after/during range → correct price each time
- Order placed → stock decremented → stock restored on cancel

**Test scenarios:**
- `searchCatalog("silk saree")` → returns items with "silk" and "saree" in name/description
- `getEffectivePrice` with no active pricing rules → returns base price
- Item with `trackInventory=false` → `updateStock` is no-op, `getStockLevel` returns null
- Delete category with active items → 422 error

### Key Business Rules

- All prices stored in **paise** (integer). Never store as float.
- SKU must be unique per business; auto-generated if not provided
- Pricing rule priority: ITEM > CATEGORY > GLOBAL; multiple rules of same scope stack additively up to configured discount cap
- Items with `trackInventory=true` cannot be ordered when stock=0 (unless `allowBackorder=true`)
- Tax rate is stored as percentage (e.g., 18 for 18% GST); tax amount computed on effective price
- Soft delete only — items are deactivated, not removed, to preserve order history references

### Error Handling

| Error | HTTP | Message |
|---|---|---|
| Item not found | 404 | `CATALOG_ITEM_NOT_FOUND` |
| SKU duplicate | 409 | `SKU_ALREADY_EXISTS` |
| Delete category with active items | 422 | `CATEGORY_HAS_ACTIVE_ITEMS` |
| Stock would go negative | 422 | `INSUFFICIENT_STOCK` |
| Invalid pricing rule dates | 422 | `INVALID_PRICING_RULE_DATES` |

---

## 10. Module: `booking`

**Package:** `@gosumo/booking` · **Path:** `apps/api/src/modules/booking/`

### Purpose

The `booking` module manages appointment scheduling for service-based businesses (salons, clinics, tutors, fitness trainers, consultants). It owns the concept of services (bookable catalog items), staff availability, time slots, and appointment lifecycle. It integrates with Google Calendar to sync bookings bidirectionally — a booking created in GoSumo appears in the staff member's calendar, and a block created in Google Calendar removes availability from GoSumo. The AI uses this module to answer "when are you available?" questions and to complete bookings end-to-end without human intervention.

### Public Interface

```typescript
export interface IBookingService {
  // Service configuration
  createBookingService(businessId: string, dto: CreateBookingServiceDto): Promise<BookingServiceDto>;
  updateBookingService(businessId: string, serviceId: string, dto: UpdateBookingServiceDto): Promise<BookingServiceDto>;
  listBookingServices(businessId: string): Promise<BookingServiceDto[]>;

  // Availability
  getAvailableSlots(businessId: string, dto: GetSlotsQueryDto): Promise<SlotDto[]>;
  blockSlot(businessId: string, dto: BlockSlotDto): Promise<void>;
  unblockSlot(businessId: string, slotId: string): Promise<void>;

  // Appointments
  createBooking(businessId: string, dto: CreateBookingDto): Promise<BookingDto>;
  getBooking(businessId: string, bookingId: string): Promise<BookingDto>;
  listBookings(businessId: string, query: ListBookingsQueryDto): Promise<PaginatedResult<BookingDto>>;
  cancelBooking(businessId: string, bookingId: string, dto: CancelBookingDto): Promise<BookingDto>;
  rescheduleBooking(businessId: string, bookingId: string, dto: RescheduleBookingDto): Promise<BookingDto>;
  confirmBooking(businessId: string, bookingId: string): Promise<BookingDto>;

  // Google Calendar
  connectGoogleCalendar(businessId: string, staffMemberId: string, dto: GoogleCalendarAuthDto): Promise<void>;
  syncGoogleCalendar(businessId: string, staffMemberId: string): Promise<SyncResultDto>;
  disconnectGoogleCalendar(businessId: string, staffMemberId: string): Promise<void>;

  // Reminders
  scheduleReminders(businessId: string, bookingId: string): Promise<void>;
}
```

### Internal Structure

```
booking/
├── booking.module.ts
├── booking.controller.ts           # /bookings, /bookings/slots, /bookings/services
├── booking.service.ts
├── booking.repository.ts
├── services/
│   ├── availability.service.ts     # Slot computation from schedule - blocked slots - existing bookings
│   ├── google-calendar.service.ts  # OAuth2 + Calendar API integration
│   └── reminder.service.ts         # BullMQ delayed jobs for 24h/1h reminders
├── dto/
│   ├── create-booking-service.dto.ts # name, durationMinutes, bufferMinutes, catalogItemId?, price
│   ├── get-slots-query.dto.ts       # serviceId, staffMemberId?, date, timezone
│   ├── slot.dto.ts                  # startTime, endTime, staffMemberId, available
│   ├── create-booking.dto.ts        # clientId, serviceId, staffMemberId, startTime, notes?
│   ├── booking.dto.ts               # Full booking with client, service, staff, status, paymentStatus
│   ├── cancel-booking.dto.ts        # reason, notifyClient (bool)
│   ├── reschedule-booking.dto.ts    # newStartTime
│   └── google-calendar-auth.dto.ts  # authCode, redirectUri
└── workers/
    └── booking-reminder.worker.ts   # BullMQ worker sending reminder messages
```

### Domain Events

**Emits:**
- `booking.created` — payload: `{ businessId, bookingId, clientId, serviceId, startTime, staffMemberId }`
- `booking.cancelled` — payload: `{ businessId, bookingId, reason, cancelledBy }`
- `booking.rescheduled` — payload: `{ businessId, bookingId, oldStartTime, newStartTime }`
- `booking.confirmed` — payload: `{ businessId, bookingId }`
- `booking.reminder` — payload: `{ businessId, bookingId, minutesBefore }`

**Listens to:**
- `payment.success` — auto-confirm booking if payment is received
- `booking.reminder` (self) — trigger reminder message via `channel-adapter`

### Database Tables Owned

```sql
booking_services    -- id, businessId, name, durationMinutes, bufferMinutes,
                    --   catalogItemId, pricePaise, color, isActive
staff_schedules     -- id, businessId, staffMemberId, dayOfWeek, startTime, endTime, timezone
slot_blocks         -- id, businessId, staffMemberId, startTime, endTime, reason, createdBy
bookings            -- id, businessId, clientId, serviceId, staffMemberId,
                    --   startTime, endTime, status (PENDING|CONFIRMED|CANCELLED|COMPLETED|NO_SHOW),
                    --   notes, cancellationReason, cancelledBy, paymentStatus,
                    --   googleCalendarEventId, remindersSent (JSONB), createdAt
google_calendar_tokens -- staffMemberId, businessId, accessToken (encrypted), refreshToken (encrypted),
                       --   expiresAt, calendarId
```

### Dependencies

- `@gosumo/shared` — BookingStatus, timezone utils
- `@gosumo/catalog` — validates `catalogItemId` for booking services
- `@gosumo/tenant` — business timezone, business hours
- `@gosumo/channel-adapter` — sending reminder messages
- Google Calendar API (`googleapis`) — event creation and sync
- BullMQ — delayed reminder jobs

### Test Strategy

**Unit tests:**
- `availability.service.spec.ts` — test slot generation with schedules, blocks, existing bookings
- `google-calendar.service.spec.ts` — mock Google API; test token refresh, event creation

**Integration tests:**
- Create booking → slot becomes unavailable → cancel → slot re-appears
- Google Calendar sync: create external event → slot blocked in GoSumo
- Reminder job: booking 24h away → reminder message sent → 1h later → second reminder

**Test scenarios:**
- `getAvailableSlots` for service with 30-min duration + 10-min buffer → slots are 40 min apart
- Double-booking same slot → 409 error
- Book outside business hours → 422 error
- Reschedule to already-booked slot → 409 error
- Cancel booking 1h before → policy check (if cancellation window configured)

### Key Business Rules

- Slot duration = service `durationMinutes` + `bufferMinutes` (buffer prevents back-to-back bookings)
- Slots are generated in real-time from schedule — no pre-generated slot records
- Google Calendar sync runs on: booking created, booking cancelled, daily background job
- If Google Calendar OAuth token expired, refresh silently; if refresh fails, send HITL alert
- Reminder messages sent 24h and 1h before appointment via customer's channel
- A booking is auto-confirmed when associated payment is received; otherwise stays PENDING for 24h then auto-cancels

### Error Handling

| Error | HTTP | Message |
|---|---|---|
| Slot unavailable | 409 | `SLOT_UNAVAILABLE` |
| Outside business hours | 422 | `OUTSIDE_BUSINESS_HOURS` |
| Service not found | 404 | `BOOKING_SERVICE_NOT_FOUND` |
| Google Calendar not connected | 422 | `CALENDAR_NOT_CONNECTED` |
| Cancellation window exceeded | 422 | `CANCELLATION_WINDOW_EXCEEDED` |

---

## 11. Module: `payment`

**Package:** `@gosumo/payment` · **Path:** `apps/api/src/modules/payment/`

### Purpose

The `payment` module handles all money movement in GoSumo — creating Razorpay payment links that are sent to customers via messaging, receiving and verifying payment webhooks, recording transactions, processing refunds, and handling cash-on-delivery (COD) confirmation flows. It is the only module that communicates directly with Razorpay. It emits payment events that `order` listens to for status transitions. The module enforces refund policy limits read from `tenant` settings and maintains a complete audit trail of all financial transactions.

### Public Interface

```typescript
export interface IPaymentService {
  // Payment link creation (primary flow)
  createPaymentLink(businessId: string, dto: CreatePaymentLinkDto): Promise<PaymentLinkDto>;
  getPaymentLink(businessId: string, paymentLinkId: string): Promise<PaymentLinkDto>;
  cancelPaymentLink(businessId: string, paymentLinkId: string): Promise<void>;
  listPaymentLinks(businessId: string, query: ListPaymentLinksQueryDto): Promise<PaginatedResult<PaymentLinkDto>>;

  // Transactions
  getTransaction(businessId: string, transactionId: string): Promise<TransactionDto>;
  listTransactions(businessId: string, query: ListTransactionsQueryDto): Promise<PaginatedResult<TransactionDto>>;

  // Refunds
  initiateRefund(businessId: string, dto: InitiateRefundDto): Promise<RefundDto>;
  getRefund(businessId: string, refundId: string): Promise<RefundDto>;

  // COD
  confirmCODPayment(businessId: string, orderId: string, dto: ConfirmCODDto): Promise<TransactionDto>;

  // Webhook handler (called by controller; validates Razorpay signature)
  handleRazorpayWebhook(payload: Buffer, signature: string): Promise<void>;

  // Summary for AI context
  getPaymentSummaryForOrder(businessId: string, orderId: string): Promise<PaymentSummaryDto>;
}
```

### Internal Structure

```
payment/
├── payment.module.ts
├── payment.controller.ts        # POST /webhooks/razorpay, POST /payment-links, GET /transactions
├── payment.service.ts
├── payment.repository.ts
├── services/
│   ├── razorpay.service.ts      # Razorpay SDK wrapper (createLink, verifyWebhook, refund)
│   └── refund.service.ts        # Refund policy check, initiation, status tracking
├── dto/
│   ├── create-payment-link.dto.ts # orderId?, clientId, amountPaise, description, expiryMinutes?
│   ├── payment-link.dto.ts        # id, url, shortUrl, amountPaise, status, expiresAt, razorpayId
│   ├── transaction.dto.ts         # id, type, amountPaise, currency, status, method, paidAt
│   ├── initiate-refund.dto.ts     # transactionId, amountPaise, reason
│   ├── refund.dto.ts              # id, transactionId, amountPaise, status, razorpayRefundId, processedAt
│   ├── confirm-cod.dto.ts         # collectedBy, collectedAt, notes?
│   └── payment-summary.dto.ts     # totalPaid, refunded, outstanding, transactions[]
└── payment.constants.ts          # RAZORPAY_WEBHOOK_SECRET, PAYMENT_LINK_EXPIRY_MINUTES=1440
```

### Domain Events

**Emits:**
- `payment.created` — payload: `{ businessId, paymentLinkId, orderId?, amountPaise }`
- `payment.success` — payload: `{ businessId, transactionId, paymentLinkId, orderId?, amountPaise, method }`
- `payment.failed` — payload: `{ businessId, paymentLinkId, orderId?, reason }`
- `payment.refund.initiated` — payload: `{ businessId, refundId, transactionId, amountPaise }`
- `payment.refund.completed` — payload: `{ businessId, refundId, transactionId, amountPaise }`

**Listens to:**
- `order.created` — auto-create payment link if payment type is ONLINE

### Database Tables Owned

```sql
payment_links       -- id, businessId, clientId, orderId?, razorpayPaymentLinkId,
                    --   amountPaise, currency, description, status, shortUrl, url,
                    --   expiresAt, paidAt, createdAt
transactions        -- id, businessId, clientId, orderId?, paymentLinkId?,
                    --   type (PAYMENT|REFUND|COD), amountPaise, currency,
                    --   status, paymentMethod, razorpayPaymentId,
                    --   razorpayOrderId, gatewayResponse (JSONB),
                    --   paidAt, failedAt, createdAt
refunds             -- id, businessId, transactionId, amountPaise, reason, status,
                    --   razorpayRefundId, requestedBy, requestedAt, processedAt, failedReason
```

### Dependencies

- `@gosumo/shared` — PaymentStatus, PaymentMethod, currency utils
- `@gosumo/tenant` — `getPolicies()` for max refund amount
- `@gosumo/order` — validates orderId, updates order payment status
- Razorpay Node.js SDK — payment link creation, webhook verification, refund initiation

### Test Strategy

**Unit tests:**
- `razorpay.service.spec.ts` — mock Razorpay SDK; test createLink, verifyWebhook, refund
- `refund.service.spec.ts` — test policy enforcement: refund amount > policy limit → rejected
- Webhook signature verification: valid, invalid, tampered → correct accept/reject

**Integration tests:**
- Create payment link → receive Razorpay webhook (mock) → `payment.success` emitted → order updated
- Initiate refund within policy → Razorpay called → refund record created
- Refund exceeds policy → error without Razorpay call

**Test scenarios:**
- Payment link created for ₹500 → customer pays → `payment.success` with transactionId
- Payment link expires → status = EXPIRED → attempt payment → rejected
- Partial refund (₹200 of ₹500) → allowed if within policy window
- Duplicate Razorpay webhook delivery → idempotent → transaction not duplicated
- COD order confirmed → COD transaction created with `method: COD`

### Key Business Rules

- Razorpay webhook signature MUST be verified with HMAC-SHA256 before processing any event
- Refund window and max amount come from `business_policies.refundWindowDays` and `maxRefundAmountPaise`
- Refund amount can never exceed the original transaction amount
- Refund requests that exceed policy limits are rejected and routed to HITL for manual approval
- COD payments are recorded as transactions but have no gateway ID — they are confirmed by staff
- Payment links expire after 24h by default (configurable per business)
- All Razorpay API credentials stored encrypted; never logged

### Error Handling

| Error | HTTP | Message |
|---|---|---|
| Invalid webhook signature | 400 | `INVALID_WEBHOOK_SIGNATURE` |
| Refund exceeds policy | 422 | `REFUND_EXCEEDS_POLICY` |
| Refund window expired | 422 | `REFUND_WINDOW_EXPIRED` |
| Payment link expired | 422 | `PAYMENT_LINK_EXPIRED` |
| Razorpay API error | 502 | `PAYMENT_GATEWAY_ERROR` |
| Transaction not found | 404 | `TRANSACTION_NOT_FOUND` |

---

## 12. Module: `order`

**Package:** `@gosumo/order` · **Path:** `apps/api/src/modules/order/`

### Purpose

The `order` module manages the complete lifecycle of customer orders from creation through fulfillment. An order is created when a customer confirms they want to purchase one or more catalog items. The module coordinates between `payment` (collecting money), `shipping` (dispatching goods), and `catalog` (validating items and prices). It owns the order state machine and serves as the coordination hub for e-commerce flows. Orders for services (bookings) flow through `booking` instead — `order` handles only physical goods.

### Public Interface

```typescript
export interface IOrderService {
  // Order CRUD
  createOrder(businessId: string, dto: CreateOrderDto): Promise<OrderDto>;
  getOrder(businessId: string, orderId: string): Promise<OrderDto>;
  listOrders(businessId: string, query: ListOrdersQueryDto): Promise<PaginatedResult<OrderDto>>;
  cancelOrder(businessId: string, orderId: string, dto: CancelOrderDto): Promise<OrderDto>;
  updateOrderStatus(businessId: string, orderId: string, dto: UpdateOrderStatusDto): Promise<OrderDto>;

  // Fulfillment
  markPacked(businessId: string, orderId: string, dto: MarkPackedDto): Promise<OrderDto>;
  createShipment(businessId: string, orderId: string, dto: CreateShipmentDto): Promise<OrderDto>;

  // For AI context
  getOrderStatusForClient(businessId: string, clientId: string, orderId?: string): Promise<OrderStatusSummaryDto>;
  getRecentOrdersForClient(businessId: string, clientId: string, limit?: number): Promise<OrderDto[]>;
}
```

### Internal Structure

```
order/
├── order.module.ts
├── order.controller.ts          # /orders CRUD
├── order.service.ts
├── order.repository.ts
├── state-machine/
│   ├── order.states.ts          # PENDING_PAYMENT | CONFIRMED | PACKED | SHIPPED | DELIVERED | CANCELLED | REFUNDED
│   └── order.transitions.ts     # Valid transitions; throws on invalid
├── dto/
│   ├── create-order.dto.ts      # clientId, items[]{itemId, variantId?, quantity}, deliveryAddress,
│   │                            #   fulfillmentType (DELIVERY|PICKUP), paymentMethod (ONLINE|COD), notes?
│   ├── order.dto.ts             # Full order with items, address, amounts, status history, shipment
│   ├── update-order-status.dto.ts # status, reason?
│   ├── mark-packed.dto.ts       # packageCount, weight, notes?
│   ├── create-shipment.dto.ts   # logisticsProvider, trackingId? (or auto-create via shipping module)
│   └── order-status-summary.dto.ts # Compact summary for AI context
└── order.constants.ts           # AUTO_CANCEL_PENDING_PAYMENT_HOURS = 24
```

### Domain Events

**Emits:**
- `order.created` — payload: `{ businessId, orderId, clientId, items[], totalAmountPaise, paymentMethod }`
- `order.confirmed` — payload: `{ businessId, orderId, confirmedAt }`
- `order.cancelled` — payload: `{ businessId, orderId, reason, cancelledBy }`
- `order.packed` — payload: `{ businessId, orderId, packageCount }`
- `order.shipped` — payload: `{ businessId, orderId, trackingId, provider }`
- `order.delivered` — payload: `{ businessId, orderId, deliveredAt }`

**Listens to:**
- `payment.success` → transition PENDING_PAYMENT → CONFIRMED
- `payment.refund.completed` → transition CANCELLED → REFUNDED
- `shipping.delivered` → transition SHIPPED → DELIVERED

### Database Tables Owned

```sql
orders              -- id, businessId, clientId, orderNumber (unique per business),
                    --   status, fulfillmentType, paymentMethod, paymentStatus,
                    --   subtotalPaise, taxAmountPaise, shippingAmountPaise, totalAmountPaise,
                    --   discountAmountPaise, deliveryAddress (JSONB), notes,
                    --   cancelledAt, cancelReason, cancelledBy, createdAt, updatedAt
order_items         -- id, orderId, businessId, catalogItemId, variantId?,
                    --   itemName, variantName?, sku, quantity,
                    --   unitPricePaise, totalPricePaise, taxRate
order_status_history -- id, orderId, businessId, fromStatus, toStatus,
                     --   changedBy, reason, createdAt
```

### Dependencies

- `@gosumo/shared` — OrderStatus, FulfillmentType, currency utils
- `@gosumo/catalog` — `getItem()`, `getEffectivePrice()`, `updateStock()`
- `@gosumo/payment` — `createPaymentLink()`, `getPaymentSummaryForOrder()`
- `@gosumo/shipping` — `createShipment()` when order is packed

### Test Strategy

**Unit tests:**
- `order.state-machine.spec.ts` — test all valid and invalid transitions
- `order.service.spec.ts` — test order total calculation with multiple items, tax, discount

**Integration tests:**
- Create order → payment link auto-created → webhook received → status CONFIRMED
- Create COD order → mark packed → create shipment → mark delivered → status DELIVERED
- Cancel order in CONFIRMED state → refund initiated → status REFUNDED

**Test scenarios:**
- Order with 3 items → correct line item totals, subtotal, tax, grand total
- Order item out of stock → 422 error before order created
- Attempt CONFIRMED → SHIPPED transition (skipping PACKED) → error
- Order auto-cancelled after 24h without payment → `order.cancelled` event emitted

### Key Business Rules

- Orders generate a human-readable `orderNumber` (e.g., `ORD-2024-00042`) unique per business
- Stock is reserved (decremented) at order creation; restored on cancellation
- Prices snapshot at order creation time — catalog price changes don't affect existing orders
- Auto-cancel: PENDING_PAYMENT orders not paid within 24h are auto-cancelled via BullMQ job
- COD orders skip payment link creation and go directly to CONFIRMED (pending delivery)
- Tax is calculated on the effective price (after discounts), not the base price

### Error Handling

| Error | HTTP | Message |
|---|---|---|
| Item not found | 404 | `CATALOG_ITEM_NOT_FOUND` |
| Insufficient stock | 422 | `INSUFFICIENT_STOCK` |
| Invalid status transition | 422 | `INVALID_ORDER_STATUS_TRANSITION` |
| Order not found | 404 | `ORDER_NOT_FOUND` |
| Cannot cancel shipped order | 422 | `ORDER_ALREADY_SHIPPED` |

---

## 13. Module: `shipping`

**Package:** `@gosumo/shipping` · **Path:** `apps/api/src/modules/shipping/`

### Purpose

The `shipping` module abstracts all logistics operations behind a single interface. It integrates with Shiprocket (primary Indian logistics aggregator that connects FedEx, Delhivery, BlueDart, etc.) to create shipments, fetch tracking updates, initiate returns, and manage delivery addresses. Businesses configure their pickup address and preferred logistics partners; the module auto-selects the cheapest/fastest provider based on destination. It polls or webhooks for tracking updates and pushes status changes to `order` and customers via messaging.

### Public Interface

```typescript
export interface IShippingService {
  // Shipment lifecycle
  createShipment(businessId: string, dto: CreateShipmentDto): Promise<ShipmentDto>;
  getShipment(businessId: string, shipmentId: string): Promise<ShipmentDto>;
  cancelShipment(businessId: string, shipmentId: string, reason: string): Promise<void>;
  listShipments(businessId: string, query: ListShipmentsQueryDto): Promise<PaginatedResult<ShipmentDto>>;

  // Tracking
  getTrackingInfo(businessId: string, shipmentId: string): Promise<TrackingInfoDto>;
  refreshTracking(businessId: string, shipmentId: string): Promise<TrackingInfoDto>;

  // Returns
  createReturn(businessId: string, dto: CreateReturnDto): Promise<ReturnDto>;
  getReturn(businessId: string, returnId: string): Promise<ReturnDto>;

  // Address
  validateAddress(address: AddressDto): Promise<AddressValidationDto>;
  getServiceability(fromPincode: string, toPincode: string): Promise<ServiceabilityDto>;
  estimateShippingCost(businessId: string, dto: EstimateShippingDto): Promise<ShippingEstimateDto[]>;

  // Configuration
  updatePickupAddress(businessId: string, dto: AddressDto): Promise<void>;
  getPickupAddress(businessId: string): Promise<AddressDto | null>;

  // Webhook handler
  handleShiprocketWebhook(payload: Record<string, unknown>): Promise<void>;
}
```

### Internal Structure

```
shipping/
├── shipping.module.ts
├── shipping.controller.ts         # /shipments, /tracking/:id, /returns, /webhooks/shiprocket
├── shipping.service.ts
├── shipping.repository.ts
├── adapters/
│   ├── shiprocket.adapter.ts      # Shiprocket REST API calls; token refresh
│   └── shiprocket.mapper.ts       # Shiprocket response → ShipmentDto
├── services/
│   └── tracking-poll.service.ts   # BullMQ repeatable job polling tracking status
├── dto/
│   ├── create-shipment.dto.ts     # orderId, packageWeight, dimensions, toAddress, codAmount?
│   ├── shipment.dto.ts            # id, orderId, trackingId, provider, status, estimatedDelivery
│   ├── tracking-info.dto.ts       # trackingEvents[]{timestamp, location, status, description}
│   ├── create-return.dto.ts       # shipmentId, reason, pickupDate, returnAddress
│   ├── return.dto.ts              # id, shipmentId, status, trackingId, scheduledPickup
│   ├── address.dto.ts             # name, phone, line1, line2, city, state, pincode, country
│   ├── estimate-shipping.dto.ts   # weight, dimensions, toPincode, codAmount?
│   └── shipping-estimate.dto.ts   # provider, pricePaise, estimatedDays, serviceType
└── shipping.constants.ts          # TRACKING_POLL_INTERVAL_MINUTES = 60
```

### Domain Events

**Emits:**
- `shipping.created` — payload: `{ businessId, shipmentId, orderId, trackingId, provider }`
- `shipping.shipped` — payload: `{ businessId, shipmentId, orderId, dispatchedAt }`
- `shipping.out_for_delivery` — payload: `{ businessId, shipmentId, orderId }`
- `shipping.delivered` — payload: `{ businessId, shipmentId, orderId, deliveredAt }`
- `shipping.failed` — payload: `{ businessId, shipmentId, orderId, reason }`
- `shipping.return.created` — payload: `{ businessId, returnId, shipmentId }`

**Listens to:**
- `order.packed` → `createShipment()` if auto-ship is configured

### Database Tables Owned

```sql
shipments           -- id, businessId, orderId, shiprocketShipmentId, shiprocketOrderId,
                    --   trackingId, provider, status, toAddress (JSONB),
                    --   packageWeight, dimensions (JSONB), codAmountPaise,
                    --   estimatedDeliveryDate, actualDeliveryDate,
                    --   labelUrl, manifestUrl, createdAt, updatedAt
tracking_events     -- id, shipmentId, businessId, eventTimestamp, location,
                    --   status, description, rawPayload (JSONB), createdAt
returns             -- id, businessId, shipmentId, orderId, reason, status,
                    --   trackingId, scheduledPickup, returnAddress (JSONB), createdAt
shipping_config     -- businessId (PK), pickupAddress (JSONB), preferredProviders (text[]),
                    --   shiprocketToken (encrypted), shiprocketTokenExpiresAt
```

### Dependencies

- `@gosumo/shared` — address types, currency utils
- `@gosumo/order` — validates orderId, triggers order status updates
- `@gosumo/tenant` — business pickup address config
- Shiprocket REST API — shipment creation, tracking, returns
- BullMQ — tracking poll repeatable jobs

### Test Strategy

**Unit tests:**
- `shiprocket.mapper.spec.ts` — test every Shiprocket status → GoSumo status mapping
- `tracking-poll.service.spec.ts` — mock Shiprocket; test polling, status change detection

**Integration tests:**
- Create shipment → Shiprocket called → tracking ID stored
- Tracking poll: new event from Shiprocket → `tracking_events` record → event emitted

**Test scenarios:**
- Shiprocket token expired → refresh → retry original request
- Webhook with DELIVERED status → `shipping.delivered` emitted → order marked DELIVERED
- Address validation: invalid pincode → `isDeliverable: false`
- Multiple providers returned → sorted by cost ascending

### Key Business Rules

- Shiprocket authentication uses email/password login → get token → token cached in Redis with TTL
- If Shiprocket is unavailable, shipment creation queued for retry (BullMQ) — order stays PACKED
- Tracking updates trigger customer notifications only on status SHIPPED and DELIVERED
- COD amount must be set on shipment if order payment method is COD
- Returns can only be created for orders in DELIVERED status

### Error Handling

| Error | Behavior |
|---|---|
| Shiprocket API down | Queue for retry with exponential backoff; alert via HITL |
| Invalid pincode | Return `isDeliverable: false`; surface to customer via AI |
| Shipment already cancelled | 409 `SHIPMENT_ALREADY_CANCELLED` |
| Token refresh failure | Trigger `shipping.credential.error` event → HITL alert |

---

## 14. Module: `campaign`

**Package:** `@gosumo/campaign` · **Path:** `apps/api/src/modules/campaign/`

### Purpose

The `campaign` module enables businesses to proactively reach out to customers at scale. It supports two types: one-off broadcast campaigns (e.g., "Diwali sale announcement to all customers") and lifecycle campaigns (automated sequences triggered by customer behavior, e.g., "3 days after booking → send satisfaction survey"). It handles audience segmentation (filter clients by last purchase date, LTV tier, churn score, tags), message scheduling, delivery via `channel-adapter`, and delivery tracking. Campaigns use WhatsApp/SMS templates for broadcast; they must comply with channel-specific template approval requirements.

### Public Interface

```typescript
export interface ICampaignService {
  // Campaign management
  createCampaign(businessId: string, dto: CreateCampaignDto): Promise<CampaignDto>;
  getCampaign(businessId: string, campaignId: string): Promise<CampaignDto>;
  listCampaigns(businessId: string, query: ListCampaignsQueryDto): Promise<PaginatedResult<CampaignDto>>;
  updateCampaign(businessId: string, campaignId: string, dto: UpdateCampaignDto): Promise<CampaignDto>;
  deleteCampaign(businessId: string, campaignId: string): Promise<void>;

  // Scheduling & execution
  scheduleCampaign(businessId: string, campaignId: string, dto: ScheduleCampaignDto): Promise<CampaignDto>;
  pauseCampaign(businessId: string, campaignId: string): Promise<CampaignDto>;
  resumeCampaign(businessId: string, campaignId: string): Promise<CampaignDto>;
  cancelCampaign(businessId: string, campaignId: string): Promise<CampaignDto>;
  triggerCampaign(businessId: string, campaignId: string): Promise<void>; // immediate send

  // Audience
  previewAudience(businessId: string, dto: AudienceFilterDto): Promise<AudiencePreviewDto>;

  // Analytics
  getCampaignStats(businessId: string, campaignId: string): Promise<CampaignStatsDto>;

  // Lifecycle triggers (called by event handlers)
  triggerLifecycleCampaign(businessId: string, dto: LifecycleTriggerDto): Promise<void>;
}
```

### Internal Structure

```
campaign/
├── campaign.module.ts
├── campaign.controller.ts       # /campaigns CRUD, /campaigns/:id/schedule, /campaigns/:id/stats
├── campaign.service.ts
├── campaign.repository.ts
├── services/
│   ├── audience.service.ts      # Segment client lists from client-intelligence filters
│   ├── scheduler.service.ts     # BullMQ delayed/repeating job management
│   └── delivery.service.ts      # Per-recipient send + track delivery status
├── dto/
│   ├── create-campaign.dto.ts   # name, type (BROADCAST|LIFECYCLE), channelType,
│   │                            #   templateName, templateParams (JSONB), audienceFilter
│   ├── campaign.dto.ts          # Full campaign with status, recipientCount, stats
│   ├── schedule-campaign.dto.ts # scheduledAt (datetime)
│   ├── audience-filter.dto.ts   # churnRiskLevel?, ltvTier?, lastOrderDays?, tags?, channelType?
│   ├── audience-preview.dto.ts  # estimatedCount, sampleClients[]
│   ├── lifecycle-trigger.dto.ts # triggerEvent, clientId, payload
│   └── campaign-stats.dto.ts    # sent, delivered, read, failed, optOut
└── workers/
    ├── campaign-send.worker.ts  # BullMQ worker: iterate recipients, send via channel-adapter
    └── campaign-lifecycle.worker.ts # Lifecycle trigger evaluator
```

### Domain Events

**Emits:**
- `campaign.triggered` — payload: `{ businessId, campaignId, recipientCount, scheduledAt }`
- `campaign.sent` — payload: `{ businessId, campaignId, clientId, messageId, channel }`
- `campaign.completed` — payload: `{ businessId, campaignId, sent, failed, deliveryRate }`

**Listens to:**
- `booking.created` → check lifecycle campaigns triggered by `BOOKING_CREATED`
- `order.delivered` → check lifecycle campaigns triggered by `ORDER_DELIVERED`
- `client.churn.risk` → check lifecycle campaigns triggered by `CHURN_RISK`

### Database Tables Owned

```sql
campaigns           -- id, businessId, name, type, status, channelType,
                    --   templateName, templateParams (JSONB),
                    --   audienceFilter (JSONB), estimatedRecipients,
                    --   scheduledAt, startedAt, completedAt,
                    --   triggerEvent (for lifecycle campaigns),
                    --   delayHours (for lifecycle: send X hours after trigger),
                    --   createdBy, createdAt
campaign_recipients -- id, campaignId, businessId, clientId, status,
                    --   messageId, sentAt, deliveredAt, readAt, failedReason
```

### Dependencies

- `@gosumo/shared` — CampaignStatus, CampaignType, ChannelType
- `@gosumo/client-intelligence` — `listClients()` with filters for audience segmentation
- `@gosumo/channel-adapter` — `sendTemplate()` for each recipient
- `@gosumo/message` — `storeOutboundMessage()` for campaign messages
- BullMQ — delayed send jobs, rate-limited worker (respect channel send limits)

### Test Strategy

**Unit tests:**
- `audience.service.spec.ts` — test filter logic: churn risk HIGH + last order > 30 days → correct client list
- `delivery.service.spec.ts` — mock channel-adapter; test send, track, retry on failure

**Integration tests:**
- Create broadcast campaign → schedule → job fires at scheduledAt → all recipients receive message
- Lifecycle campaign: `ORDER_DELIVERED` event → matching campaign found → client receives follow-up after delay

**Test scenarios:**
- `previewAudience` with strict filters → count preview matches actual send count
- Campaign paused mid-send → remaining sends halted → resume → continues where left off
- Send to 1000 recipients → rate-limited to channel limits → all sent without hitting rate limit errors
- Recipient has opted out → skipped silently

### Key Business Rules

- Broadcast campaigns require a channel-approved template (templateName must exist on Meta/SMS provider)
- Send rate must respect channel limits: WhatsApp 80 msg/sec per phone number → BullMQ concurrency capped accordingly
- Opt-out is honored automatically: clients who replied with STOP/unsubscribe are excluded from all future campaigns
- Lifecycle campaigns fire at most once per client per trigger event per day (deduplication)
- Campaign can only be sent between business hours (configurable per campaign)
- Campaign budgets: STARTER plan — 500 sends/month, GROWTH — 5000, SCALE — unlimited

### Error Handling

| Error | Behavior |
|---|---|
| Template not found on channel | Reject campaign scheduling; `TEMPLATE_NOT_FOUND` |
| Channel rate limit hit | Exponential backoff; resume automatically |
| Client opt-out | Skip silently; increment `optOut` counter |
| Send failure for recipient | Retry 2x; if still failed → mark as FAILED, continue others |

---

## 15. Module: `hitl`

**Package:** `@gosumo/hitl` · **Path:** `apps/api/src/modules/hitl/`

### Purpose

The `hitl` (Human-in-the-Loop) module is the interface between AI decisions and human operators. When the AI's confidence is too low to auto-execute or when policy requires human approval, it creates a task that appears in the operator dashboard. Operators review AI-drafted responses, approve or reject them, take over conversations directly, or escalate further. The module also handles internal chat between staff members about specific conversations. It is the safety valve of the entire system — every AI decision that reaches a human comes through here.

### Public Interface

```typescript
export interface IHITLService {
  // Task management
  createTask(businessId: string, dto: CreateTaskDto): Promise<TaskDto>;
  getTask(businessId: string, taskId: string): Promise<TaskDto>;
  listTasks(businessId: string, query: ListTasksQueryDto): Promise<PaginatedResult<TaskDto>>;
  assignTask(businessId: string, taskId: string, userId: string): Promise<TaskDto>;
  resolveTask(businessId: string, taskId: string, dto: ResolveTaskDto): Promise<TaskDto>;

  // AI draft review
  approveDraft(businessId: string, taskId: string, dto: ApproveDraftDto): Promise<void>;
  rejectDraft(businessId: string, taskId: string, dto: RejectDraftDto): Promise<void>;
  editAndSendDraft(businessId: string, taskId: string, dto: EditDraftDto): Promise<void>;

  // Manual send (operator types response directly)
  sendManualResponse(businessId: string, dto: SendManualResponseDto): Promise<void>;

  // Internal chat (staff discussing a conversation)
  postInternalNote(businessId: string, dto: PostInternalNoteDto): Promise<InternalNoteDto>;
  getInternalNotes(businessId: string, conversationId: string): Promise<InternalNoteDto[]>;

  // Escalation
  escalateConversation(businessId: string, conversationId: string, dto: EscalateDto): Promise<TaskDto>;

  // Dashboard stats
  getTaskQueueStats(businessId: string): Promise<TaskQueueStatsDto>;
}
```

### Internal Structure

```
hitl/
├── hitl.module.ts
├── hitl.controller.ts           # /tasks CRUD, /tasks/:id/approve, /tasks/:id/reject,
│                                #   /conversations/:id/notes, /conversations/:id/escalate
├── hitl.service.ts
├── hitl.repository.ts
├── gateway/
│   └── hitl.gateway.ts          # Socket.IO gateway — pushes new tasks to dashboard in real-time
├── services/
│   ├── task-assignment.service.ts  # Round-robin or manual assignment to available operators
│   └── sla.service.ts              # Track response time SLAs; escalate stale tasks
├── dto/
│   ├── create-task.dto.ts       # conversationId, taskType, priority, draftDecisionId?,
│   │                            #   escalationReason?, dueAt?
│   ├── task.dto.ts              # Full task with conversation snippet, AI draft, assignee
│   ├── resolve-task.dto.ts      # resolution, notes?
│   ├── approve-draft.dto.ts     # send immediately (bool)
│   ├── reject-draft.dto.ts      # reason, feedback (used to regenerate)
│   ├── edit-draft.dto.ts        # editedResponse
│   ├── send-manual-response.dto.ts # conversationId, content, channelType
│   ├── post-internal-note.dto.ts # conversationId, text, mentionedUserIds?
│   └── task-queue-stats.dto.ts  # open, inProgress, slaBreached, avgResponseTimeMs
└── hitl.constants.ts            # SLA_FIRST_RESPONSE_MINUTES = 15, SLA_RESOLUTION_HOURS = 4
```

### Domain Events

**Emits:**
- `task.created` — payload: `{ businessId, taskId, conversationId, taskType, priority }`
- `task.assigned` — payload: `{ businessId, taskId, assignedTo }`
- `task.resolved` — payload: `{ businessId, taskId, resolution, resolvedBy }`
- `ai.response.approved` — payload: `{ businessId, taskId, decisionId, editedResponse? }`
- `ai.response.rejected` — payload: `{ businessId, taskId, decisionId, feedback }`

**Listens to:**
- `ai.response.generated` with `band: DRAFT_REVIEW` → `createTask()` with draft
- `ai.escalated` → `createTask()` with escalation type
- `conversation.escalated` → `createTask()` with ESCALATION type
- `task.created` → push real-time update via Socket.IO gateway

### Database Tables Owned

```sql
tasks               -- id, businessId, conversationId, taskType (DRAFT_REVIEW|ESCALATION|APPROVAL|MANUAL),
                    --   priority (LOW|MEDIUM|HIGH|URGENT), status (OPEN|IN_PROGRESS|RESOLVED|TIMED_OUT),
                    --   assigneeId, draftDecisionId, escalationReason,
                    --   resolvedBy, resolution, resolvedAt, dueAt, slaBreachedAt, createdAt
internal_notes      -- id, businessId, conversationId, authorId, text,
                    --   mentionedUserIds (text[]), createdAt
task_activity       -- id, taskId, businessId, actorId, action, metadata (JSONB), createdAt
```

### Dependencies

- `@gosumo/shared` — TaskStatus, TaskType, EscalationLevel
- `@gosumo/conversation` — `updateConversationStatus()` when task resolved
- `@gosumo/message` — `storeOutboundMessage()` when draft approved and sent
- `@gosumo/channel-adapter` — `sendMessage()` for approved responses
- `@gosumo/ai-engine` — `regenerateDraft()` when draft rejected with feedback
- Socket.IO — real-time task notifications to dashboard

### Test Strategy

**Unit tests:**
- `task-assignment.service.spec.ts` — round-robin assignment across available staff
- `sla.service.spec.ts` — tasks past dueAt → `slaBreachedAt` set, priority escalated

**Integration tests:**
- AI generates DRAFT_REVIEW decision → task created → operator approves → message sent → conversation moves to AI_HANDLING
- Escalation task created → assigned → operator sends manual response → task resolved → conversation RESOLVED

**Test scenarios:**
- Draft approved with no edits → original AI response sent
- Draft rejected with feedback → `ai-engine.regenerateDraft()` called → new draft created, new task updated
- Task SLA breach → task priority bumped to URGENT → Socket.IO notification to all online operators
- Internal note with @mention → mentioned user receives notification

### Key Business Rules

- Tasks have SLA timers: DRAFT_REVIEW tasks must be resolved within 15 minutes; ESCALATION within 4 hours
- SLA breach: task priority auto-escalates to URGENT, all online operators notified via Socket.IO
- A conversation can have at most one open HITL task at a time (prevents duplicate tasks for same conversation)
- When a draft is approved without edits, the exact AI-generated text is sent
- When a draft is edited, the edited version is stored as `finalResponse` and `generatedBy: HUMAN`
- Internal notes are never sent to the customer — they are visible only to staff on the dashboard

### Error Handling

| Error | HTTP | Message |
|---|---|---|
| Task not found | 404 | `TASK_NOT_FOUND` |
| Task already resolved | 409 | `TASK_ALREADY_RESOLVED` |
| Conversation has open task | 409 | `CONVERSATION_HAS_OPEN_TASK` |
| Draft not found for approval | 404 | `DRAFT_NOT_FOUND` |

---

## 16. Module: `analytics`

**Package:** `@gosumo/analytics` · **Path:** `apps/api/src/modules/analytics/`

### Purpose

The `analytics` module aggregates operational data from across the platform and serves it to the dashboard. It tracks the metrics that matter most to a small business: conversation volumes, AI autonomy rate (% resolved without human), response times, top customer intents, revenue from orders and bookings, campaign performance, and staff productivity. Data is pre-aggregated into time-series buckets (hourly/daily) by BullMQ background workers to keep dashboard queries fast. This module reads from other modules' tables but never writes to them — it is purely a read aggregator.

### Public Interface

```typescript
export interface IAnalyticsService {
  // Conversation analytics
  getConversationMetrics(businessId: string, query: MetricsQueryDto): Promise<ConversationMetricsDto>;
  getIntentBreakdown(businessId: string, query: MetricsQueryDto): Promise<IntentBreakdownDto[]>;
  getResponseTimeMetrics(businessId: string, query: MetricsQueryDto): Promise<ResponseTimeMetricsDto>;

  // AI performance
  getAutonomyMetrics(businessId: string, query: MetricsQueryDto): Promise<AutonomyMetricsDto>;
  getConfidenceDistribution(businessId: string, query: MetricsQueryDto): Promise<ConfidenceDistributionDto>;

  // Commerce analytics
  getOrderMetrics(businessId: string, query: MetricsQueryDto): Promise<OrderMetricsDto>;
  getRevenueTimeSeries(businessId: string, query: MetricsQueryDto): Promise<TimeSeriesDto[]>;
  getBookingMetrics(businessId: string, query: MetricsQueryDto): Promise<BookingMetricsDto>;

  // Campaign analytics
  getCampaignMetrics(businessId: string, query: MetricsQueryDto): Promise<CampaignMetricsDto>;

  // Staff performance
  getStaffMetrics(businessId: string, query: MetricsQueryDto): Promise<StaffMetricsDto[]>;

  // Client analytics
  getClientAcquisitionMetrics(businessId: string, query: MetricsQueryDto): Promise<ClientAcquisitionDto>;
  getClientRetentionMetrics(businessId: string, query: MetricsQueryDto): Promise<ClientRetentionDto>;

  // Dashboard summary
  getDashboardSummary(businessId: string): Promise<DashboardSummaryDto>;
}
```

### Internal Structure

```
analytics/
├── analytics.module.ts
├── analytics.controller.ts       # GET /analytics/conversations, /analytics/ai, /analytics/revenue,
│                                 #   /analytics/dashboard-summary
├── analytics.service.ts          # Reads from pre-aggregated tables or live queries for small ranges
├── analytics.repository.ts       # Complex SQL aggregation queries
├── aggregators/
│   ├── conversation.aggregator.ts # Aggregates conversation metrics into hourly/daily buckets
│   ├── ai.aggregator.ts          # AI decision metrics: autonomy rate, confidence distribution
│   ├── order.aggregator.ts       # Revenue, order counts, AOV
│   └── campaign.aggregator.ts    # Campaign delivery and engagement stats
├── dto/
│   ├── metrics-query.dto.ts      # dateFrom, dateTo, granularity (HOUR|DAY|WEEK|MONTH), channelType?
│   ├── conversation-metrics.dto.ts # total, resolved, escalated, avgResponseTimeMs, csat
│   ├── autonomy-metrics.dto.ts   # autoExecutedRate, draftReviewRate, escalationRate, totalDecisions
│   ├── order-metrics.dto.ts      # totalOrders, totalRevenuePaise, avgOrderValuePaise, cancelRate
│   ├── time-series.dto.ts        # [ {date, value} ]
│   └── dashboard-summary.dto.ts  # today's key numbers: conversations, autonomyRate, revenue, openTasks
└── workers/
    └── metrics-aggregation.worker.ts  # BullMQ repeating job: runs every hour
```

### Domain Events

**Emits:** none (analytics is read-only)

**Listens to:**
- `conversation.resolved` → update `analytics_daily_conversations`
- `ai.auto.executed` → update `analytics_daily_ai_decisions`
- `order.created`, `order.delivered` → update `analytics_daily_orders`
- `campaign.sent`, `campaign.completed` → update `analytics_daily_campaigns`
- `task.resolved` → update `analytics_daily_hitl`

### Database Tables Owned

```sql
analytics_daily_conversations  -- businessId, date, total, resolved, escalated, avgFirstResponseMs,
                               --   avgResolutionMs, csatAvg, byChannel (JSONB)
analytics_daily_ai_decisions   -- businessId, date, total, autoExecuted, draftReview, escalated,
                               --   avgConfidence, byIntent (JSONB), promptTokens, completionTokens
analytics_daily_orders         -- businessId, date, total, confirmed, cancelled, delivered,
                               --   totalRevenuePaise, avgOrderValuePaise
analytics_daily_campaigns      -- businessId, campaignId, date, sent, delivered, read, failed, optOut
analytics_daily_hitl           -- businessId, date, tasksCreated, tasksResolved, avgResolutionMs,
                               --   slaBreached, byStaff (JSONB)
```

### Dependencies

- `@gosumo/shared` — all event types (listener only)
- Reads (direct SQL, read-only) from: `conversations`, `ai_decisions`, `orders`, `campaign_recipients`, `tasks`, `messages`
- Redis — caching dashboard summary (TTL: 5 minutes)

### Test Strategy

**Unit tests:**
- `conversation.aggregator.spec.ts` — test time-bucket assignment, metric accumulation
- `analytics.service.spec.ts` — test date range queries, granularity grouping

**Integration tests:**
- Process 100 conversations with known mix of statuses → aggregation worker runs → `getDashboardSummary` returns correct counts
- Revenue query for WEEK granularity → returns 7 data points, correct sums

**Test scenarios:**
- `getDashboardSummary` — served from Redis cache on second call (< 5ms)
- Date range spanning month boundary → correct grouping
- Zero data for date range → returns empty arrays (not errors)
- Cross-tenant isolation: business A data not visible when querying as business B

### Key Business Rules

- Dashboard summary is cached in Redis for 5 minutes to handle burst traffic
- Autonomy rate = `autoExecuted / totalDecisions` × 100; the primary KPI for GoSumo's value proposition
- All monetary metrics returned in paise; frontend converts to rupees
- Date range queries capped at 365 days maximum
- Aggregation worker runs every hour; queries for last 2 hours to handle late-arriving events
- Analytics data is retained for 24 months (business compliance requirement)

### Error Handling

| Error | Behavior |
|---|---|
| Date range too large | 422 `DATE_RANGE_TOO_LARGE` |
| Aggregation worker failure | Log error; next run catches up (idempotent aggregation) |
| Cache miss on dashboard summary | Fall through to live query; cache result |
| No data in range | Return empty/zero metrics — never 404 |
