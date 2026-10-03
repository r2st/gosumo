import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { AuthRepository, TeamMemberWithBusiness } from './auth.repository';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { maskEmail } from '../../common/utils/log-redact.util';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SessionDto } from './dto/session.dto';
import { SessionService, SessionMeta } from './session.service';
import { REDIS_CLIENT, RedisClient } from './redis.provider';
import { JwtPayload } from './strategies/jwt.strategy';
import { GoogleProfile } from './strategies/google.strategy';
import { GitHubProfile } from './strategies/github.strategy';
import { MicrosoftProfile } from './strategies/microsoft.strategy';

const ACCESS_TOKEN_TTL = '15m';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL = '7d';
/**
 * bcrypt work factor. 12 is the production cost and is deliberately *not*
 * configurable — a mis-set environment variable must never be able to weaken
 * stored password hashes.
 *
 * Under `NODE_ENV=test` the cost drops to 4. A single cost-12 hash burns ~265ms
 * of CPU, and because bcryptjs is pure JS it blocks the worker's event loop for
 * that whole time; a suite of jest workers all hashing at once starves each
 * other badly enough to blow the default 5s per-test timeout. Cost 4 is ~60x
 * cheaper and keeps the assertions honest: `bcrypt.compare` reads the cost from
 * the hash itself, so verification behaviour is identical at any cost.
 */
const PRODUCTION_BCRYPT_COST = 12;
const TEST_BCRYPT_COST = 4;

export function resolveBcryptCost(env: NodeJS.ProcessEnv = process.env): number {
  return env['NODE_ENV'] === 'test' ? TEST_BCRYPT_COST : PRODUCTION_BCRYPT_COST;
}

/** Login throttling — 5 failed attempts within the window triggers a lockout. */
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_LOCKOUT_SECONDS = 15 * 60;

/** Password-reset tokens live for one hour. */
const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

/**
 * The one spelling of an email address the auth layer works in.
 *
 * Every lookup in `AuthRepository` already lowercases what it is given, so an
 * address that reaches storage or a Redis key in its original case is a second,
 * invisible identity for the same account. That produced three separate
 * defects:
 *
 *   - The login lockout keys on the address. `Bob@acme.in` and `bob@acme.in`
 *     were different keys against the same account, so a guesser who varied the
 *     case got a fresh five-attempt budget per spelling and the lockout — the
 *     one control designed to survive an attacker spreading across many IPs —
 *     never fired.
 *   - `forgot-password`'s per-address ceiling keys on the same value, so the
 *     same trick mailed one victim as often as the attacker liked.
 *   - Registration *stored* the raw case while every lookup searched lowercase.
 *     `Bob@acme.in` passed the duplicate check against an existing
 *     `bob@acme.in` and then could never log in, because its own login lookup
 *     searched for a row that did not exist.
 *
 * Normalising once, at the boundary, is what makes those three the same bug.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const loginAttemptsKey = (email: string): string => `gosumo:${email}:login_attempts`;
const passwordResetKey = (tokenHash: string): string => `gosumo:pwreset:${tokenHash}`;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly sessionService: SessionService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
  ) {}

  // ─────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────

  async register(dto: RegisterDto, meta: SessionMeta = {}): Promise<AuthTokensDto> {
    const { password, businessName } = dto;
    const email = normalizeEmail(dto.email);

    const existing = await this.authRepository.findTeamMemberByEmail(email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const emailTaken = await this.authRepository.isBusinessEmailTaken(email);
    if (emailTaken) {
      throw new ConflictException('A business with this email already exists');
    }

    const slug = await this.buildUniqueSlug(businessName);
    const passwordHash = await this.hashPassword(password);
    const name = dto.name?.trim() || email.split('@')[0] || 'User';

    const teamMember = await this.authRepository.createTeamMemberWithBusiness(
      email,
      name,
      passwordHash,
      businessName,
      slug,
    );

    this.logger.log(`New registration: ${maskEmail(email)} for business '${businessName}'`);

    return this.issueTokensForNewSession(teamMember, meta);
  }

  // ─────────────────────────────────────────────
  // Login (local)
  // ─────────────────────────────────────────────

  async login(dto: LoginDto, meta: SessionMeta = {}): Promise<AuthTokensDto> {
    const { password } = dto;
    const email = normalizeEmail(dto.email);

    await this.assertNotLockedOut(email);

    const teamMember = await this.authRepository.findTeamMemberByEmail(email);
    if (!teamMember || !teamMember.password_hash) {
      // Same response whether the account is missing or password-less (OAuth-only),
      // to avoid leaking which emails exist — and the same *cost*, which the
      // identical wording alone did not buy. See `dummyPasswordHash`.
      await this.verifyPassword(password, await this.dummyPasswordHash());
      await this.recordFailedAttempt(email);
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await this.verifyPassword(password, teamMember.password_hash);
    if (!isPasswordValid) {
      await this.recordFailedAttempt(email);
      throw new UnauthorizedException('Invalid email or password');
    }

    // Suspension is disclosed only to someone who has just proved they own the
    // account. Checked before the password, it was an enumeration oracle that
    // needed no credential at all: any caller could ask "is this address a
    // suspended GoSumo account?" and read the answer off the message, since a
    // wrong password against a suspended account still answered "Account has
    // been suspended" while every other address answered "Invalid email or
    // password". It was the timing leak below in miniature — the suspended
    // path returned without ever reaching bcrypt — and it also meant those
    // attempts were never charged against the lockout, so that one address
    // could be guessed at without limit.
    if (teamMember.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account has been suspended');
    }

    await this.clearFailedAttempts(email);

    this.authRepository
      .updateLastLogin(teamMember.business_id, teamMember.id)
      .catch((err: Error) => {
        this.logger.warn(`Failed to update last login for ${teamMember.id}: ${err.message}`);
      });

    this.logger.log(`Login: ${maskEmail(email)}`);

    return this.issueTokensForNewSession(teamMember, meta);
  }

  // ─────────────────────────────────────────────
  // Login / sign-up via Google OAuth
  // ─────────────────────────────────────────────

  async handleGoogleLogin(
    rawProfile: GoogleProfile,
    meta: SessionMeta = {},
  ): Promise<AuthTokensDto> {
    // Google is free to echo back whatever case the user typed at the consent
    // screen; linking to an existing local account depends on the address
    // matching the one already stored.
    const profile: GoogleProfile = { ...rawProfile, email: normalizeEmail(rawProfile.email) };

    // 1) Already linked to this Google account → straight login.
    let teamMember = await this.authRepository.findTeamMemberByGoogleId(profile.googleId);

    if (!teamMember) {
      // 2) Existing local account with the same email → link Google to it.
      const byEmail = await this.authRepository.findTeamMemberByEmail(profile.email);
      if (byEmail) {
        teamMember = await this.authRepository.linkGoogleAccount(
          byEmail.business_id,
          byEmail.id,
          profile.googleId,
          profile.avatarUrl,
        );
        this.logger.log(`Linked Google account to existing user ${maskEmail(profile.email)}`);
      }
    }

    if (!teamMember) {
      // 3) Brand-new user → provision a business + owner from the Google profile.
      const businessName = profile.name || profile.email.split('@')[0] || 'My Business';
      const slug = await this.buildUniqueSlug(businessName);
      teamMember = await this.authRepository.createOAuthTeamMemberWithBusiness(
        profile.email,
        profile.name,
        businessName,
        slug,
        profile.googleId,
        profile.avatarUrl,
      );
      this.logger.log(`New Google registration: ${maskEmail(profile.email)}`);
    }

    if (teamMember.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account has been suspended');
    }

    this.authRepository
      .updateLastLogin(teamMember.business_id, teamMember.id)
      .catch((err: Error) => {
        this.logger.warn(`Failed to update last login for ${teamMember.id}: ${err.message}`);
      });

    return this.issueTokensForNewSession(teamMember, meta);
  }

  // ─────────────────────────────────────────────
  // Login / sign-up via GitHub OAuth
  // ─────────────────────────────────────────────

  async handleGitHubLogin(
    rawProfile: GitHubProfile,
    meta: SessionMeta = {},
  ): Promise<AuthTokensDto> {
    const profile: GitHubProfile = { ...rawProfile, email: normalizeEmail(rawProfile.email) };

    let teamMember = await this.authRepository.findTeamMemberByGithubId(profile.githubId);

    if (!teamMember) {
      const byEmail = await this.authRepository.findTeamMemberByEmail(profile.email);
      if (byEmail) {
        teamMember = await this.authRepository.linkGithubAccount(
          byEmail.business_id,
          byEmail.id,
          profile.githubId,
          profile.avatarUrl,
        );
        this.logger.log(`Linked GitHub account to existing user ${maskEmail(profile.email)}`);
      }
    }

    if (!teamMember) {
      const businessName = profile.name || profile.email.split('@')[0] || 'My Business';
      const slug = await this.buildUniqueSlug(businessName);
      teamMember = await this.authRepository.createOAuthTeamMemberWithBusinessForGithub(
        profile.email,
        profile.name,
        businessName,
        slug,
        profile.githubId,
        profile.avatarUrl,
      );
      this.logger.log(`New GitHub registration: ${maskEmail(profile.email)}`);
    }

    if (teamMember.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account has been suspended');
    }

    this.authRepository
      .updateLastLogin(teamMember.business_id, teamMember.id)
      .catch((err: Error) => {
        this.logger.warn(`Failed to update last login for ${teamMember.id}: ${err.message}`);
      });

    return this.issueTokensForNewSession(teamMember, meta);
  }

  // ─────────────────────────────────────────────
  // Login / sign-up via Microsoft OAuth
  // ─────────────────────────────────────────────

  async handleMicrosoftLogin(
    rawProfile: MicrosoftProfile,
    meta: SessionMeta = {},
  ): Promise<AuthTokensDto> {
    const profile: MicrosoftProfile = { ...rawProfile, email: normalizeEmail(rawProfile.email) };

    let teamMember = await this.authRepository.findTeamMemberByMicrosoftId(profile.microsoftId);

    if (!teamMember) {
      const byEmail = await this.authRepository.findTeamMemberByEmail(profile.email);
      if (byEmail) {
        teamMember = await this.authRepository.linkMicrosoftAccount(
          byEmail.business_id,
          byEmail.id,
          profile.microsoftId,
        );
        this.logger.log(`Linked Microsoft account to existing user ${maskEmail(profile.email)}`);
      }
    }

    if (!teamMember) {
      const businessName = profile.name || profile.email.split('@')[0] || 'My Business';
      const slug = await this.buildUniqueSlug(businessName);
      teamMember = await this.authRepository.createOAuthTeamMemberWithBusinessForMicrosoft(
        profile.email,
        profile.name,
        businessName,
        slug,
        profile.microsoftId,
      );
      this.logger.log(`New Microsoft registration: ${maskEmail(profile.email)}`);
    }

    if (teamMember.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account has been suspended');
    }

    this.authRepository
      .updateLastLogin(teamMember.business_id, teamMember.id)
      .catch((err: Error) => {
        this.logger.warn(`Failed to update last login for ${teamMember.id}: ${err.message}`);
      });

    return this.issueTokensForNewSession(teamMember, meta);
  }

  // ─────────────────────────────────────────────
  // Refresh tokens
  // ─────────────────────────────────────────────

  async refreshTokens(refreshToken: string): Promise<AuthTokensDto> {
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken);
    } catch (err) {
      this.logger.debug(`Refresh token rejected: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!payload.sessionId) {
      throw new UnauthorizedException('Refresh token is not bound to a session');
    }

    // The mirror of the check in `JwtStrategy`: an access token is not a
    // refresh token. A type-less token predates the claim and is still
    // honoured here — that is what lets a client holding an old pair recover
    // its now-rejected access token without being logged out.
    if (payload.type === 'access') {
      throw new UnauthorizedException('An access token cannot be exchanged for new tokens');
    }

    const matches = await this.sessionService.verifyRefreshToken(
      payload.sub,
      payload.sessionId,
      refreshToken,
    );
    if (!matches) {
      // Either the session is gone (revoked/expired) or the token was rotated —
      // treat as a potential reuse and revoke the session defensively.
      await this.sessionService.revokeSession(payload.sub, payload.sessionId);
      this.logger.warn(`Refresh rejected for user ${payload.sub} (session ${payload.sessionId})`);
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    const teamMember = await this.authRepository.findTeamMemberById(
      payload.businessId,
      payload.sub,
    );
    if (!teamMember) {
      throw new UnauthorizedException('User account not found');
    }
    if (teamMember.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account has been suspended');
    }

    return this.rotateTokensForSession(teamMember, payload.sessionId);
  }

  // ─────────────────────────────────────────────
  // Logout / session management
  // ─────────────────────────────────────────────

  async logout(userId: string, sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.sessionService.revokeSession(userId, sessionId);
    } else {
      await this.sessionService.revokeAllSessions(userId);
    }
    this.logger.log(`Logout: user ${userId}${sessionId ? ` (session ${sessionId})` : ' (all)'}`);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.sessionService.revokeAllSessions(userId);
    this.logger.log(`Logout all sessions: user ${userId}`);
  }

  async getActiveSessions(userId: string, currentSessionId?: string): Promise<SessionDto[]> {
    return this.sessionService.listSessions(userId, currentSessionId);
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.sessionService.revokeSession(userId, sessionId);
    this.logger.log(`Revoked session ${sessionId} for user ${userId}`);
  }

  // ─────────────────────────────────────────────
  // Profile
  // ─────────────────────────────────────────────

  async getProfile(
    businessId: string,
    userId: string,
  ): Promise<{
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    authProvider: string;
    avatarUrl: string | null;
    businessId: string;
    businessName: string;
    businessSlug: string;
    lastLoginAt: Date | null;
    loginCount: number;
  }> {
    const teamMember = await this.authRepository.findTeamMemberById(businessId, userId);
    if (!teamMember) {
      throw new NotFoundException('User not found');
    }

    return {
      id: teamMember.id,
      email: teamMember.email,
      name: teamMember.name,
      role: teamMember.role,
      status: teamMember.status,
      authProvider: teamMember.auth_provider,
      avatarUrl: teamMember.avatar_url,
      businessId: teamMember.business_id,
      businessName: teamMember.business.name,
      businessSlug: teamMember.business.slug,
      lastLoginAt: teamMember.last_login_at,
      loginCount: teamMember.login_count,
    };
  }

  // ─────────────────────────────────────────────
  // Change password
  // ─────────────────────────────────────────────

  async changePassword(
    businessId: string,
    userId: string,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const teamMember = await this.authRepository.findTeamMemberById(businessId, userId);
    if (!teamMember) {
      throw new NotFoundException('User not found');
    }
    if (!teamMember.password_hash) {
      throw new BadRequestException('Account is not set up for password login');
    }

    const isValid = await this.verifyPassword(dto.currentPassword, teamMember.password_hash);
    if (!isValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const newHash = await this.hashPassword(dto.newPassword);
    await this.authRepository.updateTeamMember(businessId, userId, {
      password_hash: newHash,
    });

    // Force re-login everywhere after a password change.
    await this.sessionService.revokeAllSessions(userId);

    this.logger.log(`Password changed for user ${userId}`);
  }

  // ─────────────────────────────────────────────
  // Password reset flow
  // ─────────────────────────────────────────────

  /**
   * Begin a password reset. Always resolves the same way regardless of whether
   * the email exists, so the endpoint cannot be used to enumerate accounts.
   * In production the token is emailed; here it is stored (hashed) in Redis.
   */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const teamMember = await this.authRepository.findTeamMemberByEmail(email);
    if (!teamMember || !teamMember.password_hash) {
      this.logger.debug(`Password reset requested for unknown/OAuth email ${maskEmail(email)} — no-op`);
      return;
    }

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    // Store the tenant alongside the user so the redemption path can scope its
    // lookup and its write. A bare user id would force an unscoped read.
    await this.redis.set(
      passwordResetKey(tokenHash),
      `${teamMember.business_id}:${teamMember.id}`,
      'EX',
      PASSWORD_RESET_TTL_SECONDS,
    );

    // TODO: dispatch via the notification/email service once available. Until
    // then the link is printed for local development only.
    //
    // It must never reach a production log. `token` is a live, single-use
    // credential for the account: anyone who can read the application log —
    // log aggregation, a crash reporter's breadcrumbs, `journalctl` on the
    // box — could redeem it within the TTL and take the account over without
    // ever touching the mailbox. Production gets the fact that a reset was
    // requested and nothing that can be redeemed.
    if (this.configService.get<string>('app.env', 'development') === 'production') {
      this.logger.log(`Password reset requested for ${maskEmail(email)} — link dispatched`);
      return;
    }

    const frontendUrl = this.configService.get<string>('app.frontendUrl', 'http://localhost:3001');
    this.logger.log(
      `Password reset link generated for ${maskEmail(email)}: ${frontendUrl}/reset-password?token=${token}`,
    );
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const tokenHash = this.hashToken(dto.token);
    const key = passwordResetKey(tokenHash);

    const stored = await this.redis.get(key);
    if (!stored) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // `businessId:userId`. A value in any other shape predates the tenant-scoped
    // format and is refused rather than redeemed without a tenant.
    const separator = stored.indexOf(':');
    if (separator <= 0) {
      await this.redis.del(key);
      throw new BadRequestException('Invalid or expired reset token');
    }
    const businessId = stored.slice(0, separator);
    const userId = stored.slice(separator + 1);
    if (!userId) {
      await this.redis.del(key);
      throw new BadRequestException('Invalid or expired reset token');
    }

    const teamMember = await this.authRepository.findTeamMemberById(businessId, userId);
    if (!teamMember) {
      await this.redis.del(key);
      throw new BadRequestException('Invalid or expired reset token');
    }

    const newHash = await this.hashPassword(dto.newPassword);
    await this.authRepository.updateTeamMember(businessId, userId, {
      password_hash: newHash,
    });

    // Single-use token + revoke every session so old credentials are dead.
    await this.redis.del(key);
    await this.sessionService.revokeAllSessions(userId);

    this.logger.log(`Password reset completed for user ${userId}`);
  }

  // ─────────────────────────────────────────────
  // Token / session helpers
  // ─────────────────────────────────────────────

  private async issueTokensForNewSession(
    teamMember: TeamMemberWithBusiness,
    meta: SessionMeta,
  ): Promise<AuthTokensDto> {
    const sessionId = randomUUID();
    const tokens = await this.signTokens(teamMember, sessionId);
    await this.sessionService.createSession(
      teamMember.id,
      teamMember.business_id,
      sessionId,
      tokens.refreshToken,
      meta,
    );
    return tokens;
  }

  private async rotateTokensForSession(
    teamMember: TeamMemberWithBusiness,
    sessionId: string,
  ): Promise<AuthTokensDto> {
    const tokens = await this.signTokens(teamMember, sessionId);
    await this.sessionService.rotateRefreshToken(teamMember.id, sessionId, tokens.refreshToken);
    return tokens;
  }

  private async signTokens(
    teamMember: TeamMemberWithBusiness,
    sessionId: string,
  ): Promise<AuthTokensDto> {
    const payload: Omit<JwtPayload, 'jti' | 'type'> = {
      sub: teamMember.id,
      businessId: teamMember.business_id,
      email: teamMember.email,
      role: teamMember.role,
      sessionId,
    };

    // A distinct `jti` per token. Without one, every claim that varies between a
    // token and its replacement is derived from the clock: refresh tokens keep
    // the same `sessionId` by design, and `iat`/`exp` are whole seconds. Two
    // rotations landing in the same second therefore produced two byte-identical
    // refresh tokens, which defeats rotation detection entirely — the old token
    // still hashes to the stored value, so replaying it looks legitimate and the
    // session is never revoked. Signing each token with its own UUID guarantees
    // uniqueness without depending on how fast the caller refreshes.
    //
    // The access and refresh token get *different* ids as well, so a token can
    // be identified as one or the other by id alone (needed by any future
    // per-token denylist, which must not kill both halves of a pair at once).
    //
    // `type` is what lets each consumer tell the two apart. `jti` makes them
    // unique but says nothing about what a token is *for*, and every other
    // claim is identical by design — so the bearer guard accepted a refresh
    // token as an access token, and this endpoint would have accepted an
    // access token as a refresh token had its hash ever matched. Each side now
    // states which half it wants.
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        { ...payload, type: 'access', jti: randomUUID() },
        { expiresIn: ACCESS_TOKEN_TTL },
      ),
      this.jwtService.signAsync(
        { ...payload, type: 'refresh', jti: randomUUID() },
        { expiresIn: REFRESH_TOKEN_TTL },
      ),
    ]);

    const tokens = new AuthTokensDto();
    tokens.accessToken = accessToken;
    tokens.refreshToken = refreshToken;
    tokens.expiresIn = ACCESS_TOKEN_TTL_SECONDS;
    return tokens;
  }

  // ─────────────────────────────────────────────
  // Login throttling
  // ─────────────────────────────────────────────

  /**
   * Refuse a login while the address is inside its lockout window.
   *
   * A counter that is at the ceiling but carries no TTL (`-1`) is repaired here
   * rather than trusted. `recordFailedAttempt` is the normal place the window is
   * applied, but this method runs *first* and throws — so an address that ever
   * reached the ceiling without a TTL would never reach the repair below, and a
   * key with no expiry is a permanent lockout. The user is not even told that:
   * `Math.ceil(-1 / 60)` is `0`, so the floor of one reported a countdown of
   * "1 minute" on every attempt, forever. Stamping the window on discovery
   * makes the worst case a single full lockout that then drains normally.
   *
   * `-2` is the other negative `TTL` reply and means the key is already gone —
   * it expired between the `get` and the `ttl`. There is nothing to lock out
   * and nothing to repair, so the attempt proceeds.
   */
  private async assertNotLockedOut(email: string): Promise<void> {
    const key = loginAttemptsKey(email);
    const attempts = await this.redis.get(key);
    if (!attempts || parseInt(attempts, 10) < MAX_LOGIN_ATTEMPTS) return;

    let ttl = await this.redis.ttl(key);
    if (ttl === -2) return;
    if (ttl < 0) {
      await this.redis.expire(key, LOGIN_LOCKOUT_SECONDS);
      ttl = LOGIN_LOCKOUT_SECONDS;
    }

    const minutes = Math.max(1, Math.ceil(ttl / 60));
    throw new UnauthorizedException(
      `Too many failed login attempts. Try again in ${minutes} minute(s).`,
    );
  }

  /**
   * Charge one failed attempt against the address, opening the lockout window
   * on the first.
   *
   * The `EXPIRE` is issued on *every* attempt, with `NX` making it a no-op once
   * a TTL exists. Applying it only when the counter came back `1` left the key
   * permanent whenever that one command did not land — the process restarting
   * between the two round trips, or the `EXPIRE` itself failing (the client
   * retries a command three times and then rejects, and this runs on a path
   * that is already handling a failure). `INCR` creates the key with no expiry,
   * so what survived was a counter that only ever climbs: Redis holds it
   * forever, and after five attempts that address can never log in again.
   *
   * `NX` rather than a bare `EXPIRE` because the window is fixed, not sliding.
   * Refreshing it on each failure would let someone hold a victim's address
   * locked out indefinitely by failing one login every fourteen minutes.
   */
  private async recordFailedAttempt(email: string): Promise<void> {
    const key = loginAttemptsKey(email);
    await this.redis.incr(key);
    await this.redis.expire(key, LOGIN_LOCKOUT_SECONDS, 'NX');
  }

  private async clearFailedAttempts(email: string): Promise<void> {
    await this.redis.del(loginAttemptsKey(email));
  }

  // ─────────────────────────────────────────────
  // Crypto / slug helpers
  // ─────────────────────────────────────────────

  /**
   * A bcrypt hash of a value nobody can present, compared against on the login
   * path for an address that has no stored hash.
   *
   * Returning the same *message* for "no such account" and "wrong password" is
   * only half of not leaking which addresses exist. The other half is the
   * clock. A real account spends a cost-12 bcrypt verification — ~265ms of
   * pure JS on this runtime — before it can answer; a missing or OAuth-only
   * address reached the throw having done one indexed query. That is a two
   * orders of magnitude gap on a `@Public()`, unauthenticated route: it needs
   * no statistics to read, survives any amount of network jitter, and turns
   * the login endpoint into a bulk account-existence oracle for any address
   * list an attacker cares to bring. The lockout does not contain it either —
   * five attempts per address is four more than reading the answer takes.
   *
   * Comparing against a hash instead of sleeping a fixed interval keeps the two
   * paths the same work rather than approximately the same duration, so the
   * cost tracks {@link resolveBcryptCost} automatically.
   *
   * Built once per process and memoised as the *promise*, so concurrent first
   * logins share one derivation rather than each paying for their own.
   */
  private dummyHashPromise: Promise<string> | null = null;

  private dummyPasswordHash(): Promise<string> {
    this.dummyHashPromise ??= bcrypt.hash(randomUUID(), resolveBcryptCost());
    return this.dummyHashPromise;
  }

  private async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, resolveBcryptCost());
  }

  private async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  private async buildUniqueSlug(businessName: string): Promise<string> {
    const base = this.slugify(businessName) || 'business';
    const taken = await this.authRepository.isSlugTaken(base);
    return taken ? `${base}-${crypto.randomBytes(3).toString('hex')}` : base;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
