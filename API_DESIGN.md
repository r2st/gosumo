# GoSumo — REST API Design

> Version: v1 | Base URL: `https://api.gosumo.ai/v1`
> Last updated: 2026-06-26

---

## Table of Contents

1. [API Conventions](#1-api-conventions)
   - [Versioning](#versioning)
   - [Authentication](#authentication)
   - [Error Format](#error-format)
   - [Pagination](#pagination)
   - [Rate Limiting](#rate-limiting)
   - [Common Query Parameters](#common-query-parameters)
2. [Auth](#2-auth)
3. [Tenant / Business](#3-tenant--business)
4. [Channels](#4-channels)
5. [Conversations](#5-conversations)
6. [Messages](#6-messages)
7. [AI Engine](#7-ai-engine)
8. [Client Intelligence](#8-client-intelligence)
9. [Catalog](#9-catalog)
10. [Booking](#10-booking)
11. [Payment](#11-payment)
12. [Orders](#12-orders)
13. [Shipping](#13-shipping)
14. [Campaigns](#14-campaigns)
15. [HITL (Human-in-the-Loop)](#15-hitl-human-in-the-loop)
16. [Analytics](#16-analytics)
17. [Admin (Internal)](#17-admin-internal)
18. [Webhooks (Inbound)](#18-webhooks-inbound)

---

## 1. API Conventions

### Versioning

All endpoints are prefixed with `/v1`. Breaking changes increment the major version to `/v2`. Non-breaking additions (new fields, new optional parameters) are made in-place without a version bump.

```
https://api.gosumo.ai/v1/{resource}
```

### Authentication

Every request (except webhooks and the auth login/refresh endpoints) must carry a Bearer JWT in the `Authorization` header:

```
Authorization: Bearer <access_token>
```

The JWT payload always contains:

```typescript
interface JwtPayload {
  sub: string;          // userId
  businessId: string;   // tenantId — all queries are scoped to this
  role: 'OWNER' | 'MANAGER' | 'STAFF';
  iat: number;
  exp: number;          // 15 minutes from issue
}
```

**Access tokens** expire in 15 minutes. Use the refresh token endpoint to obtain a new pair without re-login.

**Webhooks** are authenticated by HMAC-SHA256 signature, not Bearer tokens. See [Section 18](#18-webhooks-inbound).

### Error Format

All errors return a consistent envelope:

```typescript
interface ApiError {
  statusCode: number;           // HTTP status code
  error: string;                // Short machine-readable code, e.g. "NOT_FOUND"
  message: string;              // Human-readable description
  details?: Record<string, unknown>; // Validation errors, field-level info
  traceId: string;              // Sentry / Datadog trace ID for support
  timestamp: string;            // ISO 8601
}
```

**Example — validation error (422):**

```json
{
  "statusCode": 422,
  "error": "VALIDATION_ERROR",
  "message": "Request body validation failed",
  "details": {
    "fields": [
      { "field": "phone", "message": "must be a valid E.164 phone number" }
    ]
  },
  "traceId": "abc123def456",
  "timestamp": "2026-06-26T10:00:00.000Z"
}
```

**Standard HTTP status codes used:**

| Code | Meaning |
|------|---------|
| 200 | OK — successful read or update |
| 201 | Created — resource created |
| 204 | No Content — successful delete |
| 400 | Bad Request — malformed request syntax |
| 401 | Unauthorized — missing or invalid token |
| 403 | Forbidden — authenticated but insufficient role |
| 404 | Not Found — resource does not exist in this tenant |
| 409 | Conflict — duplicate resource or state conflict |
| 422 | Unprocessable Entity — business rule / validation failure |
| 429 | Too Many Requests — rate limit exceeded |
| 500 | Internal Server Error |
| 502 | Bad Gateway — upstream dependency failure |

### Pagination

All list endpoints support cursor-based pagination (preferred for real-time data) or offset pagination via query parameters.

**Request:**

```typescript
interface PaginationQuery {
  limit?: number;       // Max records per page. Default: 20, Max: 100
  cursor?: string;      // Opaque cursor from previous response (cursor-based)
  page?: number;        // Page number, 1-indexed (offset-based, when cursor absent)
}
```

**Response envelope for all list endpoints:**

```typescript
interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;          // Total record count (may be approximate for large sets)
    limit: number;
    cursor?: string;        // Next page cursor (null if last page)
    page?: number;          // Current page (offset mode)
    totalPages?: number;    // Total pages (offset mode)
    hasMore: boolean;
  };
}
```

### Rate Limiting

Rate limits are enforced per `businessId`. Response headers on every request:

```
X-RateLimit-Limit: 1000          # Requests allowed per window
X-RateLimit-Remaining: 847       # Requests remaining this window
X-RateLimit-Reset: 1719389400    # Unix timestamp when window resets
X-RateLimit-Window: 60           # Window size in seconds
```

On 429, the response body conforms to the standard error format and includes `Retry-After: <seconds>`.

**Tier limits (per business per 60s window):**

| Tier | Limit | Scope |
|------|-------|-------|
| Default REST | 1 000 req/min | All REST endpoints |
| Message send | 100 req/min | `POST /messages/send` |
| Campaign send | 10 req/min | `POST /campaigns/:id/send` |
| Webhook inbound | No limit | Handled separately |
| AI override | 200 req/min | `/ai-engine/*` |

### Common Query Parameters

Available on most list endpoints unless noted:

```typescript
interface CommonQueryParams {
  // Pagination
  limit?: number;
  cursor?: string;
  page?: number;

  // Sorting
  sortBy?: string;       // Field name, e.g. "createdAt", "name"
  sortOrder?: 'asc' | 'desc';  // Default: desc

  // Date range filtering
  from?: string;         // ISO 8601 date-time
  to?: string;           // ISO 8601 date-time

  // Full-text search (where supported)
  q?: string;

  // Status filter (domain-specific values)
  status?: string;
}
```

---

## 2. Auth

Base path: `/v1/auth`

All auth endpoints are **public** (no Bearer token required) except where noted.

### Shared Types

```typescript
interface TokenPair {
  accessToken: string;     // JWT, expires 15m
  refreshToken: string;    // Opaque token, expires 7d, stored in HttpOnly cookie too
  expiresIn: number;       // Seconds until access token expires
}

type UserRole = 'OWNER' | 'MANAGER' | 'STAFF';

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  businessId: string;
  avatarUrl?: string;
  twoFactorEnabled: boolean;
  createdAt: string;
}
```

---

### POST /auth/login

Authenticate with email + password. Returns token pair or prompts for 2FA.

**Request:**

```typescript
interface LoginRequest {
  email: string;
  password: string;
  deviceId?: string;       // For persistent sessions
}
```

**Response 200 — no 2FA enabled:**

```typescript
interface LoginResponse {
  user: AuthUser;
  tokens: TokenPair;
  requiresTwoFactor: false;
}
```

**Response 200 — 2FA required:**

```typescript
interface LoginTwoFactorRequired {
  requiresTwoFactor: true;
  twoFactorToken: string;   // Short-lived token to use in /auth/2fa/verify
  twoFactorMethods: Array<'TOTP' | 'SMS'>;
}
```

---

### POST /auth/2fa/verify

Complete login when 2FA is required.

**Request:**

```typescript
interface TwoFactorVerifyRequest {
  twoFactorToken: string;   // From /auth/login response
  code: string;             // 6-digit TOTP or SMS code
  method: 'TOTP' | 'SMS';
}
```

**Response 200:**

```typescript
interface LoginResponse {
  user: AuthUser;
  tokens: TokenPair;
  requiresTwoFactor: false;
}
```

---

### POST /auth/2fa/setup

**Auth required.** Initiate 2FA enrollment. Returns TOTP provisioning URI.

**Request:** (none)

**Response 200:**

```typescript
interface TwoFactorSetupResponse {
  secret: string;           // Base32 TOTP secret
  qrCodeUri: string;        // data URI for QR code image
  backupCodes: string[];    // 10 single-use backup codes
}
```

---

### POST /auth/2fa/confirm

**Auth required.** Confirm 2FA setup with a code, activating 2FA on the account.

**Request:**

```typescript
interface TwoFactorConfirmRequest {
  code: string;             // 6-digit TOTP code from authenticator app
}
```

**Response 200:**

```typescript
interface TwoFactorConfirmResponse {
  enabled: boolean;         // true
}
```

---

### POST /auth/2fa/disable

**Auth required (OWNER only).** Disable 2FA. Requires current password confirmation.

**Request:**

```typescript
interface TwoFactorDisableRequest {
  password: string;
}
```

**Response 204:** (no body)

---

### POST /auth/refresh

Exchange a refresh token for a new token pair. Refresh tokens rotate on each use.

**Request:**

```typescript
interface RefreshRequest {
  refreshToken: string;
}
```

**Response 200:** `TokenPair`

---

### POST /auth/logout

**Auth required.** Revoke the current refresh token.

**Request:**

```typescript
interface LogoutRequest {
  refreshToken: string;
}
```

**Response 204:** (no body)

---

### POST /auth/password/forgot

Request a password reset email.

**Request:**

```typescript
interface ForgotPasswordRequest {
  email: string;
}
```

**Response 200:**

```typescript
interface ForgotPasswordResponse {
  message: string;  // "If that email exists, a reset link has been sent"
}
```

---

### POST /auth/password/reset

Reset password using the token from the email.

**Request:**

```typescript
interface ResetPasswordRequest {
  token: string;
  newPassword: string;    // Min 8 chars, complexity enforced
}
```

**Response 200:** `TokenPair`

---

### GET /auth/me

**Auth required.** Get the current authenticated user.

**Response 200:** `AuthUser`

---

### PATCH /auth/me

**Auth required.** Update current user profile.

**Request:**

```typescript
interface UpdateProfileRequest {
  name?: string;
  avatarUrl?: string;
  language?: string;      // BCP-47, e.g. "en", "hi", "mr"
  timezone?: string;      // IANA, e.g. "Asia/Kolkata"
}
```

**Response 200:** `AuthUser`

---

### POST /auth/change-password

**Auth required.** Change password for the current user.

**Request:**

```typescript
interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
```

**Response 204:** (no body)

---

### Team Management

#### GET /auth/team

**Auth required (OWNER, MANAGER).** List all team members for this business.

**Response 200:** `PaginatedResponse<TeamMember>`

```typescript
interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
  avatarUrl?: string;
  lastActiveAt?: string;
  createdAt: string;
}
```

---

#### POST /auth/team/invite

**Auth required (OWNER, MANAGER).** Invite a team member by email.

**Request:**

```typescript
interface InviteTeamMemberRequest {
  email: string;
  name: string;
  role: 'MANAGER' | 'STAFF';
}
```

**Response 201:**

```typescript
interface InviteResponse {
  id: string;
  email: string;
  role: UserRole;
  inviteToken: string;   // Short-lived, for accepting the invite
  expiresAt: string;
}
```

---

#### PATCH /auth/team/:memberId/role

**Auth required (OWNER only).** Change a team member's role.

**Request:**

```typescript
interface UpdateRoleRequest {
  role: 'MANAGER' | 'STAFF';
}
```

**Response 200:** `TeamMember`

---

#### DELETE /auth/team/:memberId

**Auth required (OWNER only).** Remove a team member from the business.

**Response 204:** (no body)

---

#### POST /auth/team/accept-invite

Accept a team invitation. Public endpoint (no Bearer required).

**Request:**

```typescript
interface AcceptInviteRequest {
  inviteToken: string;
  password: string;       // Set password on account creation
  name?: string;          // Override invited name
}
```

**Response 200:** `TokenPair`

---

## 3. Tenant / Business

Base path: `/v1/business`

All endpoints require auth. OWNER role required for mutation endpoints unless noted.

### Shared Types

```typescript
interface BusinessProfile {
  id: string;
  name: string;
  slug: string;                // Unique URL-friendly identifier
  industry: string;            // e.g. "SALON", "RESTAURANT", "RETAIL", "COACHING"
  description?: string;
  logo?: string;               // URL
  address?: BusinessAddress;
  phone?: string;
  email?: string;
  website?: string;
  currency: string;            // ISO 4217, e.g. "INR"
  timezone: string;            // IANA timezone
  language: string;            // BCP-47
  country: string;             // ISO 3166-1 alpha-2
  onboardingStatus: 'PENDING' | 'IN_PROGRESS' | 'COMPLETE';
  subscriptionPlan: 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';
  subscriptionStatus: 'ACTIVE' | 'TRIAL' | 'PAST_DUE' | 'CANCELLED';
  trialEndsAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface BusinessAddress {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
}
```

---

### GET /business/me

Get the current business profile.

**Response 200:** `BusinessProfile`

---

### PATCH /business/me

Update business profile.

**Request:**

```typescript
interface UpdateBusinessRequest {
  name?: string;
  description?: string;
  logo?: string;
  address?: Partial<BusinessAddress>;
  phone?: string;
  email?: string;
  website?: string;
  currency?: string;
  timezone?: string;
  language?: string;
}
```

**Response 200:** `BusinessProfile`

---

### GET /business/settings

Get all business settings as a flat key-value map.

**Response 200:**

```typescript
interface BusinessSettings {
  // AI behavior
  aiAutonomyLevel: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  aiAutoReplyEnabled: boolean;
  aiConfidenceThreshold: number;       // 0-100, default: 70
  aiAutoExecuteThreshold: number;      // 0-100, default: 90

  // Office hours
  officeHoursEnabled: boolean;
  officeHours: OfficeHours;
  officeHoursTimezone: string;
  outsideHoursMessage: string;

  // Notifications
  emailNotificationsEnabled: boolean;
  smsNotificationsEnabled: boolean;
  notificationEmail?: string;
  notificationPhone?: string;

  // Customer experience
  defaultGreeting?: string;
  defaultSignoff?: string;
  messageDeliveryDelayMs: number;      // Simulated typing delay

  // HITL
  hitlEnabled: boolean;
  hitlAutoEscalateAfterMs: number;     // Default: 300000 (5 min)

  // Payment
  razorpayEnabled: boolean;
  codEnabled: boolean;

  // Booking
  bookingEnabled: boolean;
  defaultSlotDurationMinutes: number;

  // Misc
  updatedAt: string;
}

interface OfficeHours {
  monday?: DaySchedule;
  tuesday?: DaySchedule;
  wednesday?: DaySchedule;
  thursday?: DaySchedule;
  friday?: DaySchedule;
  saturday?: DaySchedule;
  sunday?: DaySchedule;
}

interface DaySchedule {
  isOpen: boolean;
  openTime: string;   // HH:MM, 24h
  closeTime: string;  // HH:MM, 24h
  breakStart?: string;
  breakEnd?: string;
}
```

---

### PATCH /business/settings

Update one or more business settings.

**Request:** `Partial<BusinessSettings>` (only changed keys)

**Response 200:** `BusinessSettings`

---

### GET /business/onboarding

Get onboarding checklist and progress.

**Response 200:**

```typescript
interface OnboardingStatus {
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETE';
  completionPercent: number;
  steps: OnboardingStep[];
}

interface OnboardingStep {
  key: string;                 // e.g. "CONNECT_WHATSAPP", "ADD_CATALOG_ITEM"
  title: string;
  description: string;
  completed: boolean;
  completedAt?: string;
  required: boolean;
  actionUrl?: string;          // Deep link to complete this step
}
```

---

### POST /business/onboarding/:stepKey/complete

Manually mark an onboarding step as complete (for steps that cannot be auto-detected).

**Response 200:** `OnboardingStatus`

---

## 4. Channels

Base path: `/v1/channels`

All endpoints require auth.

### Shared Types

```typescript
type ChannelType = 'WHATSAPP' | 'INSTAGRAM' | 'SMS' | 'WEB_CHAT' | 'EMAIL';

type ChannelStatus = 'CONNECTED' | 'DISCONNECTED' | 'PENDING' | 'ERROR' | 'RATE_LIMITED';

interface Channel {
  id: string;
  businessId: string;
  type: ChannelType;
  displayName: string;           // Human label e.g. "Main WhatsApp"
  status: ChannelStatus;
  accountId: string;             // Channel-specific account identifier
  capabilities: ChannelCapabilities;
  webhookUrl: string;            // GoSumo's inbound webhook URL for this channel
  metadata: Record<string, unknown>; // Channel-specific config (non-sensitive)
  connectedAt?: string;
  lastMessageAt?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface ChannelCapabilities {
  supportsText: boolean;
  supportsImages: boolean;
  supportsDocuments: boolean;
  supportsLocation: boolean;
  supportsInteractive: boolean;
  supportsTemplates: boolean;
  supportsVoice: boolean;
  maxMessageLength: number;
}
```

---

### GET /channels

List all connected channels for the business.

**Response 200:** `PaginatedResponse<Channel>`

---

### GET /channels/:channelId

Get a specific channel.

**Response 200:** `Channel`

---

### POST /channels/whatsapp/connect

Initiate WhatsApp Business API connection via Meta Embedded Signup.

**Request:**

```typescript
interface ConnectWhatsAppRequest {
  displayName: string;
  phoneNumberId: string;         // From Meta Business Manager
  wabaId: string;                // WhatsApp Business Account ID
  accessToken: string;           // Meta access token from Embedded Signup
}
```

**Response 201:**

```typescript
interface ChannelConnectionResponse {
  channel: Channel;
  webhookVerifyToken: string;   // Token to configure in Meta dashboard
}
```

---

### POST /channels/instagram/connect

Initiate Instagram DM channel connection.

**Request:**

```typescript
interface ConnectInstagramRequest {
  displayName: string;
  pageId: string;               // Facebook Page ID
  accessToken: string;          // Page access token
}
```

**Response 201:** `ChannelConnectionResponse`

---

### POST /channels/sms/connect

Configure SMS gateway connection.

**Request:**

```typescript
interface ConnectSmsRequest {
  displayName: string;
  provider: 'TWILIO' | 'KALEYRA' | 'MSG91';
  phoneNumber: string;          // E.164 format
  credentials: {
    accountSid?: string;
    authToken?: string;
    apiKey?: string;            // Provider-specific
    senderId?: string;
  };
}
```

**Response 201:** `ChannelConnectionResponse`

---

### POST /channels/web-chat/connect

Create an embeddable web chat widget.

**Request:**

```typescript
interface ConnectWebChatRequest {
  displayName: string;
  widgetConfig: {
    title: string;
    subtitle?: string;
    primaryColor: string;       // Hex color
    position: 'BOTTOM_RIGHT' | 'BOTTOM_LEFT';
    allowedOrigins: string[];   // CORS whitelist
  };
}
```

**Response 201:**

```typescript
interface WebChatConnectionResponse {
  channel: Channel;
  embedScript: string;          // Script tag HTML to paste on website
  widgetId: string;
}
```

---

### POST /channels/email/connect

Configure email channel via SMTP/IMAP.

**Request:**

```typescript
interface ConnectEmailRequest {
  displayName: string;
  fromEmail: string;
  fromName: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  };
  imap?: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
  };
}
```

**Response 201:** `ChannelConnectionResponse`

---

### PATCH /channels/:channelId

Update a channel's display name or config.

**Request:**

```typescript
interface UpdateChannelRequest {
  displayName?: string;
  metadata?: Record<string, unknown>;
}
```

**Response 200:** `Channel`

---

### DELETE /channels/:channelId

Disconnect and remove a channel.

**Response 204:** (no body)

---

### POST /channels/:channelId/test

Send a test message to verify channel connectivity.

**Request:**

```typescript
interface TestChannelRequest {
  recipientId: string;   // Phone number, email, etc.
}
```

**Response 200:**

```typescript
interface TestChannelResponse {
  success: boolean;
  message: string;
  latencyMs?: number;
}
```

---

### GET /channels/:channelId/health

Get real-time health and quota status for a channel.

**Response 200:**

```typescript
interface ChannelHealth {
  status: ChannelStatus;
  lastCheckedAt: string;
  messagesSentToday: number;
  messagesReceivedToday: number;
  dailyLimit?: number;
  rateLimitResetAt?: string;
  errorDetails?: string;
}
```

---

## 5. Conversations

Base path: `/v1/conversations`

All endpoints require auth.

### Shared Types

```typescript
type ConversationStatus = 'OPEN' | 'PENDING' | 'RESOLVED' | 'ESCALATED' | 'BOT_HANDLING';

interface Conversation {
  id: string;
  businessId: string;
  clientId: string;
  channelId: string;
  channelType: ChannelType;
  externalThreadId?: string;     // Channel-specific thread/chat ID
  status: ConversationStatus;
  subject?: string;              // Email subject or derived title
  assignedTo?: string;           // userId of assigned team member
  aiHandling: boolean;           // true if AI is currently handling
  lastMessageAt?: string;
  lastMessagePreview?: string;
  unreadCount: number;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  client?: ClientSummary;        // Embedded when ?include=client
}

interface ClientSummary {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  avatarUrl?: string;
  tags: string[];
}
```

---

### GET /conversations

List conversations with filtering.

**Query Parameters:**

```typescript
interface ConversationListQuery extends CommonQueryParams {
  status?: ConversationStatus | ConversationStatus[];
  channelId?: string;
  channelType?: ChannelType;
  assignedTo?: string;       // userId or "me" or "unassigned"
  aiHandling?: boolean;
  clientId?: string;
  tags?: string[];           // Comma-separated
  include?: 'client';        // Embed client summary
}
```

**Response 200:** `PaginatedResponse<Conversation>`

---

### GET /conversations/:conversationId

Get a single conversation with full details.

**Query Parameters:**

```typescript
interface GetConversationQuery {
  include?: Array<'client' | 'messages' | 'tasks'>;
}
```

**Response 200:** `Conversation & { messages?: Message[]; tasks?: HitlTask[] }`

---

### PATCH /conversations/:conversationId

Update conversation status, assignment, or tags.

**Request:**

```typescript
interface UpdateConversationRequest {
  status?: ConversationStatus;
  assignedTo?: string | null;    // userId or null to unassign
  tags?: string[];
  subject?: string;
}
```

**Response 200:** `Conversation`

---

### POST /conversations/:conversationId/resolve

Mark a conversation as resolved.

**Request:**

```typescript
interface ResolveConversationRequest {
  resolution?: string;           // Internal note about how it was resolved
  sendClosingMessage?: boolean;  // Whether to send a closing message to the client
  closingMessageText?: string;   // Custom closing message text
}
```

**Response 200:** `Conversation`

---

### POST /conversations/:conversationId/reopen

Reopen a resolved conversation.

**Request:**

```typescript
interface ReopenConversationRequest {
  reason?: string;
}
```

**Response 200:** `Conversation`

---

### POST /conversations/:conversationId/escalate

Escalate conversation to human team. Creates a HITL task.

**Request:**

```typescript
interface EscalateConversationRequest {
  reason: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  assignTo?: string;             // userId to assign directly
  notes?: string;
}
```

**Response 200:**

```typescript
interface EscalateResponse {
  conversation: Conversation;
  task: HitlTask;
}
```

---

### POST /conversations/:conversationId/assign

Assign a conversation to a team member.

**Request:**

```typescript
interface AssignConversationRequest {
  userId: string;
  notify?: boolean;              // Default: true — notify the assignee
}
```

**Response 200:** `Conversation`

---

### POST /conversations/:conversationId/tags

Add tags to a conversation.

**Request:**

```typescript
interface AddTagsRequest {
  tags: string[];
}
```

**Response 200:** `Conversation`

---

### DELETE /conversations/:conversationId/tags

Remove tags from a conversation.

**Request:**

```typescript
interface RemoveTagsRequest {
  tags: string[];
}
```

**Response 200:** `Conversation`

---

### GET /conversations/stats

Get aggregate stats on conversations (used for dashboard header cards).

**Query Parameters:** `from?`, `to?`, `channelId?`

**Response 200:**

```typescript
interface ConversationStats {
  open: number;
  pending: number;
  resolved: number;
  escalated: number;
  botHandling: number;
  avgResolutionTimeMs: number;
  avgFirstResponseTimeMs: number;
}
```

---

## 6. Messages

Base path: `/v1/messages`

All endpoints require auth.

### Shared Types

```typescript
type MessageDirection = 'INBOUND' | 'OUTBOUND';
type MessageStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

type MessageContentType =
  | 'TEXT'
  | 'IMAGE'
  | 'DOCUMENT'
  | 'LOCATION'
  | 'INTERACTIVE'
  | 'PAYMENT_LINK'
  | 'TEMPLATE'
  | 'VOICE'
  | 'VIDEO'
  | 'STICKER';

interface Message {
  id: string;
  conversationId: string;
  businessId: string;
  direction: MessageDirection;
  contentType: MessageContentType;
  content: MessageContent;
  status: MessageStatus;
  sentBy?: string;              // userId if sent by a human
  sentByAi: boolean;
  aiConfidence?: number;        // 0-100 if sent by AI
  externalId?: string;          // Channel-specific message ID
  timestamp: string;
  deliveredAt?: string;
  readAt?: string;
  failureReason?: string;
  replyToMessageId?: string;
  metadata: Record<string, unknown>;
}

// Content union — mirrors NormalizedMessage from Channel Adapter
type MessageContent =
  | { type: 'TEXT'; text: string }
  | { type: 'IMAGE'; url: string; caption?: string; mimeType: string; fileSize?: number }
  | { type: 'DOCUMENT'; url: string; filename: string; mimeType: string; fileSize?: number }
  | { type: 'LOCATION'; latitude: number; longitude: number; name?: string; address?: string }
  | { type: 'INTERACTIVE'; interactiveType: string; payload: Record<string, unknown> }
  | { type: 'PAYMENT_LINK'; url: string; amount: number; currency: string; orderId?: string }
  | { type: 'TEMPLATE'; templateName: string; parameters: Record<string, string> }
  | { type: 'VOICE'; url: string; durationSeconds?: number; mimeType: string }
  | { type: 'VIDEO'; url: string; caption?: string; mimeType: string; durationSeconds?: number };
```

---

### GET /conversations/:conversationId/messages

Get message history for a conversation. Returns in chronological order.

**Query Parameters:**

```typescript
interface MessageListQuery {
  limit?: number;      // Default: 50
  cursor?: string;     // For pagination
  before?: string;     // ISO date-time: messages before this time
  after?: string;      // ISO date-time: messages after this time
}
```

**Response 200:** `PaginatedResponse<Message>`

---

### POST /conversations/:conversationId/messages

Send a message in a conversation (human-initiated outbound).

**Request:**

```typescript
interface SendMessageRequest {
  content: MessageContent;
  replyToMessageId?: string;
  sendingChannelId?: string;   // Override channel (if conversation spans multiple)
}
```

**Response 201:** `Message`

Notable behavior:
- Automatically marks the conversation as `OPEN` if resolved.
- If a HITL task is pending on this conversation, sending a message resolves the draft.
- Emits `message.sent` domain event.

---

### POST /messages/send

Send a proactive message to a client (not in response to an inbound). Creates a conversation if none exists.

**Request:**

```typescript
interface ProactiveSendRequest {
  channelId: string;
  clientId?: string;             // One of clientId or recipient required
  recipient?: {
    externalId: string;          // Phone, email, IG handle
    displayName?: string;
  };
  content: MessageContent;
  conversationId?: string;       // Attach to existing conversation
}
```

**Response 201:**

```typescript
interface ProactiveSendResponse {
  message: Message;
  conversationId: string;
  isNewConversation: boolean;
}
```

---

### GET /messages/:messageId

Get a single message by ID.

**Response 200:** `Message`

---

### POST /messages/search

Full-text search across all messages for this business.

**Request:**

```typescript
interface MessageSearchRequest {
  q: string;
  channelId?: string;
  clientId?: string;
  contentType?: MessageContentType;
  from?: string;
  to?: string;
  limit?: number;               // Default: 20
  cursor?: string;
}
```

**Response 200:**

```typescript
interface MessageSearchResponse {
  results: Array<Message & { conversationId: string; highlightedText?: string }>;
  pagination: PaginatedResponse<unknown>['pagination'];
}
```

---

### POST /messages/:messageId/react

React to a message (where channel supports it).

**Request:**

```typescript
interface ReactToMessageRequest {
  emoji: string;    // Unicode emoji
}
```

**Response 200:** `Message`

---

### POST /conversations/:conversationId/note

Add an internal note to a conversation (visible to team, not sent to client).

**Request:**

```typescript
interface AddNoteRequest {
  text: string;
  mentions?: string[];   // userIds to notify
}
```

**Response 201:** `Message` (with `direction: 'INTERNAL'` note — non-standard direction)

---

## 7. AI Engine

Base path: `/v1/ai`

All endpoints require auth. OWNER or MANAGER role required for mutation endpoints.

### Shared Types

```typescript
type IntentType =
  | 'INQUIRY_PRODUCT'
  | 'INQUIRY_PRICE'
  | 'INQUIRY_AVAILABILITY'
  | 'BOOK_APPOINTMENT'
  | 'CANCEL_BOOKING'
  | 'PLACE_ORDER'
  | 'CANCEL_ORDER'
  | 'TRACK_ORDER'
  | 'REQUEST_REFUND'
  | 'PAYMENT_QUERY'
  | 'COMPLAINT'
  | 'COMPLIMENT'
  | 'GENERAL_INQUIRY'
  | 'OUT_OF_SCOPE'
  | 'ESCALATE_HUMAN';

interface AiDecision {
  messageId: string;
  conversationId: string;
  intent: IntentType;
  confidence: number;        // 0-100
  route: 'AUTO_EXECUTE' | 'DRAFT_REVIEW' | 'FULL_ESCALATION';
  reasoning: string;         // AI explanation of the decision
  generatedResponse?: string;
  triggeredRules: string[];  // Business rule IDs that influenced this
  contextUsed: {
    catalogItemsLoaded: number;
    historyTurnsLoaded: number;
    clientProfileUsed: boolean;
    ragChunksRetrieved: number;
  };
  processingTimeMs: number;
  createdAt: string;
}

interface BusinessRule {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  condition: string;         // Natural language condition
  action: string;            // Natural language action
  enabled: boolean;
  priority: number;          // Lower = higher priority
  triggerCount: number;
  lastTriggeredAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface SystemPrompt {
  id: string;
  businessId: string;
  slot: 'PERSONA' | 'CATALOG_CONTEXT' | 'POLICY' | 'TONE' | 'FALLBACK';
  content: string;
  version: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
```

---

### GET /ai/decisions

List AI decision log for a business, optionally filtered by conversation.

**Query Parameters:**

```typescript
interface AiDecisionListQuery extends CommonQueryParams {
  conversationId?: string;
  clientId?: string;
  intent?: IntentType;
  route?: AiDecision['route'];
  minConfidence?: number;
  maxConfidence?: number;
}
```

**Response 200:** `PaginatedResponse<AiDecision>`

---

### GET /ai/decisions/:messageId

Get the AI decision for a specific message.

**Response 200:** `AiDecision`

---

### POST /ai/decisions/:messageId/override

**Auth required (MANAGER, OWNER).** Override AI routing decision manually — force auto-execute or escalate.

**Request:**

```typescript
interface AiOverrideRequest {
  action: 'APPROVE_AND_SEND' | 'REJECT_AND_ESCALATE' | 'REJECT_AND_DISCARD';
  editedResponse?: string;    // If action is APPROVE_AND_SEND, optionally edit the response
  reason?: string;            // Internal note for audit trail
}
```

**Response 200:**

```typescript
interface AiOverrideResponse {
  decision: AiDecision;
  message?: Message;          // Sent message if action was APPROVE_AND_SEND
}
```

---

### GET /ai/confidence/thresholds

Get current confidence routing thresholds.

**Response 200:**

```typescript
interface ConfidenceThresholds {
  autoExecute: number;        // Default: 90
  draftReview: number;        // Default: 70
  // < draftReview = FULL_ESCALATION
}
```

---

### PATCH /ai/confidence/thresholds

Update confidence routing thresholds.

**Request:**

```typescript
interface UpdateThresholdsRequest {
  autoExecute?: number;       // 50-100
  draftReview?: number;       // 10-autoExecute
}
```

**Response 200:** `ConfidenceThresholds`

---

### GET /ai/prompts

Get all system prompt slots.

**Response 200:**

```typescript
interface PromptsResponse {
  prompts: SystemPrompt[];
}
```

---

### PATCH /ai/prompts/:slot

Update a system prompt slot.

**Request:**

```typescript
interface UpdatePromptRequest {
  content: string;
}
```

**Response 200:** `SystemPrompt`

Notable behavior: Previous version is archived and viewable in history. The AI uses the `active: true` version.

---

### GET /ai/prompts/:slot/history

Get version history for a prompt slot.

**Response 200:** `PaginatedResponse<SystemPrompt & { changedBy: string }>`

---

### POST /ai/prompts/:slot/rollback

Roll back a prompt slot to a previous version.

**Request:**

```typescript
interface RollbackPromptRequest {
  version: number;
}
```

**Response 200:** `SystemPrompt`

---

### GET /ai/rules

List all business rules.

**Query Parameters:** `enabled?` (boolean), `sortBy?`, `sortOrder?`

**Response 200:** `PaginatedResponse<BusinessRule>`

---

### POST /ai/rules

Create a new business rule.

**Request:**

```typescript
interface CreateBusinessRuleRequest {
  name: string;
  description?: string;
  condition: string;      // e.g. "Customer requests refund and order is under 7 days old"
  action: string;         // e.g. "Approve refund up to ₹500 and create refund request"
  priority?: number;      // Default: 100
  enabled?: boolean;      // Default: true
}
```

**Response 201:** `BusinessRule`

---

### PATCH /ai/rules/:ruleId

Update a business rule.

**Request:** `Partial<CreateBusinessRuleRequest>`

**Response 200:** `BusinessRule`

---

### DELETE /ai/rules/:ruleId

Delete a business rule.

**Response 204:** (no body)

---

### POST /ai/rules/:ruleId/test

Test a business rule against a sample message without sending anything.

**Request:**

```typescript
interface TestRuleRequest {
  sampleMessage: string;
  clientId?: string;           // Use real client context if provided
}
```

**Response 200:**

```typescript
interface TestRuleResponse {
  ruleTriggered: boolean;
  reasoning: string;
  simulatedAction?: string;
}
```

---

### GET /ai/stats

AI performance and autonomy stats.

**Query Parameters:** `from?`, `to?`

**Response 200:**

```typescript
interface AiStats {
  totalDecisions: number;
  autoExecuted: number;
  draftReviewed: number;
  escalated: number;
  autonomyRate: number;           // Percentage auto-executed without human touch
  avgConfidence: number;
  intentBreakdown: Record<IntentType, number>;
  overridesApproved: number;
  overridesRejected: number;
}
```

---

## 8. Client Intelligence

Base path: `/v1/clients`

All endpoints require auth.

### Shared Types

```typescript
type ClientSource = 'WHATSAPP' | 'INSTAGRAM' | 'SMS' | 'WEB_CHAT' | 'EMAIL' | 'MANUAL' | 'IMPORT';

interface Client {
  id: string;
  businessId: string;
  name: string;
  phone?: string;              // E.164
  email?: string;
  externalIds: Record<string, string>; // { WHATSAPP: "+91...", INSTAGRAM: "ig_user_id" }
  avatarUrl?: string;
  tags: string[];
  source: ClientSource;
  language?: string;
  timezone?: string;
  address?: ClientAddress;
  notes?: string;
  isBlocked: boolean;
  optedOutOfMarketing: boolean;
  createdAt: string;
  updatedAt: string;
  lastContactedAt?: string;
  intelligence?: ClientIntelligence; // Embedded when ?include=intelligence
}

interface ClientAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
}

interface ClientIntelligence {
  clientId: string;
  sentimentScore: number;          // -1 to 1
  sentimentLabel: 'VERY_NEGATIVE' | 'NEGATIVE' | 'NEUTRAL' | 'POSITIVE' | 'VERY_POSITIVE';
  churnRiskScore: number;          // 0-100
  churnRiskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  ltv: number;                     // Lifetime value in base currency (INR)
  totalOrders: number;
  totalSpend: number;
  avgOrderValue: number;
  preferredChannel?: ChannelType;
  preferredContactTime?: string;   // e.g. "MORNING", "EVENING"
  interests: string[];             // Inferred from conversations
  lastSentimentUpdatedAt?: string;
  updatedAt: string;
}
```

---

### GET /clients

Search and list clients.

**Query Parameters:**

```typescript
interface ClientListQuery extends CommonQueryParams {
  tags?: string[];
  source?: ClientSource;
  isBlocked?: boolean;
  churnRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  hasOrders?: boolean;
  include?: 'intelligence';
  q?: string;     // Name, phone, email search
}
```

**Response 200:** `PaginatedResponse<Client>`

---

### GET /clients/:clientId

Get a client profile.

**Query Parameters:** `include?: Array<'intelligence' | 'conversations' | 'orders' | 'bookings'>`

**Response 200:** `Client & { intelligence?: ClientIntelligence; conversations?: Conversation[]; orders?: Order[]; bookings?: Booking[] }`

---

### POST /clients

Create a client manually.

**Request:**

```typescript
interface CreateClientRequest {
  name: string;
  phone?: string;
  email?: string;
  tags?: string[];
  notes?: string;
  address?: ClientAddress;
  language?: string;
}
```

**Response 201:** `Client`

---

### PATCH /clients/:clientId

Update a client profile.

**Request:**

```typescript
interface UpdateClientRequest {
  name?: string;
  phone?: string;
  email?: string;
  tags?: string[];
  notes?: string;
  address?: Partial<ClientAddress>;
  language?: string;
  isBlocked?: boolean;
  optedOutOfMarketing?: boolean;
}
```

**Response 200:** `Client`

---

### DELETE /clients/:clientId

Delete a client (GDPR erasure). Anonymizes PII in historical records.

**Response 204:** (no body)

Notable behavior: Hard-deletes personal data (name, phone, email, address). Historical conversation content is replaced with `[DELETED]`. Order/payment records are retained with anonymized references for financial compliance.

---

### POST /clients/import

Bulk import clients from CSV.

**Request:** `multipart/form-data`

```typescript
interface ClientImportRequest {
  file: File;           // CSV with headers: name, phone, email, tags, notes
  skipDuplicates?: boolean;  // Default: true
  updateExisting?: boolean;  // Default: false
}
```

**Response 202:**

```typescript
interface ClientImportResponse {
  jobId: string;        // Poll /clients/import/:jobId for progress
  estimatedCount: number;
}
```

---

### GET /clients/import/:jobId

Get import job status.

**Response 200:**

```typescript
interface ClientImportStatus {
  jobId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'FAILED';
  totalRows: number;
  processedRows: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errors?: Array<{ row: number; message: string }>;
  completedAt?: string;
}
```

---

### GET /clients/:clientId/intelligence

Get detailed intelligence profile for a client.

**Response 200:** `ClientIntelligence`

---

### GET /clients/:clientId/timeline

Get a chronological activity timeline for a client.

**Query Parameters:** `limit?`, `cursor?`, `from?`, `to?`

**Response 200:**

```typescript
interface ClientTimeline {
  items: ClientTimelineItem[];
  pagination: PaginatedResponse<unknown>['pagination'];
}

type ClientTimelineItem =
  | { type: 'MESSAGE'; timestamp: string; data: { direction: MessageDirection; preview: string; conversationId: string } }
  | { type: 'ORDER'; timestamp: string; data: { orderId: string; status: string; amount: number } }
  | { type: 'BOOKING'; timestamp: string; data: { bookingId: string; status: string; serviceName: string } }
  | { type: 'PAYMENT'; timestamp: string; data: { paymentId: string; status: string; amount: number } }
  | { type: 'CAMPAIGN'; timestamp: string; data: { campaignId: string; campaignName: string; event: string } };
```

---

### POST /clients/tags

Bulk-add tags to multiple clients.

**Request:**

```typescript
interface BulkTagRequest {
  clientIds: string[];
  tags: string[];
}
```

**Response 200:**

```typescript
interface BulkTagResponse {
  updated: number;
}
```

---

### GET /clients/segments

List all client segments (auto-generated and custom).

**Response 200:**

```typescript
interface ClientSegment {
  id: string;
  name: string;
  description: string;
  type: 'AUTO' | 'CUSTOM';
  clientCount: number;
  filter: Record<string, unknown>;
  createdAt: string;
}

// Response
{ segments: ClientSegment[] }
```

---

## 9. Catalog

Base path: `/v1/catalog`

All endpoints require auth. Mutations require MANAGER or OWNER.

### Shared Types

```typescript
type CatalogItemType = 'PRODUCT' | 'SERVICE' | 'PACKAGE' | 'DIGITAL';

interface CatalogCategory {
  id: string;
  businessId: string;
  name: string;
  slug: string;
  description?: string;
  imageUrl?: string;
  parentId?: string;       // For subcategories
  sortOrder: number;
  isActive: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

interface CatalogItem {
  id: string;
  businessId: string;
  categoryId?: string;
  type: CatalogItemType;
  name: string;
  slug: string;
  description?: string;
  shortDescription?: string;
  imageUrls: string[];
  basePrice: number;           // In smallest currency unit (paise for INR)
  currency: string;
  discountPrice?: number;
  taxRate?: number;            // Percentage
  taxIncluded: boolean;
  sku?: string;
  hsn?: string;                // HSN code for GST (India)
  unit?: string;               // "kg", "piece", "hour", "session"
  isActive: boolean;
  isAvailable: boolean;        // Real-time availability (can differ from isActive)
  trackInventory: boolean;
  stockQuantity?: number;
  lowStockThreshold?: number;
  tags: string[];
  variants: CatalogVariant[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface CatalogVariant {
  id: string;
  itemId: string;
  name: string;                // e.g. "Large", "Red", "1 Hour Session"
  sku?: string;
  price: number;
  discountPrice?: number;
  stockQuantity?: number;
  isActive: boolean;
  attributes: Record<string, string>; // { size: "L", color: "Red" }
  imageUrl?: string;
}
```

---

### GET /catalog/categories

List all catalog categories.

**Query Parameters:** `isActive?`, `parentId?`

**Response 200:**

```typescript
interface CategoriesResponse {
  categories: CatalogCategory[];
  total: number;
}
```

---

### POST /catalog/categories

Create a category.

**Request:**

```typescript
interface CreateCategoryRequest {
  name: string;
  description?: string;
  imageUrl?: string;
  parentId?: string;
  sortOrder?: number;
  isActive?: boolean;
}
```

**Response 201:** `CatalogCategory`

---

### PATCH /catalog/categories/:categoryId

Update a category.

**Request:** `Partial<CreateCategoryRequest>`

**Response 200:** `CatalogCategory`

---

### DELETE /catalog/categories/:categoryId

Delete a category. Fails with 409 if any active items are in this category.

**Response 204:** (no body)

---

### GET /catalog/items

List catalog items.

**Query Parameters:**

```typescript
interface CatalogItemListQuery extends CommonQueryParams {
  categoryId?: string;
  type?: CatalogItemType;
  isActive?: boolean;
  isAvailable?: boolean;
  q?: string;
  minPrice?: number;
  maxPrice?: number;
  tags?: string[];
  lowStock?: boolean;    // Items at or below lowStockThreshold
}
```

**Response 200:** `PaginatedResponse<CatalogItem>`

---

### GET /catalog/items/:itemId

Get a catalog item with all variants.

**Response 200:** `CatalogItem`

---

### POST /catalog/items

Create a catalog item.

**Request:**

```typescript
interface CreateCatalogItemRequest {
  categoryId?: string;
  type: CatalogItemType;
  name: string;
  description?: string;
  shortDescription?: string;
  imageUrls?: string[];
  basePrice: number;
  currency?: string;
  discountPrice?: number;
  taxRate?: number;
  taxIncluded?: boolean;
  sku?: string;
  hsn?: string;
  unit?: string;
  isActive?: boolean;
  trackInventory?: boolean;
  stockQuantity?: number;
  lowStockThreshold?: number;
  tags?: string[];
  variants?: Omit<CatalogVariant, 'id' | 'itemId'>[];
}
```

**Response 201:** `CatalogItem`

---

### PATCH /catalog/items/:itemId

Update a catalog item.

**Request:** `Partial<CreateCatalogItemRequest>`

**Response 200:** `CatalogItem`

---

### DELETE /catalog/items/:itemId

Soft-delete (deactivate) a catalog item.

**Response 204:** (no body)

---

### POST /catalog/items/:itemId/variants

Add a variant to an existing item.

**Request:**

```typescript
interface CreateVariantRequest {
  name: string;
  sku?: string;
  price: number;
  discountPrice?: number;
  stockQuantity?: number;
  isActive?: boolean;
  attributes?: Record<string, string>;
  imageUrl?: string;
}
```

**Response 201:** `CatalogVariant`

---

### PATCH /catalog/items/:itemId/variants/:variantId

Update a variant.

**Request:** `Partial<CreateVariantRequest>`

**Response 200:** `CatalogVariant`

---

### DELETE /catalog/items/:itemId/variants/:variantId

Delete a variant.

**Response 204:** (no body)

---

### PATCH /catalog/items/bulk-availability

Update availability for multiple items at once (useful for end-of-day sold-out updates).

**Request:**

```typescript
interface BulkAvailabilityRequest {
  updates: Array<{
    itemId: string;
    isAvailable: boolean;
    stockQuantity?: number;
  }>;
}
```

**Response 200:**

```typescript
interface BulkAvailabilityResponse {
  updated: number;
}
```

---

### GET /catalog/packages

List bundled service/product packages.

**Response 200:** `PaginatedResponse<CatalogItem>` (type = PACKAGE)

---

### POST /catalog/packages

Create a package (bundle of items/services).

**Request:**

```typescript
interface CreatePackageRequest {
  name: string;
  description?: string;
  imageUrls?: string[];
  price: number;                  // Bundle price (usually discounted vs sum)
  components: Array<{
    itemId: string;
    variantId?: string;
    quantity: number;
  }>;
  isActive?: boolean;
}
```

**Response 201:** `CatalogItem`

---

## 10. Booking

Base path: `/v1/bookings`

All endpoints require auth.

### Shared Types

```typescript
type BookingStatus = 'CONFIRMED' | 'PENDING' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW' | 'RESCHEDULED';

interface Booking {
  id: string;
  businessId: string;
  clientId: string;
  catalogItemId: string;       // The service being booked
  variantId?: string;
  staffMemberId?: string;      // Assigned staff (optional)
  status: BookingStatus;
  startTime: string;           // ISO 8601
  endTime: string;             // ISO 8601
  timezone: string;
  durationMinutes: number;
  price: number;
  currency: string;
  paymentStatus: 'UNPAID' | 'PAID' | 'PARTIAL' | 'REFUNDED';
  orderId?: string;
  paymentId?: string;
  notes?: string;
  clientNotes?: string;        // Notes from the client
  reminderSent: boolean;
  googleEventId?: string;      // If synced to Google Calendar
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  cancelledAt?: string;
  cancelReason?: string;
  client?: ClientSummary;
  service?: { id: string; name: string };
}

interface AvailableSlot {
  date: string;                 // YYYY-MM-DD
  startTime: string;            // ISO 8601
  endTime: string;              // ISO 8601
  staffMemberId?: string;
  staffName?: string;
  available: boolean;
}
```

---

### GET /bookings

List bookings.

**Query Parameters:**

```typescript
interface BookingListQuery extends CommonQueryParams {
  status?: BookingStatus | BookingStatus[];
  clientId?: string;
  catalogItemId?: string;
  staffMemberId?: string;
  date?: string;           // YYYY-MM-DD — bookings on a specific date
  from?: string;
  to?: string;
  include?: 'client' | 'service';
}
```

**Response 200:** `PaginatedResponse<Booking>`

---

### GET /bookings/:bookingId

Get a single booking.

**Response 200:** `Booking`

---

### POST /bookings

Create a booking.

**Request:**

```typescript
interface CreateBookingRequest {
  clientId: string;
  catalogItemId: string;
  variantId?: string;
  staffMemberId?: string;
  startTime: string;           // ISO 8601
  timezone?: string;           // Default: business timezone
  notes?: string;
  sendConfirmation?: boolean;  // Default: true — send via client's preferred channel
  createOrder?: boolean;       // Default: true — create linked order and payment
}
```

**Response 201:** `Booking`

Notable behavior: Validates slot availability before creating. Optionally creates a linked Order and sends payment link if `createOrder: true`. Syncs to Google Calendar if integration is active.

---

### PATCH /bookings/:bookingId

Reschedule or update a booking.

**Request:**

```typescript
interface UpdateBookingRequest {
  startTime?: string;
  staffMemberId?: string;
  notes?: string;
  status?: Extract<BookingStatus, 'CONFIRMED' | 'PENDING' | 'NO_SHOW'>;
}
```

**Response 200:** `Booking`

Notable behavior: If `startTime` changes, emits `booking.rescheduled` event and sends notification to client.

---

### POST /bookings/:bookingId/cancel

Cancel a booking.

**Request:**

```typescript
interface CancelBookingRequest {
  reason?: string;
  notifyClient?: boolean;      // Default: true
  refundPayment?: boolean;     // Default: based on business policy
}
```

**Response 200:** `Booking`

---

### POST /bookings/:bookingId/complete

Mark a booking as completed (service delivered).

**Request:**

```typescript
interface CompleteBookingRequest {
  notes?: string;
  requestReview?: boolean;     // Default: false — send review request to client
}
```

**Response 200:** `Booking`

---

### GET /bookings/slots

Get available booking slots for a service.

**Query Parameters:**

```typescript
interface GetSlotsQuery {
  catalogItemId: string;       // Required
  variantId?: string;
  staffMemberId?: string;
  from: string;                // YYYY-MM-DD — start date of range
  to: string;                  // YYYY-MM-DD — end date (max 30 days ahead)
  timezone?: string;           // Client's timezone for display
}
```

**Response 200:**

```typescript
interface SlotsResponse {
  slots: AvailableSlot[];
  timezone: string;
  nextAvailableDate?: string;  // If no slots in requested range
}
```

---

### GET /bookings/calendar

Get all bookings formatted for calendar display.

**Query Parameters:** `from`, `to` (YYYY-MM-DD), `staffMemberId?`

**Response 200:**

```typescript
interface CalendarResponse {
  events: Array<{
    id: string;                  // bookingId
    title: string;               // Client name + service
    start: string;               // ISO 8601
    end: string;                 // ISO 8601
    status: BookingStatus;
    clientId: string;
    color?: string;              // Status-derived color
  }>;
}
```

---

### POST /bookings/calendar/sync

Trigger a manual Google Calendar sync.

**Request:**

```typescript
interface CalendarSyncRequest {
  direction: 'PUSH' | 'PULL' | 'BOTH';
  from?: string;                // Default: today
  to?: string;                  // Default: 30 days ahead
}
```

**Response 200:**

```typescript
interface CalendarSyncResponse {
  pushed: number;
  pulled: number;
  conflicts: number;
  completedAt: string;
}
```

---

### GET /bookings/staff

List staff members available for booking assignment.

**Response 200:**

```typescript
interface StaffMember {
  id: string;                  // userId
  name: string;
  avatarUrl?: string;
  services: string[];          // catalogItemIds they handle
  workingHours: OfficeHours;
}

// Response
{ staff: StaffMember[] }
```

---

## 11. Payment

Base path: `/v1/payments`

All endpoints require auth. Razorpay webhook is public (signature-verified).

### Shared Types

```typescript
type PaymentMethod = 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET' | 'COD' | 'EMI';
type PaymentStatus = 'PENDING' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'REFUNDED' | 'PARTIALLY_REFUNDED' | 'EXPIRED';

interface Payment {
  id: string;
  businessId: string;
  orderId?: string;
  bookingId?: string;
  clientId: string;
  amount: number;              // In paise (INR smallest unit)
  currency: string;            // Default: "INR"
  status: PaymentStatus;
  method?: PaymentMethod;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  paymentLinkId?: string;
  paymentLinkUrl?: string;
  paymentLinkShortUrl?: string;
  paymentLinkExpiry?: string;
  capturedAt?: string;
  failureReason?: string;
  refunds: PaymentRefund[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface PaymentRefund {
  id: string;
  paymentId: string;
  amount: number;
  reason: string;
  razorpayRefundId?: string;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  processedAt?: string;
  createdAt: string;
}
```

---

### GET /payments

List payments.

**Query Parameters:**

```typescript
interface PaymentListQuery extends CommonQueryParams {
  status?: PaymentStatus;
  clientId?: string;
  orderId?: string;
  method?: PaymentMethod;
  from?: string;
  to?: string;
}
```

**Response 200:** `PaginatedResponse<Payment>`

---

### GET /payments/:paymentId

Get a payment by ID.

**Response 200:** `Payment`

---

### POST /payments/link

Create a Razorpay payment link and (optionally) send it to the client.

**Request:**

```typescript
interface CreatePaymentLinkRequest {
  clientId: string;
  amount: number;              // In paise
  currency?: string;           // Default: "INR"
  description: string;
  orderId?: string;
  bookingId?: string;
  expiresInHours?: number;     // Default: 24
  sendToClient?: boolean;      // Default: true — send via preferred channel
  acceptPartialPayments?: boolean; // Default: false
  notifyOnPayment?: boolean;   // Default: true
}
```

**Response 201:**

```typescript
interface PaymentLinkResponse {
  payment: Payment;
  link: {
    id: string;
    url: string;
    shortUrl: string;
    expiresAt: string;
  };
  messageSent?: boolean;       // Whether link was sent to client
}
```

---

### POST /payments/:paymentId/capture

Manually capture an authorized payment (for card payments with separate auth+capture).

**Request:**

```typescript
interface CapturePaymentRequest {
  amount?: number;             // Partial capture. Default: full authorized amount
}
```

**Response 200:** `Payment`

---

### POST /payments/:paymentId/refund

Initiate a refund.

**Request:**

```typescript
interface RefundRequest {
  amount: number;              // In paise. Must be <= (captured - already-refunded)
  reason: string;
  notes?: string;
  notifyClient?: boolean;      // Default: true
}
```

**Response 201:** `PaymentRefund`

---

### POST /payments/cod

Record a Cash on Delivery payment (offline transaction).

**Request:**

```typescript
interface RecordCodPaymentRequest {
  clientId: string;
  orderId: string;
  amount: number;
  collectedBy?: string;        // userId of staff who collected
  notes?: string;
  collectedAt?: string;        // ISO 8601. Default: now
}
```

**Response 201:** `Payment`

---

### GET /payments/stats

Payment revenue stats.

**Query Parameters:** `from?`, `to?`

**Response 200:**

```typescript
interface PaymentStats {
  totalRevenue: number;        // In paise
  totalTransactions: number;
  successRate: number;
  avgTransactionValue: number;
  refundedAmount: number;
  refundCount: number;
  methodBreakdown: Record<PaymentMethod, { count: number; amount: number }>;
}
```

---

## 12. Orders

Base path: `/v1/orders`

All endpoints require auth.

### Shared Types

```typescript
type OrderStatus =
  | 'DRAFT'
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'READY_FOR_PICKUP'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'REFUNDED';

type FulfillmentType = 'DELIVERY' | 'PICKUP' | 'DIGITAL' | 'IN_STORE';

interface Order {
  id: string;
  businessId: string;
  clientId: string;
  conversationId?: string;     // Conversation that triggered order
  orderNumber: string;         // Human-readable: ORD-2026-001234
  status: OrderStatus;
  fulfillmentType: FulfillmentType;
  items: OrderItem[];
  subtotal: number;            // In paise
  discountAmount: number;
  taxAmount: number;
  shippingAmount: number;
  total: number;
  currency: string;
  paymentId?: string;
  shippingAddress?: OrderAddress;
  billingAddress?: OrderAddress;
  shipmentId?: string;
  trackingNumber?: string;
  notes?: string;
  internalNotes?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
  shippedAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
}

interface OrderItem {
  id: string;
  orderId: string;
  catalogItemId: string;
  variantId?: string;
  name: string;                // Snapshot at time of order
  sku?: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  imageUrl?: string;
}

interface OrderAddress {
  name: string;
  phone: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
}
```

---

### GET /orders

List orders.

**Query Parameters:**

```typescript
interface OrderListQuery extends CommonQueryParams {
  status?: OrderStatus | OrderStatus[];
  clientId?: string;
  fulfillmentType?: FulfillmentType;
  paymentId?: string;
  tags?: string[];
  from?: string;
  to?: string;
}
```

**Response 200:** `PaginatedResponse<Order>`

---

### GET /orders/:orderId

Get a single order.

**Response 200:** `Order`

---

### POST /orders

Create a new order.

**Request:**

```typescript
interface CreateOrderRequest {
  clientId: string;
  conversationId?: string;
  fulfillmentType: FulfillmentType;
  items: Array<{
    catalogItemId: string;
    variantId?: string;
    quantity: number;
  }>;
  shippingAddress?: OrderAddress;
  billingAddress?: OrderAddress;
  notes?: string;
  tags?: string[];
  createPaymentLink?: boolean;     // Default: false
}
```

**Response 201:**

```typescript
interface CreateOrderResponse {
  order: Order;
  paymentLink?: PaymentLinkResponse;  // If createPaymentLink: true
}
```

Notable behavior: Prices are fetched from the catalog at creation time and snapshotted into the order. Inventory is decremented if `trackInventory: true` on the item.

---

### PATCH /orders/:orderId

Update a draft or pending order.

**Request:**

```typescript
interface UpdateOrderRequest {
  fulfillmentType?: FulfillmentType;
  items?: Array<{
    catalogItemId: string;
    variantId?: string;
    quantity: number;
  }>;
  shippingAddress?: OrderAddress;
  billingAddress?: OrderAddress;
  notes?: string;
  internalNotes?: string;
  tags?: string[];
}
```

**Response 200:** `Order`

---

### POST /orders/:orderId/confirm

Confirm a DRAFT order.

**Request:**

```typescript
interface ConfirmOrderRequest {
  sendConfirmation?: boolean;   // Default: true — notify client
}
```

**Response 200:** `Order`

---

### POST /orders/:orderId/cancel

Cancel an order.

**Request:**

```typescript
interface CancelOrderRequest {
  reason: string;
  refundPayment?: boolean;      // Default: true if payment captured
  notifyClient?: boolean;       // Default: true
}
```

**Response 200:** `Order`

---

### POST /orders/:orderId/fulfill

Mark an order as fulfilled / ready.

**Request:**

```typescript
interface FulfillOrderRequest {
  fulfillmentType?: FulfillmentType;
  createShipment?: boolean;     // Default: true for DELIVERY orders
  notifyClient?: boolean;       // Default: true
}
```

**Response 200:**

```typescript
interface FulfillOrderResponse {
  order: Order;
  shipment?: Shipment;          // Created if createShipment: true
}
```

---

### GET /orders/stats

Order revenue and volume stats.

**Query Parameters:** `from?`, `to?`

**Response 200:**

```typescript
interface OrderStats {
  totalOrders: number;
  totalRevenue: number;
  avgOrderValue: number;
  statusBreakdown: Record<OrderStatus, number>;
  fulfillmentBreakdown: Record<FulfillmentType, number>;
  topItems: Array<{ itemId: string; name: string; quantity: number; revenue: number }>;
}
```

---

## 13. Shipping

Base path: `/v1/shipping`

All endpoints require auth.

### Shared Types

```typescript
type ShipmentStatus =
  | 'DRAFT'
  | 'LABEL_CREATED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'DELIVERY_FAILED'
  | 'RETURNED'
  | 'CANCELLED';

interface Shipment {
  id: string;
  businessId: string;
  orderId: string;
  clientId: string;
  provider: 'SHIPROCKET' | 'DELHIVERY' | 'BLUEDART' | 'DTDC' | 'MANUAL';
  shipmentCode?: string;       // Provider's shipment ID
  trackingNumber?: string;
  trackingUrl?: string;
  status: ShipmentStatus;
  awbCode?: string;            // Air Waybill code
  courierName?: string;
  pickupAddress: OrderAddress;
  deliveryAddress: OrderAddress;
  items: ShipmentItem[];
  weight: number;              // In grams
  dimensions?: {
    length: number;
    width: number;
    height: number;            // All in cm
  };
  labelUrl?: string;           // Printable shipping label PDF
  invoiceUrl?: string;
  estimatedDelivery?: string;
  cod: boolean;
  codAmount?: number;
  shippingCharge: number;
  trackingEvents: TrackingEvent[];
  createdAt: string;
  updatedAt: string;
}

interface ShipmentItem {
  catalogItemId: string;
  name: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
}

interface TrackingEvent {
  status: string;
  location: string;
  timestamp: string;
  description: string;
}
```

---

### GET /shipping/shipments

List all shipments.

**Query Parameters:**

```typescript
interface ShipmentListQuery extends CommonQueryParams {
  status?: ShipmentStatus;
  orderId?: string;
  clientId?: string;
  provider?: Shipment['provider'];
  cod?: boolean;
}
```

**Response 200:** `PaginatedResponse<Shipment>`

---

### GET /shipping/shipments/:shipmentId

Get a shipment.

**Response 200:** `Shipment`

---

### POST /shipping/shipments

Create a shipment (book with logistics provider).

**Request:**

```typescript
interface CreateShipmentRequest {
  orderId: string;
  provider?: Shipment['provider'];  // Default: auto-select by rate/speed
  weight: number;
  dimensions?: { length: number; width: number; height: number };
  pickupAddressId?: string;         // From business's saved addresses
  preferredPickupDate?: string;     // YYYY-MM-DD
  cod?: boolean;
  codAmount?: number;
}
```

**Response 201:** `Shipment`

---

### GET /shipping/shipments/:shipmentId/tracking

Get live tracking events for a shipment.

**Response 200:**

```typescript
interface TrackingResponse {
  shipment: Pick<Shipment, 'id' | 'trackingNumber' | 'status' | 'estimatedDelivery' | 'courierName'>;
  events: TrackingEvent[];
  lastUpdatedAt: string;
}
```

---

### POST /shipping/shipments/:shipmentId/cancel

Cancel a shipment (before pickup).

**Request:**

```typescript
interface CancelShipmentRequest {
  reason?: string;
}
```

**Response 200:** `Shipment`

---

### POST /shipping/shipments/:shipmentId/return

Initiate a return shipment.

**Request:**

```typescript
interface InitiateReturnRequest {
  reason: string;
  clientPickupAddress?: OrderAddress;   // Where to pick up from client
  refundPayment?: boolean;              // Default: true
}
```

**Response 201:**

```typescript
interface ReturnShipmentResponse {
  returnShipment: Shipment;
  refund?: PaymentRefund;
}
```

---

### GET /shipping/rates

Get shipping rate quotes from providers.

**Request:**

```typescript
interface ShippingRateQuery {
  pickupPincode: string;
  deliveryPincode: string;
  weight: number;
  dimensions?: { length: number; width: number; height: number };
  cod?: boolean;
}
```

**Response 200:**

```typescript
interface ShippingRateResponse {
  rates: Array<{
    provider: Shipment['provider'];
    serviceLevel: string;           // "Express", "Standard", etc.
    estimatedDays: number;
    charge: number;                 // In paise
    available: boolean;
  }>;
}
```

---

### GET /shipping/providers

List configured logistics providers and their status.

**Response 200:**

```typescript
interface ProviderStatus {
  provider: Shipment['provider'];
  enabled: boolean;
  accountId?: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
}

// Response
{ providers: ProviderStatus[] }
```

---

### POST /shipping/providers/:provider/connect

Configure and connect a logistics provider.

**Request:**

```typescript
interface ConnectProviderRequest {
  credentials: Record<string, string>;   // Provider-specific: apiKey, clientId, etc.
}
```

**Response 200:** `ProviderStatus`

---

## 14. Campaigns

Base path: `/v1/campaigns`

All endpoints require auth. Mutations require MANAGER or OWNER.

### Shared Types

```typescript
type CampaignType = 'BROADCAST' | 'LIFECYCLE' | 'DRIP' | 'RE_ENGAGEMENT';
type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
type CampaignChannel = 'WHATSAPP' | 'SMS' | 'EMAIL' | 'ALL';

interface Campaign {
  id: string;
  businessId: string;
  name: string;
  type: CampaignType;
  status: CampaignStatus;
  channel: CampaignChannel;
  channelId?: string;          // Specific channel instance, if not ALL
  audience: CampaignAudience;
  message: CampaignMessage;
  schedule?: CampaignSchedule;
  stats: CampaignStats;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface CampaignAudience {
  type: 'ALL' | 'SEGMENT' | 'TAGS' | 'MANUAL';
  segmentId?: string;
  tags?: string[];
  clientIds?: string[];        // For MANUAL type
  estimatedSize: number;
}

interface CampaignMessage {
  type: 'TEXT' | 'TEMPLATE' | 'MEDIA';
  text?: string;
  templateName?: string;       // WhatsApp approved template name
  templateVariables?: Record<string, string>;
  mediaUrl?: string;
  mediaCaption?: string;
}

interface CampaignSchedule {
  type: 'IMMEDIATE' | 'SCHEDULED' | 'RECURRING';
  scheduledAt?: string;        // ISO 8601 — for SCHEDULED
  timezone?: string;
  recurrence?: {
    frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY';
    dayOfWeek?: number[];      // 0=Sun, for WEEKLY
    dayOfMonth?: number;       // For MONTHLY
    time: string;              // HH:MM
  };
}

interface CampaignStats {
  totalRecipients: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  optedOut: number;
  deliveryRate: number;
  readRate: number;
  replyRate: number;
}
```

---

### GET /campaigns

List campaigns.

**Query Parameters:**

```typescript
interface CampaignListQuery extends CommonQueryParams {
  type?: CampaignType;
  status?: CampaignStatus;
  channel?: CampaignChannel;
}
```

**Response 200:** `PaginatedResponse<Campaign>`

---

### GET /campaigns/:campaignId

Get a campaign.

**Response 200:** `Campaign`

---

### POST /campaigns

Create a campaign.

**Request:**

```typescript
interface CreateCampaignRequest {
  name: string;
  type: CampaignType;
  channel: CampaignChannel;
  channelId?: string;
  audience: Omit<CampaignAudience, 'estimatedSize'>;
  message: CampaignMessage;
  schedule?: CampaignSchedule;
}
```

**Response 201:** `Campaign`

Notable behavior: For WhatsApp, `message.type === 'TEMPLATE'` is required for outbound to clients who haven't messaged in the last 24 hours (Meta 24-hour rule). The system validates the template name exists in the approved template list.

---

### PATCH /campaigns/:campaignId

Update a draft or scheduled campaign.

**Request:** `Partial<CreateCampaignRequest>` (cannot update a running/completed campaign)

**Response 200:** `Campaign`

---

### POST /campaigns/:campaignId/send

Immediately dispatch a draft campaign (ignores schedule).

**Request:**

```typescript
interface SendCampaignRequest {
  confirm?: boolean;    // Default: false — dry run returns preview only
}
```

**Response 200:**

```typescript
interface SendCampaignResponse {
  campaign: Campaign;
  dryRun?: {
    estimatedRecipients: number;
    estimatedCost?: number;
    sampleMessage: string;
  };
  jobId?: string;       // If actually dispatched, BullMQ job ID to track
}
```

---

### POST /campaigns/:campaignId/pause

Pause a running campaign.

**Response 200:** `Campaign`

---

### POST /campaigns/:campaignId/resume

Resume a paused campaign.

**Response 200:** `Campaign`

---

### POST /campaigns/:campaignId/cancel

Cancel a scheduled or running campaign.

**Response 200:** `Campaign`

---

### GET /campaigns/:campaignId/recipients

List individual campaign send records.

**Response 200:**

```typescript
interface CampaignRecipient {
  clientId: string;
  clientName: string;
  status: 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'REPLIED' | 'FAILED' | 'OPT_OUT';
  sentAt?: string;
  deliveredAt?: string;
  readAt?: string;
  repliedAt?: string;
  failureReason?: string;
}

// Response
PaginatedResponse<CampaignRecipient>
```

---

### GET /campaigns/templates

List available WhatsApp-approved message templates.

**Response 200:**

```typescript
interface MessageTemplate {
  name: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  language: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED';
  components: TemplateComponent[];
}

interface TemplateComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  text?: string;
  variables: string[];    // e.g. ["{{1}}", "{{2}}"]
}

// Response
{ templates: MessageTemplate[] }
```

---

### POST /campaigns/templates

Submit a new WhatsApp message template for Meta approval.

**Request:**

```typescript
interface CreateTemplateRequest {
  name: string;                // Lowercase, underscores only
  category: 'UTILITY' | 'MARKETING';
  language: string;
  header?: { type: 'TEXT' | 'IMAGE' | 'DOCUMENT'; text?: string };
  body: string;                // Template text with {{1}} placeholders
  footer?: string;
  buttons?: Array<{
    type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
    text: string;
    url?: string;
    phoneNumber?: string;
  }>;
}
```

**Response 201:** `MessageTemplate`

---

## 15. HITL (Human-in-the-Loop)

Base path: `/v1/hitl`

All endpoints require auth.

### Shared Types

```typescript
type HitlTaskType =
  | 'DRAFT_REVIEW'         // AI generated a draft, human to approve/edit/reject
  | 'ESCALATION'           // AI could not handle, human takes over conversation
  | 'APPROVAL_REQUIRED'    // Action needs human approval (refund, order cancel, etc.)
  | 'QUALITY_CHECK'        // Random audit of AI decisions
  | 'CUSTOMER_REQUEST';    // Client explicitly asked for human

type HitlTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'RESOLVED' | 'EXPIRED' | 'ESCALATED';
type HitlPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

interface HitlTask {
  id: string;
  businessId: string;
  conversationId: string;
  messageId?: string;          // Triggering message
  type: HitlTaskType;
  status: HitlTaskStatus;
  priority: HitlPriority;
  assignedTo?: string;         // userId
  title: string;
  description: string;
  aiDraft?: string;            // AI's suggested response (for DRAFT_REVIEW)
  aiConfidence?: number;
  aiReasoning?: string;
  requiredAction?: {
    type: string;              // e.g. "APPROVE_REFUND", "CONFIRM_ORDER_CANCEL"
    payload: Record<string, unknown>;
  };
  resolution?: HitlResolution;
  expiresAt?: string;          // SLA deadline
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  client?: ClientSummary;
}

interface HitlResolution {
  action: 'APPROVED' | 'EDITED' | 'REJECTED' | 'OVERRIDDEN';
  resolvedBy: string;          // userId
  editedResponse?: string;     // If action was EDITED
  reason?: string;
  timestamp: string;
}
```

---

### GET /hitl/tasks

List HITL tasks (the agent's task queue).

**Query Parameters:**

```typescript
interface HitlTaskListQuery extends CommonQueryParams {
  status?: HitlTaskStatus | HitlTaskStatus[];
  type?: HitlTaskType;
  priority?: HitlPriority;
  assignedTo?: string;         // userId or "me" or "unassigned"
  conversationId?: string;
  include?: 'client';
}
```

**Response 200:** `PaginatedResponse<HitlTask>`

---

### GET /hitl/tasks/:taskId

Get a single HITL task.

**Response 200:** `HitlTask`

---

### POST /hitl/tasks/:taskId/claim

Claim a task (assign to yourself).

**Response 200:** `HitlTask`

---

### POST /hitl/tasks/:taskId/approve

Approve an AI draft or required action.

**Request:**

```typescript
interface ApproveTaskRequest {
  editedResponse?: string;     // If editing the draft before sending
  notes?: string;
}
```

**Response 200:**

```typescript
interface ApproveTaskResponse {
  task: HitlTask;
  message?: Message;           // Sent message if draft was approved
}
```

Notable behavior: If `editedResponse` is provided, the original AI draft is discarded and the edited version is sent. Emits `ai.response.approved` or `ai.response.rejected` depending on whether the draft was used unchanged, edited, or rejected.

---

### POST /hitl/tasks/:taskId/reject

Reject an AI draft and take over the conversation manually.

**Request:**

```typescript
interface RejectTaskRequest {
  reason?: string;
  takeOverConversation?: boolean;   // Default: true — assigns conversation to this user
}
```

**Response 200:** `HitlTask`

---

### POST /hitl/tasks/:taskId/resolve

Mark a task as resolved (manual escalation resolved).

**Request:**

```typescript
interface ResolveTaskRequest {
  resolution: string;
  resolveConversation?: boolean;    // Default: false
}
```

**Response 200:** `HitlTask`

---

### GET /hitl/tasks/stats

Task queue stats for dashboard.

**Query Parameters:** `from?`, `to?`

**Response 200:**

```typescript
interface HitlStats {
  pending: number;
  inProgress: number;
  resolved: number;
  expired: number;
  avgResolutionTimeMs: number;
  slaBreachCount: number;
  approvalRate: number;          // % of drafts approved as-is
  editRate: number;              // % of drafts approved with edits
  rejectionRate: number;
  priorityBreakdown: Record<HitlPriority, number>;
}
```

---

### Internal Chat (HITL team communication on a conversation)

#### GET /conversations/:conversationId/internal-chat

Get internal team chat history on a conversation.

**Response 200:** `PaginatedResponse<InternalMessage>`

```typescript
interface InternalMessage {
  id: string;
  conversationId: string;
  userId: string;
  userName: string;
  text: string;
  mentions: string[];         // userIds mentioned
  createdAt: string;
}
```

---

#### POST /conversations/:conversationId/internal-chat

Post an internal message on a conversation.

**Request:**

```typescript
interface PostInternalMessageRequest {
  text: string;
  mentions?: string[];        // userIds to notify
}
```

**Response 201:** `InternalMessage`

---

## 16. Analytics

Base path: `/v1/analytics`

All endpoints require auth.

### GET /analytics/dashboard

Main dashboard summary — top-line KPIs.

**Query Parameters:** `from?`, `to?`, `channelId?`

**Response 200:**

```typescript
interface DashboardMetrics {
  period: { from: string; to: string };
  conversations: {
    total: number;
    open: number;
    resolved: number;
    escalated: number;
    avgResolutionTimeMs: number;
    avgFirstResponseTimeMs: number;
  };
  messages: {
    inbound: number;
    outbound: number;
    aiSent: number;
    humanSent: number;
  };
  ai: {
    autonomyRate: number;         // % handled without human
    avgConfidence: number;
    autoExecuted: number;
    reviewed: number;
    escalated: number;
    approvalRate: number;
  };
  revenue: {
    total: number;
    orders: number;
    payments: number;
    avgOrderValue: number;
  };
  clients: {
    total: number;
    newThisPeriod: number;
    activeThisPeriod: number;     // Had a conversation
    churnRisk: number;            // Count of HIGH churn risk
  };
  channels: Array<{
    channelType: ChannelType;
    messageCount: number;
    conversationCount: number;
  }>;
}
```

---

### GET /analytics/autonomy

AI autonomy deep-dive report.

**Query Parameters:** `from?`, `to?`, `granularity?: 'HOUR' | 'DAY' | 'WEEK'`

**Response 200:**

```typescript
interface AutonomyReport {
  summary: {
    autonomyRate: number;
    trend: number;               // % change vs previous period
    totalDecisions: number;
  };
  timeSeries: Array<{
    date: string;
    autonomyRate: number;
    autoExecuted: number;
    reviewed: number;
    escalated: number;
  }>;
  intentBreakdown: Array<{
    intent: IntentType;
    count: number;
    autonomyRate: number;
    avgConfidence: number;
  }>;
  confidenceDistribution: Array<{
    bucket: string;              // "0-10", "10-20", ..., "90-100"
    count: number;
  }>;
  topEscalationReasons: Array<{
    reason: string;
    count: number;
  }>;
}
```

---

### GET /analytics/conversations

Conversation analytics report.

**Query Parameters:** `from?`, `to?`, `granularity?`, `channelId?`

**Response 200:**

```typescript
interface ConversationReport {
  summary: {
    total: number;
    avgResolutionTimeMs: number;
    avgFirstResponseTimeMs: number;
    csat?: number;               // Customer satisfaction score (if enabled)
  };
  timeSeries: Array<{
    date: string;
    created: number;
    resolved: number;
    escalated: number;
    avgResolutionTimeMs: number;
  }>;
  channelBreakdown: Array<{ channel: ChannelType; count: number; avgResolutionTimeMs: number }>;
  agentPerformance: Array<{
    userId: string;
    name: string;
    resolved: number;
    avgResolutionTimeMs: number;
    tasksApproved: number;
    tasksRejected: number;
  }>;
  topIntents: Array<{ intent: IntentType; count: number }>;
}
```

---

### GET /analytics/revenue

Revenue and commerce analytics.

**Query Parameters:** `from?`, `to?`, `granularity?`

**Response 200:**

```typescript
interface RevenueReport {
  summary: {
    totalRevenue: number;
    totalOrders: number;
    avgOrderValue: number;
    totalRefunds: number;
    netRevenue: number;
  };
  timeSeries: Array<{
    date: string;
    revenue: number;
    orders: number;
    refunds: number;
  }>;
  topProducts: Array<{ itemId: string; name: string; quantity: number; revenue: number }>;
  fulfillmentBreakdown: Record<FulfillmentType, { orders: number; revenue: number }>;
}
```

---

### GET /analytics/clients

Client intelligence analytics.

**Query Parameters:** `from?`, `to?`

**Response 200:**

```typescript
interface ClientReport {
  summary: {
    total: number;
    newClients: number;
    returning: number;
    avgLtv: number;
    churnRiskHigh: number;
  };
  acquisitionTimeSeries: Array<{ date: string; newClients: number }>;
  churnRiskBreakdown: { low: number; medium: number; high: number };
  sentimentDistribution: Record<ClientIntelligence['sentimentLabel'], number>;
  topTags: Array<{ tag: string; count: number }>;
  channelPreferences: Record<ChannelType, number>;
}
```

---

### POST /analytics/reports/export

Export an analytics report as CSV or PDF.

**Request:**

```typescript
interface ExportReportRequest {
  reportType: 'CONVERSATIONS' | 'REVENUE' | 'AI_AUTONOMY' | 'CLIENTS' | 'CAMPAIGNS';
  format: 'CSV' | 'PDF';
  from: string;
  to: string;
  filters?: Record<string, unknown>;
}
```

**Response 202:**

```typescript
interface ExportJobResponse {
  jobId: string;
  estimatedSeconds: number;
}
```

---

### GET /analytics/reports/export/:jobId

Poll export job status and get download URL.

**Response 200:**

```typescript
interface ExportJobStatus {
  jobId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETE' | 'FAILED';
  downloadUrl?: string;        // Pre-signed S3 URL, valid for 1 hour
  expiresAt?: string;
  completedAt?: string;
}
```

---

## 17. Admin (Internal)

Base path: `/v1/admin`

These endpoints are for GoSumo's internal operations team. They are **not accessible to business subscribers**. Enforced by a separate `GOSUMO_ADMIN` role and additional API key authentication header:

```
X-Admin-Key: <admin_api_key>
```

### Shared Types

```typescript
interface SubscriberBusiness {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string;
  subscriptionPlan: BusinessProfile['subscriptionPlan'];
  subscriptionStatus: BusinessProfile['subscriptionStatus'];
  trialEndsAt?: string;
  activeChannels: ChannelType[];
  totalClients: number;
  totalConversations: number;
  totalMessagesSent: number;
  monthlyRevenue: number;      // GoSumo's subscription revenue from this business
  createdAt: string;
  lastActiveAt?: string;
}
```

---

### GET /admin/businesses

List all subscriber businesses.

**Query Parameters:**

```typescript
interface AdminBusinessListQuery extends CommonQueryParams {
  subscriptionPlan?: BusinessProfile['subscriptionPlan'];
  subscriptionStatus?: BusinessProfile['subscriptionStatus'];
  q?: string;
}
```

**Response 200:** `PaginatedResponse<SubscriberBusiness>`

---

### GET /admin/businesses/:businessId

Get a subscriber's full profile and settings.

**Response 200:** `SubscriberBusiness & { settings: BusinessSettings; channels: Channel[] }`

---

### PATCH /admin/businesses/:businessId/subscription

Update a business's subscription plan.

**Request:**

```typescript
interface UpdateSubscriptionRequest {
  plan: BusinessProfile['subscriptionPlan'];
  status?: BusinessProfile['subscriptionStatus'];
  trialEndsAt?: string;
  notes?: string;              // Internal reason for change
}
```

**Response 200:** `SubscriberBusiness`

---

### POST /admin/businesses/:businessId/impersonate

Generate a short-lived impersonation token to log in as a business owner (for support).

**Request:**

```typescript
interface ImpersonateRequest {
  reason: string;              // Required — logged in audit trail
  durationMinutes?: number;    // Default: 30. Max: 60.
}
```

**Response 200:**

```typescript
interface ImpersonateResponse {
  impersonationToken: string;  // Use as Bearer token
  expiresAt: string;
  auditLogId: string;
}
```

Notable behavior: Every impersonation action is logged in a tamper-evident audit log. The business owner is notified of the impersonation session by email.

---

### GET /admin/businesses/:businessId/audit-log

Get the audit log for a business.

**Response 200:** `PaginatedResponse<AuditLogEntry>`

```typescript
interface AuditLogEntry {
  id: string;
  businessId: string;
  actorId: string;
  actorType: 'BUSINESS_USER' | 'GOSUMO_ADMIN' | 'AI_ENGINE' | 'SYSTEM';
  action: string;
  resource: string;
  resourceId?: string;
  changes?: Record<string, { before: unknown; after: unknown }>;
  ipAddress?: string;
  userAgent?: string;
  timestamp: string;
}
```

---

### GET /admin/ai/safety

List recent AI safety flags (hallucination attempts, policy violations, etc.).

**Query Parameters:** `from?`, `to?`, `businessId?`

**Response 200:**

```typescript
interface AiSafetyEvent {
  id: string;
  businessId: string;
  messageId: string;
  type: 'HALLUCINATION' | 'POLICY_VIOLATION' | 'PII_LEAK' | 'PROMPT_INJECTION' | 'CONFIDENCE_OVERRIDE';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  blocked: boolean;
  timestamp: string;
}

// Response
PaginatedResponse<AiSafetyEvent>
```

---

### GET /admin/system/health

System-wide health status.

**Response 200:**

```typescript
interface SystemHealth {
  status: 'HEALTHY' | 'DEGRADED' | 'DOWN';
  services: Array<{
    name: string;
    status: 'UP' | 'DEGRADED' | 'DOWN';
    latencyMs?: number;
    lastCheckedAt: string;
  }>;
  queues: Array<{
    name: string;
    waiting: number;
    active: number;
    failed: number;
    paused: boolean;
  }>;
  timestamp: string;
}
```

---

### GET /admin/system/metrics

Platform-wide aggregate metrics.

**Query Parameters:** `from?`, `to?`

**Response 200:**

```typescript
interface PlatformMetrics {
  totalBusinesses: number;
  activeBusinesses: number;         // At least 1 message in period
  totalMessages: number;
  totalConversations: number;
  totalAiDecisions: number;
  overallAutonomyRate: number;
  mrr: number;                      // Monthly recurring revenue (INR paise)
  planBreakdown: Record<BusinessProfile['subscriptionPlan'], number>;
  channelBreakdown: Record<ChannelType, number>;
}
```

---

## 18. Webhooks (Inbound)

Base path: `/v1/webhooks`

Webhook endpoints are **public** — they do not require Bearer token auth. Instead, each request is authenticated by HMAC-SHA256 signature verification using a shared secret between GoSumo and the external provider.

**Signature header per provider:**

| Provider | Header |
|----------|--------|
| Meta (WhatsApp, Instagram) | `X-Hub-Signature-256: sha256=<hex>` |
| Razorpay | `X-Razorpay-Signature: <hex>` |
| Shiprocket | `X-Shiprocket-Signature: <hex>` |
| GoSumo Web Chat | `X-GoSumo-Signature: sha256=<hex>` |

GoSumo returns `200 OK` immediately (within 100ms) and processes the event asynchronously via BullMQ. A non-200 response or timeout will cause the provider to retry. Idempotency is enforced by storing the provider's event ID and skipping duplicates.

---

### POST /webhooks/whatsapp/:channelId

Receive inbound WhatsApp events from Meta.

**Meta GET verification challenge:** When Meta verifies the webhook URL, it sends a GET request with `hub.mode`, `hub.challenge`, and `hub.verify_token`. GoSumo responds with the `hub.challenge` value.

**Inbound event types handled:**

```typescript
type WhatsAppEventType =
  | 'messages'           // Inbound text, media, interactive, location
  | 'statuses'           // Message delivery status updates (sent, delivered, read, failed)
  | 'contacts'           // Contact card received
  | 'errors';            // Error notifications
```

**Response 200:** `{ status: "ok" }`

Notable behavior:
- Validates `X-Hub-Signature-256` against the channel's stored verify token.
- Normalizes the payload into `NormalizedMessage`.
- Stores raw payload for debugging.
- Emits `message.received` or `message.status.updated` domain event.

---

### GET /webhooks/whatsapp/:channelId

WhatsApp webhook verification endpoint (Meta challenge-response).

**Query Parameters (from Meta):**

```
hub.mode=subscribe
hub.challenge=<random_string>
hub.verify_token=<token_set_in_meta_dashboard>
```

**Response 200:** Raw `hub.challenge` value (plain text, not JSON)

---

### POST /webhooks/instagram/:channelId

Receive Instagram DM events from Meta.

Identical signature verification as WhatsApp. Handles `messages` and `statuses` event types from the Instagram Messaging API.

**Response 200:** `{ status: "ok" }`

---

### GET /webhooks/instagram/:channelId

Instagram webhook verification (same as WhatsApp pattern).

**Response 200:** Raw `hub.challenge` value

---

### POST /webhooks/razorpay

Receive Razorpay payment and refund events.

**Razorpay event types handled:**

```typescript
type RazorpayEventType =
  | 'payment.authorized'
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.created'
  | 'refund.processed'
  | 'refund.failed'
  | 'payment_link.paid'
  | 'payment_link.expired';
```

Signature is verified using `X-Razorpay-Signature` against the Razorpay webhook secret.

**Response 200:** `{ status: "ok" }`

Notable behavior:
- `payment.captured` transitions the linked order to `PAID` and triggers fulfillment.
- `refund.processed` updates the refund record and notifies the client.
- All events are mapped to GoSumo payment domain events.

---

### POST /webhooks/shiprocket

Receive Shiprocket shipment tracking updates.

**Shiprocket event types handled:**

```typescript
type ShiprocketEventType =
  | 'shipment_status'         // Status change on any tracking stage
  | 'pickup_scheduled'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'delivery_failed'
  | 'rto_initiated'           // Return to origin
  | 'rto_delivered';
```

**Response 200:** `{ status: "ok" }`

Notable behavior:
- Appends a new `TrackingEvent` to the shipment.
- Updates `Shipment.status` to the mapped `ShipmentStatus`.
- On `delivered`, transitions the linked order to `DELIVERED` and sends delivery confirmation to client.

---

### POST /webhooks/web-chat/:widgetId

Receive messages from the embeddable web chat widget.

**Request:** Normalized message from the web chat widget SDK.

```typescript
interface WebChatInboundPayload {
  widgetId: string;
  sessionId: string;           // Browser session identifier
  visitor: {
    name?: string;
    email?: string;
    phone?: string;
  };
  content: MessageContent;
  timestamp: string;
  signature: string;           // HMAC-SHA256 of payload using widget secret
}
```

**Response 200:** `{ status: "ok", messageId: string }`

---

### POST /webhooks/sms/:channelId

Receive inbound SMS from configured gateway (Twilio, Kaleyra, MSG91).

Each gateway has a different payload format; GoSumo normalizes all into `NormalizedMessage`. Signature verification is provider-specific.

**Response 200:** `{ status: "ok" }` (or provider-specific acknowledgment format)

---

## Appendix A: TypeScript Utility Types (Shared)

```typescript
// Used across all modules
type UUID = string;
type ISODateTime = string;   // ISO 8601 string e.g. "2026-06-26T10:30:00.000Z"
type Currency = string;      // ISO 4217 e.g. "INR"
type Paise = number;         // INR in smallest unit (1 INR = 100 paise)

// All create/update requests exclude server-set fields
type CreateRequest<T> = Omit<T, 'id' | 'businessId' | 'createdAt' | 'updatedAt'>;
type UpdateRequest<T> = Partial<CreateRequest<T>>;
```

---

## Appendix B: WebSocket Events

The WebSocket server (`wss://api.gosumo.ai`) is used for real-time dashboard updates. Authentication uses the same JWT via handshake query parameter: `?token=<access_token>`.

All events are namespaced by `businessId` (enforced server-side, not sent by client).

**Server → Client events:**

```typescript
// New inbound message received in any conversation
'message:received' → { message: Message; conversationId: string }

// Outbound message status updated
'message:status' → { messageId: string; status: MessageStatus; conversationId: string }

// Conversation status changed
'conversation:updated' → { conversationId: string; status: ConversationStatus; assignedTo?: string }

// New HITL task created
'hitl:task:created' → { task: HitlTask }

// HITL task resolved
'hitl:task:resolved' → { taskId: string; resolution: HitlResolution }

// AI made a decision
'ai:decision' → { decision: AiDecision }

// Campaign progress update
'campaign:progress' → { campaignId: string; stats: CampaignStats }

// Payment received
'payment:received' → { paymentId: string; orderId?: string; amount: number }

// Typing indicator from client (channel-supported only)
'conversation:typing' → { conversationId: string; isTyping: boolean }
```

**Client → Server events:**

```typescript
// Join a room for a specific conversation (to receive its real-time events)
'conversation:join' → { conversationId: string }

// Leave a conversation room
'conversation:leave' → { conversationId: string }

// Send typing indicator to client
'conversation:typing:send' → { conversationId: string }
```

---

## Appendix C: Response Envelope

For consistency, all single-resource responses return the resource directly (not wrapped). List responses use the `PaginatedResponse<T>` envelope. Action endpoints (e.g., `/resolve`, `/cancel`) return the mutated resource.

```
GET    /clients/:id        → Client
POST   /clients            → Client
PATCH  /clients/:id        → Client
DELETE /clients/:id        → 204 No Content

GET    /clients            → PaginatedResponse<Client>
POST   /clients/search     → PaginatedResponse<Client>

POST   /bookings/:id/cancel → Booking   (mutated resource)
POST   /orders/:id/confirm  → Order     (mutated resource)
```
