# Module: auth

Owns all authentication and authorization for GoSumo's operator-facing dashboard. Issues and validates JWT tokens, enforces mandatory TOTP-based 2FA, manages RBAC (OWNER / MANAGER / STAFF / VIEWER), and tracks active sessions.

## Purpose

Secure dashboard access. This module handles operator identity only — customer (end-client) identity is managed by `client-intelligence`. Operators are `team_members` records; they log in with email + password + TOTP.

## Public API (IAuthService)

```typescript
register(dto): Promise<AuthTokensDto>
login(dto): Promise<{ requiresMfa: boolean; mfaToken?: string; tokens?: AuthTokensDto }>
verifyMfa(dto): Promise<AuthTokensDto>
refreshTokens(refreshToken): Promise<AuthTokensDto>
logout(userId, sessionId): Promise<void>
logoutAll(userId): Promise<void>
setupMfa(userId): Promise<MfaSetupDto>         // returns QR code URL + secret
confirmMfa(userId, totp): Promise<{ backupCodes: string[] }>
disableMfa(userId, totp): Promise<void>
requestPasswordReset(email): Promise<void>
resetPassword(dto): Promise<void>
changePassword(userId, dto): Promise<void>
getActiveSessions(userId): Promise<SessionDto[]>
revokeSession(userId, sessionId): Promise<void>
getUserPermissions(userId, businessId): Promise<PermissionsDto>
assignRole(dto): Promise<void>
removeRole(userId, businessId): Promise<void>
```

## Events

**Emits:** none (auth events are written to `audit_logs`, not broadcast as domain events)

**Listens to:** none

## Tables Owned

- `team_members` — operator accounts with hashed passwords and encrypted TOTP secrets
- (Sessions stored in Redis: `gosumo:session:{userId}:{sessionId}` with TTL matching refresh token expiry)

## Dependencies

- `@gosumo/shared` — `TeamMemberRole`, `TenantContext`
- `@nestjs/passport`, `passport-jwt`, `passport-local`
- `bcrypt` — password hashing (cost factor 12)
- `otplib` — TOTP generation and verification
- `jsonwebtoken` — token signing (RS256)
- Redis — session invalidation blacklist, login rate limiting

## Test Command

```bash
pnpm --filter @gosumo/api test --testPathPattern=modules/auth
```

## Key Gotchas

- **MFA is mandatory** — no user can access any protected route without TOTP configured and verified. The login flow has two phases: phase 1 returns a short-lived `mfaToken`, phase 2 exchanges it for full JWT tokens
- **Access token TTL: 15 minutes** — stored in memory (not localStorage); refresh token is HttpOnly cookie with 7-day TTL
- **Maximum 5 concurrent sessions** per user — evict the oldest session on 6th login
- **Password policy:** min 8 chars, 1 uppercase, 1 number, 1 special character — enforce with `class-validator` on `RegisterDto` and `ChangePasswordDto`
- **TOTP secret is encrypted at rest** — `team_members.totp_secret` uses AES-256 via KMS; never store the raw secret
- **Rate limiting:** 5 failed login attempts → 15-minute lockout via Redis. Use `gosumo:{email}:login_attempts` key
- **`businessId` in JWT must match the resource being accessed** — cross-tenant access is forbidden even for valid tokens; the `TenantInterceptor` in the API app enforces this
- **Role hierarchy:** OWNER > MANAGER > STAFF > VIEWER. `@Roles(TeamMemberRole.MANAGER)` means OWNER and MANAGER can access; STAFF cannot
- `@Public()` decorator marks routes that skip `JwtAuthGuard` — webhook endpoints and the login/register endpoints must use it
