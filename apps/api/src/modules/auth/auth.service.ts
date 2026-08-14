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
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SessionDto } from './dto/session.dto';
import { SessionService, SessionMeta } from './session.service';
import { REDIS_CLIENT, RedisClient } from './redis.provider';
import { JwtPayload } from './strategies/jwt.strategy';
import { GoogleProfile } from './strategies/google.strategy';

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
    const { email, password, businessName } = dto;

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

    this.logger.log(`New registration: ${email} for business '${businessName}'`);

    return this.issueTokensForNewSession(teamMember, meta);
  }

  // ─────────────────────────────────────────────
  // Login (local)
  // ─────────────────────────────────────────────

  async login(dto: LoginDto, meta: SessionMeta = {}): Promise<AuthTokensDto> {
    const { email, password } = dto;

    await this.assertNotLockedOut(email);

    const teamMember = await this.authRepository.findTeamMemberByEmail(email);
    if (!teamMember || !teamMember.password_hash) {
      // Same response whether the account is missing or password-less (OAuth-only),
      // to avoid leaking which emails exist.
      await this.recordFailedAttempt(email);
      throw new UnauthorizedException('Invalid email or password');
    }

    if (teamMember.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account has been suspended');
    }

    const isPasswordValid = await this.verifyPassword(password, teamMember.password_hash);
    if (!isPasswordValid) {
      await this.recordFailedAttempt(email);
      throw new UnauthorizedException('Invalid email or password');
    }

    await this.clearFailedAttempts(email);

    this.authRepository
      .updateLastLogin(teamMember.business_id, teamMember.id)
      .catch((err: Error) => {
        this.logger.warn(`Failed to update last login for ${teamMember.id}: ${err.message}`);
      });

    this.logger.log(`Login: ${email}`);

    return this.issueTokensForNewSession(teamMember, meta);
  }

  // ─────────────────────────────────────────────
  // Login / sign-up via Google OAuth
  // ─────────────────────────────────────────────

  async handleGoogleLogin(profile: GoogleProfile, meta: SessionMeta = {}): Promise<AuthTokensDto> {
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
        this.logger.log(`Linked Google account to existing user ${profile.email}`);
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
      this.logger.log(`New Google registration: ${profile.email}`);
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
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!payload.sessionId) {
      throw new UnauthorizedException('Refresh token is not bound to a session');
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
  async requestPasswordReset(email: string): Promise<void> {
    const teamMember = await this.authRepository.findTeamMemberByEmail(email);
    if (!teamMember || !teamMember.password_hash) {
      this.logger.debug(`Password reset requested for unknown/OAuth email ${email} — no-op`);
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

    const frontendUrl = this.configService.get<string>('app.frontendUrl', 'http://localhost:3001');
    const resetUrl = `${frontendUrl}/reset-password?token=${token}`;
    // TODO: dispatch via the notification/email service once available.
    this.logger.log(`Password reset link generated for ${email}: ${resetUrl}`);
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
    const payload: JwtPayload = {
      sub: teamMember.id,
      businessId: teamMember.business_id,
      email: teamMember.email,
      role: teamMember.role,
      sessionId,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, { expiresIn: ACCESS_TOKEN_TTL }),
      this.jwtService.signAsync(payload, { expiresIn: REFRESH_TOKEN_TTL }),
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

  private async assertNotLockedOut(email: string): Promise<void> {
    const attempts = await this.redis.get(loginAttemptsKey(email));
    if (attempts && parseInt(attempts, 10) >= MAX_LOGIN_ATTEMPTS) {
      const ttl = await this.redis.ttl(loginAttemptsKey(email));
      const minutes = Math.max(1, Math.ceil(ttl / 60));
      throw new UnauthorizedException(
        `Too many failed login attempts. Try again in ${minutes} minute(s).`,
      );
    }
  }

  private async recordFailedAttempt(email: string): Promise<void> {
    const key = loginAttemptsKey(email);
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, LOGIN_LOCKOUT_SECONDS);
    }
  }

  private async clearFailedAttempts(email: string): Promise<void> {
    await this.redis.del(loginAttemptsKey(email));
  }

  // ─────────────────────────────────────────────
  // Crypto / slug helpers
  // ─────────────────────────────────────────────

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
