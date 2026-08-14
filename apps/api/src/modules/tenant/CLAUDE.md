# Module: tenant

Manages business profiles and multi-tenant configuration. Each "business" in GoSumo is a tenant. This module owns business onboarding, profile data, channel account connections, AI behavior settings, and business policies. The authority on what a business looks like and how it behaves.

## Purpose

Create and configure businesses (tenants), connect messaging channels (which WhatsApp/Instagram/SMS accounts belong to this business), configure AI thresholds, set refund/SLA policies, and manage team membership.

## Public API

```typescript
// TenantService — lifecycle, profile, AI config, channels, members, policies
createBusiness(dto, ownerId, ownerEmail?): Promise<businesses>   // + founding OWNER, emits business.created
suspendBusiness(businessId, dto?) / activateBusiness(businessId)  // emits business.suspended / .activated
getBusinessById / updateBusiness
getAIConfig / updateAIConfig
connectChannel / disconnectChannel / getChannelConnections        // resource-quota gated
getMembers / inviteMember / removeMember                          // resource-quota gated
getPolicies / updatePolicies
getBusinessRules

// SubscriptionService — tier management
getPlanCatalog() / getSubscription(businessId)
changePlan(businessId, dto)                                       // downgrade blocked by live usage; emits business.plan.changed

// UsageService — usage tracking & quota enforcement
getUsage(businessId)                                              // resource + monthly metrics vs limits
assertWithinQuota / hasQuota(businessId, metric, n)              // throws QuotaExceededException (402)
incrementUsage(businessId, metric, n) / resetMonthlyUsage         // monthly counters in profile.usage

// OnboardingService — ordered onboarding flow
getOnboardingStatus(businessId)
completeStep(businessId, step)                                    // sequential; emits onboarding events
```

## Plan tiers

`SubscriptionTier`: `free | starter | growth | scale | enterprise` (see `tenant.constants.ts` `PLAN_CATALOG`,
the single source of truth for limits + features). `free`/`enterprise` bracket the historical
`starter`/`growth`/`scale` tiers. Limits use `-1` (`UNLIMITED`) for "no cap".

## Tenant isolation middleware

`TenantIsolationMiddleware` (applied to all routes via `TenantModule.configure`) is the application-edge
layer above PostgreSQL RLS: it resolves `businessId` from the JWT, rejects requests with no tenant (401),
blocks any body/query/param `businessId` that disagrees with the token (403 cross-tenant forgery), and sets
`req.tenantId` / `req.tenantContext`. Exempt prefixes: `webhooks`, `auth`, `health`, `api/docs`, `queues`.

## Events

**Emits:**
- `business.created` — `{ businessId, ownerId, businessName, plan }`
- `business.channel.connected` — `{ businessId, channelType, channelAccountId }`
- `business.channel.disconnected` — `{ businessId, channelType }`
- `business.settings.updated` — `{ businessId, changedFields: string[] }`
- `team.member.removed` — `{ businessId, memberId, actorId? }`; emitted by `removeMember` so modules holding that member's work can release it. Conversation assignment has no FK, so nothing in the database follows it.

**Listens to:** none

## Audit trail

Team-membership changes write an append-only `audit_logs` row via the shared
`AuditLogService` (`common/services/audit-log.service.ts`), under
`resource_type: "team_member"`:

| Operation | Action | Diff captured |
|---|---|---|
| `inviteMember` | `CREATE` | `after` = email/name/role/status of the new member |
| `updateRole` (`TeamController`) | `UPDATE` | `before`/`after` = the old and new role |
| `removeMember` | `DELETE` | `before` = the standing that was revoked |

`team_members.role` is a single mutable column, so without this the previous
role — and who changed it — is gone the moment the update lands. Rows are
written **after** the operation commits, and the writer never throws: a failed
audit write is logged, never surfaced as a failed role change.

## Tables Owned

- `businesses` — core tenant record with plan, AI settings JSONB, profile JSONB
- `channel_accounts` — messaging channel connections with encrypted credentials
- (`business_rules` for AI rule configuration are written here too; implemented as part of tenant management)

## Dependencies

- `@gosumo/shared` — `ChannelType`, `TeamMemberRole`
- `@gosumo/auth` — validates membership for invite/remove operations
- AES-256 encryption (via KMS or `@nestjs/config`) for channel credentials at rest

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/tenant
```

## Key Gotchas

- **Channel credentials are encrypted** before storage in `channel_accounts.credentials` JSONB — never log or expose raw credentials; decrypt only when making outbound API calls
- **AI config defaults:** `autoExecuteThreshold: 90`, `reviewThreshold: 70` — stored in `businesses.ai_settings` JSONB; read by `ai-engine` on every message processing
- **Business `slug` is immutable** after creation — auto-generated from business name, URL-safe
- **`autoReplyHours`** can be configured per day of week with start/end time in IST — stored as JSONB; validated that start < end and times are in HH:MM format
- **Plan gates features:** STARTER (1 channel, 3 staff), GROWTH (5 channels, 10 staff), SCALE (unlimited) — enforce in `connectChannel()` and `inviteMember()`
- `getAIConfig()` is called on every AI pipeline invocation — results should be cached in Redis (TTL: 5 minutes); `business.settings.updated` event invalidates the cache
- `getPolicies()` is called on every refund check — also cache in Redis; invalidate on update
- **At least one active channel** is required before a business can go from ONBOARDING → ACTIVE status
- GST number is optional but must match `[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}` when provided
