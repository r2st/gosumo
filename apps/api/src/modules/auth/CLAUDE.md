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
- **Every token carries a `type` claim (`access` / `refresh`)** — both halves of a pair are signed with the same secret and are otherwise claim-identical, so each consumer states which one it wants: `JwtStrategy` admits only `access`, `refreshTokens()` refuses `access`. Without it a refresh token was a working bearer credential for seven days, and rotating one bought nothing because the retired token still authenticated. Tokens signed before the claim existed are refused by the bearer guard and still accepted at `/auth/refresh`, which is what upgrades a client's pair in place instead of logging it out
- **Maximum 5 concurrent sessions** per user — evict the oldest session on 6th login. The new session is indexed *first* and the index is then trimmed by rank in one `ZREMRANGEBYRANK`; counting before inserting is a check-then-act that concurrent logins push past the cap permanently. Index scores are monotonic per process, so same-millisecond logins cannot rank a brand-new session as the oldest
- **A session's Redis key and its sorted-set index entry expire together** — `touch()` extends both. The index is the only record that a session exists, so an index entry that expires under a live session leaves one `revokeAllSessions` (logout-all, change password, password reset) cannot see and `isActive` still admits
- **Password policy:** min 8 chars, 1 uppercase, 1 number, 1 special character — enforce with `class-validator` on `RegisterDto` and `ChangePasswordDto`
- **TOTP secret is encrypted at rest** — `team_members.totp_secret` uses AES-256 via KMS; never store the raw secret
- **Rate limiting:** 5 failed login attempts → 15-minute lockout via Redis. Use `gosumo:{email}:login_attempts` key. **`INCR` creates that key with no expiry**, so the `EXPIRE` is issued on *every* failed attempt with `NX` (a no-op once a TTL exists) rather than only when the counter came back `1`. Applying it once left the key permanent whenever that single command did not land — a restart between the two round trips, or a rejected `EXPIRE` — and the surviving counter only ever climbs: Redis holds it forever and that address can never log in again. `NX` rather than a bare `EXPIRE` because the window is fixed: refreshing it per failure would let someone hold a victim locked out indefinitely by failing one login every fourteen minutes. `assertNotLockedOut` runs first and throws, so it carries the same repair for a counter already at the ceiling with `TTL == -1` — otherwise the fix above is unreachable for exactly the keys that need it, and `Math.ceil(-1 / 60)` reported a phantom "1 minute" countdown forever
- **`businessId` in JWT must match the resource being accessed** — cross-tenant access is forbidden even for valid tokens; the `TenantInterceptor` in the API app enforces this
- **Role hierarchy:** OWNER > MANAGER > STAFF > VIEWER. `@Roles(TeamMemberRole.MANAGER)` means OWNER and MANAGER can access; STAFF cannot
- `@Public()` decorator marks routes that skip `JwtAuthGuard` — webhook endpoints and the login/register endpoints must use it
