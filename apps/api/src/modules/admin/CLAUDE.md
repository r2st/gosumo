# Module: admin

GoSumo internal admin backend — used by the GoSumo operations team (not by tenant businesses) to manage the platform itself. Provides visibility into all tenants, platform health, usage metrics, and billing operations.

## Purpose

Enable the GoSumo ops team to: view and manage all business accounts, monitor platform-wide usage and errors, manage subscription plans, impersonate businesses for support, and trigger platform-level maintenance operations.

## Public API (IAdminService)

```typescript
// Business management
listAllBusinesses(query): Promise<PaginatedResult<AdminBusinessDto>>
getBusinessDetail(businessId): Promise<AdminBusinessDetailDto>
suspendBusiness(businessId, reason): Promise<void>
activateBusiness(businessId): Promise<void>
updateBusinessPlan(businessId, plan): Promise<void>

// Platform metrics
getPlatformStats(): Promise<PlatformStatsDto>
getUsageByBusiness(businessId, query): Promise<UsageStatsDto>
getErrorReport(query): Promise<ErrorReportDto>

// Support operations
impersonateSession(adminUserId, businessId): Promise<string>  // returns short-lived support token
```

## Events

**Emits:** none

**Listens to:** none (reads platform-level data directly)

## Tables Owned

None. Admin reads from other modules' tables with elevated (read-only) access. Admin operations that mutate data (suspend, plan change) call the relevant module services directly.

## Dependencies

- All other modules (read access for platform-wide reporting)
- `@gosumo/auth` — admin users have a special `PLATFORM_ADMIN` role stored in `team_members` for the GoSumo internal business
- `@gosumo/tenant` — for business management operations

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/admin
```

## Key Gotchas

- **This module is for GoSumo internal use only** — all admin routes must be protected by `@Roles(TeamMemberRole.OWNER)` AND must verify the user belongs to the GoSumo internal business (not a tenant)
- **Impersonation tokens** are short-lived (15 minutes), scoped to one business, and every action taken during an impersonation session is recorded in `audit_logs` with `actor_type: 'ADMIN_SUPPORT'`
- **Never expose raw PII** in admin reports — mask phone numbers and emails unless explicitly needed for support cases
- **No cross-tenant mutation** — admin can read across tenants but should delegate mutations to the owning module's service methods, which enforce business-level validation
- Admin endpoints are not included in the public Swagger docs — exclude with `@ApiExcludeController()` or move to a separate admin API app in the future
- All admin actions must be written to `audit_logs` — use the `AuditService` (shared utility) on every mutating operation
