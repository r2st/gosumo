import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { AuthService } from './auth.service';
import { AuthRepository, TeamMemberWithBusiness } from './auth.repository';
import { SessionService } from './session.service';
import { REDIS_CLIENT } from './redis.provider';
import { JwtPayload } from './strategies/jwt.strategy';

/**
 * Flow-level coverage for AuthService: refresh-token rotation and reuse
 * detection, the password-reset lifecycle, login throttling, and the session
 * management surface. These are the paths the original auth.spec.ts leaves out.
 */

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const BUSINESS_ID = '660e8400-e29b-41d4-a716-446655440000';
const SESSION_ID = '770e8400-e29b-41d4-a716-446655440000';
const PLAINTEXT_PASSWORD = 'Test1234!';

/** Cost 4 keeps the suite fast; bcrypt.compare is cost-agnostic. */
const PASSWORD_HASH = bcrypt.hashSync(PLAINTEXT_PASSWORD, 4);

function buildTeamMember(
  overrides: Partial<TeamMemberWithBusiness> = {},
): TeamMemberWithBusiness {
  return {
    id: USER_ID,
    business_id: BUSINESS_ID,
    email: 'test@example.com',
    name: 'test',
    avatar_url: null,
    role: 'OWNER' as const,
    status: 'ACTIVE' as const,
    phone: null,
    password_hash: PASSWORD_HASH,
    totp_secret: null,
    last_login_at: null,
    login_count: 0,
    notification_prefs: {},
    invite_token: null,
    invited_by: null,
    invited_at: null,
    auth_provider: 'LOCAL' as const,
    google_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    business: {
      id: BUSINESS_ID,
      name: 'Test Business',
      slug: 'test-business',
      email: 'test@example.com',
      phone: null,
      country: 'IN',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      logo_url: null,
      website_url: null,
      plan: 'starter',
      plan_limits: {},
      ai_settings: {},
      profile: {},
      onboarding_progress: {},
      is_active: true,
      intelligence_opt_in: false,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    },
    ...overrides,
  } as TeamMemberWithBusiness;
}

describe('AuthService — refresh, reset, throttling, sessions', () => {
  let service: AuthService;
  let repo: {
    findTeamMemberByEmail: jest.Mock;
    findTeamMemberById: jest.Mock;
    findTeamMemberByGoogleId: jest.Mock;
    isBusinessEmailTaken: jest.Mock;
    createTeamMemberWithBusiness: jest.Mock;
    createOAuthTeamMemberWithBusiness: jest.Mock;
    linkGoogleAccount: jest.Mock;
    updateLastLogin: jest.Mock;
    updateTeamMember: jest.Mock;
    isSlugTaken: jest.Mock;
  };
  let sessions: {
    createSession: jest.Mock;
    verifyRefreshToken: jest.Mock;
    rotateRefreshToken: jest.Mock;
    revokeSession: jest.Mock;
    revokeAllSessions: jest.Mock;
    listSessions: jest.Mock;
  };
  let redis: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
    incr: jest.Mock;
    expire: jest.Mock;
    ttl: jest.Mock;
  };
  let jwt: { signAsync: jest.Mock; verify: jest.Mock };

  beforeEach(async () => {
    repo = {
      findTeamMemberByEmail: jest.fn(),
      findTeamMemberById: jest.fn(),
      findTeamMemberByGoogleId: jest.fn(),
      isBusinessEmailTaken: jest.fn().mockResolvedValue(false),
      createTeamMemberWithBusiness: jest.fn(),
      createOAuthTeamMemberWithBusiness: jest.fn(),
      linkGoogleAccount: jest.fn(),
      updateLastLogin: jest.fn().mockResolvedValue(undefined),
      updateTeamMember: jest.fn().mockResolvedValue(undefined),
      isSlugTaken: jest.fn().mockResolvedValue(false),
    };
    sessions = {
      createSession: jest.fn().mockResolvedValue(undefined),
      verifyRefreshToken: jest.fn().mockResolvedValue(true),
      rotateRefreshToken: jest.fn().mockResolvedValue(undefined),
      revokeSession: jest.fn().mockResolvedValue(undefined),
      revokeAllSessions: jest.fn().mockResolvedValue(undefined),
      listSessions: jest.fn().mockResolvedValue([]),
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      ttl: jest.fn().mockResolvedValue(900),
    };
    jwt = {
      signAsync: jest.fn().mockResolvedValue('signed-token'),
      verify: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AuthRepository, useValue: repo },
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_k: string, fallback?: string) => fallback) },
        },
        { provide: SessionService, useValue: sessions },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  // ═══════════════════════════════════════════
  // refreshTokens
  // ═══════════════════════════════════════════

  describe('refreshTokens', () => {
    const payload: JwtPayload = {
      sub: USER_ID,
      businessId: BUSINESS_ID,
      email: 'test@example.com',
      role: 'OWNER',
      sessionId: SESSION_ID,
    };

    it('rotates the refresh token and returns a fresh pair on the happy path', async () => {
      jwt.verify.mockReturnValue(payload);
      repo.findTeamMemberById.mockResolvedValue(buildTeamMember());

      const result = await service.refreshTokens('valid-refresh');

      expect(sessions.verifyRefreshToken).toHaveBeenCalledWith(
        USER_ID,
        SESSION_ID,
        'valid-refresh',
      );
      // Rotation reuses the SAME sessionId — a refresh must not fork a session.
      expect(sessions.rotateRefreshToken).toHaveBeenCalledWith(
        USER_ID,
        SESSION_ID,
        'signed-token',
      );
      expect(sessions.createSession).not.toHaveBeenCalled();
      expect(result.accessToken).toBe('signed-token');
      expect(result.expiresIn).toBe(15 * 60);
    });

    it('signs the rotated tokens with the original session binding', async () => {
      jwt.verify.mockReturnValue(payload);
      repo.findTeamMemberById.mockResolvedValue(buildTeamMember());

      await service.refreshTokens('valid-refresh');

      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: USER_ID,
          businessId: BUSINESS_ID,
          sessionId: SESSION_ID,
        }),
        expect.objectContaining({ expiresIn: expect.any(String) }),
      );
    });

    it('rejects a token whose signature does not verify', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('jwt malformed');
      });

      await expect(service.refreshTokens('garbage')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(sessions.verifyRefreshToken).not.toHaveBeenCalled();
    });

    it('rejects a token that carries no session binding', async () => {
      jwt.verify.mockReturnValue({ ...payload, sessionId: undefined });

      await expect(service.refreshTokens('sessionless')).rejects.toThrow(
        /not bound to a session/,
      );
    });

    it('revokes the session defensively when the token does not match (reuse detection)', async () => {
      jwt.verify.mockReturnValue(payload);
      sessions.verifyRefreshToken.mockResolvedValue(false);

      await expect(service.refreshTokens('rotated-away')).rejects.toThrow(
        /has been revoked/,
      );
      // The critical security behaviour: a stale token kills the whole session.
      expect(sessions.revokeSession).toHaveBeenCalledWith(USER_ID, SESSION_ID);
      expect(repo.findTeamMemberById).not.toHaveBeenCalled();
    });

    it('rejects when the underlying account no longer exists', async () => {
      jwt.verify.mockReturnValue(payload);
      repo.findTeamMemberById.mockResolvedValue(null);

      await expect(service.refreshTokens('valid-refresh')).rejects.toThrow(
        /User account not found/,
      );
      expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
    });

    it('rejects a refresh for a suspended account', async () => {
      jwt.verify.mockReturnValue(payload);
      repo.findTeamMemberById.mockResolvedValue(
        buildTeamMember({ status: 'SUSPENDED' as TeamMemberWithBusiness['status'] }),
      );

      await expect(service.refreshTokens('valid-refresh')).rejects.toThrow(
        /suspended/,
      );
      expect(sessions.rotateRefreshToken).not.toHaveBeenCalled();
    });

    it('scopes the account lookup to the tenant in the token', async () => {
      jwt.verify.mockReturnValue(payload);
      repo.findTeamMemberById.mockResolvedValue(buildTeamMember());

      await service.refreshTokens('valid-refresh');

      expect(repo.findTeamMemberById).toHaveBeenCalledWith(BUSINESS_ID, USER_ID);
    });
  });

  // ═══════════════════════════════════════════
  // Login throttling
  // ═══════════════════════════════════════════

  describe('login throttling', () => {
    it('locks out once the attempt counter reaches the maximum', async () => {
      redis.get.mockResolvedValue('5');
      redis.ttl.mockResolvedValue(600);

      await expect(
        service.login({ email: 'test@example.com', password: PLAINTEXT_PASSWORD }),
      ).rejects.toThrow(/Too many failed login attempts. Try again in 10 minute/);

      // Lockout short-circuits before any credential check.
      expect(repo.findTeamMemberByEmail).not.toHaveBeenCalled();
    });

    it('reports a minimum of one minute when the lockout is nearly expired', async () => {
      redis.get.mockResolvedValue('9');
      redis.ttl.mockResolvedValue(1);

      await expect(
        service.login({ email: 'test@example.com', password: PLAINTEXT_PASSWORD }),
      ).rejects.toThrow(/1 minute\(s\)/);
    });

    it('allows the attempt when the counter is below the threshold', async () => {
      redis.get.mockResolvedValue('4');
      repo.findTeamMemberByEmail.mockResolvedValue(buildTeamMember());

      await expect(
        service.login({ email: 'test@example.com', password: PLAINTEXT_PASSWORD }),
      ).resolves.toHaveProperty('accessToken');
      expect(redis.del).toHaveBeenCalledWith('gosumo:test@example.com:login_attempts');
    });

    it('sets the lockout TTL only on the first failed attempt', async () => {
      redis.get.mockResolvedValue(null);
      repo.findTeamMemberByEmail.mockResolvedValue(null);
      redis.incr.mockResolvedValue(1);

      await expect(
        service.login({ email: 'ghost@example.com', password: 'whatever' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(redis.expire).toHaveBeenCalledWith(
        'gosumo:ghost@example.com:login_attempts',
        15 * 60,
      );
    });

    it('does not reset the TTL on subsequent failed attempts', async () => {
      redis.get.mockResolvedValue('2');
      repo.findTeamMemberByEmail.mockResolvedValue(buildTeamMember());
      redis.incr.mockResolvedValue(3);

      await expect(
        service.login({ email: 'test@example.com', password: 'WrongPassword!' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(redis.incr).toHaveBeenCalled();
      expect(redis.expire).not.toHaveBeenCalled();
    });

    it('counts a failed attempt for an OAuth-only account without leaking that it exists', async () => {
      redis.get.mockResolvedValue(null);
      repo.findTeamMemberByEmail.mockResolvedValue(
        buildTeamMember({ password_hash: null }),
      );

      await expect(
        service.login({ email: 'oauth@example.com', password: PLAINTEXT_PASSWORD }),
      ).rejects.toThrow('Invalid email or password');
      expect(redis.incr).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // Best-effort last-login bookkeeping
  // ═══════════════════════════════════════════

  describe('last-login bookkeeping', () => {
    it('still issues tokens when the last-login write fails during local login', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      redis.get.mockResolvedValue(null);
      repo.findTeamMemberByEmail.mockResolvedValue(buildTeamMember());
      repo.updateLastLogin.mockRejectedValue(new Error('db down'));

      const result = await service.login({
        email: 'test@example.com',
        password: PLAINTEXT_PASSWORD,
      });

      expect(result.accessToken).toBe('signed-token');
      await new Promise((r) => setImmediate(r));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
      warn.mockRestore();
    });

    it('still issues tokens when the last-login write fails during Google login', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      repo.findTeamMemberByGoogleId.mockResolvedValue(buildTeamMember());
      repo.updateLastLogin.mockRejectedValue(new Error('replica lag'));

      const result = await service.handleGoogleLogin({
        googleId: 'g-1',
        email: 'test@example.com',
        name: 'Test',
        avatarUrl: null,
      });

      expect(result.accessToken).toBe('signed-token');
      await new Promise((r) => setImmediate(r));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('replica lag'));
      warn.mockRestore();
    });
  });

  // ═══════════════════════════════════════════
  // Session management surface
  // ═══════════════════════════════════════════

  describe('session management', () => {
    it('revokes only the named session when logout targets one', async () => {
      await service.logout(USER_ID, SESSION_ID);

      expect(sessions.revokeSession).toHaveBeenCalledWith(USER_ID, SESSION_ID);
      expect(sessions.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('revokes every session when logout omits the session id', async () => {
      await service.logout(USER_ID);

      expect(sessions.revokeAllSessions).toHaveBeenCalledWith(USER_ID);
      expect(sessions.revokeSession).not.toHaveBeenCalled();
    });

    it('lists active sessions and flags the current one', async () => {
      sessions.listSessions.mockResolvedValue([
        { sessionId: SESSION_ID, current: true },
      ]);

      const result = await service.getActiveSessions(USER_ID, SESSION_ID);

      expect(sessions.listSessions).toHaveBeenCalledWith(USER_ID, SESSION_ID);
      expect(result).toHaveLength(1);
    });

    it('revokes a single session by id', async () => {
      await service.revokeSession(USER_ID, SESSION_ID);

      expect(sessions.revokeSession).toHaveBeenCalledWith(USER_ID, SESSION_ID);
    });
  });

  // ═══════════════════════════════════════════
  // changePassword — OAuth-only guard
  // ═══════════════════════════════════════════

  describe('changePassword', () => {
    it('refuses for an account with no password set (OAuth-only)', async () => {
      repo.findTeamMemberById.mockResolvedValue(
        buildTeamMember({ password_hash: null }),
      );

      await expect(
        service.changePassword(BUSINESS_ID, USER_ID, {
          currentPassword: 'x',
          newPassword: 'NewPass123!',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.updateTeamMember).not.toHaveBeenCalled();
    });

    it('revokes every session after a successful change', async () => {
      repo.findTeamMemberById.mockResolvedValue(buildTeamMember());

      await service.changePassword(BUSINESS_ID, USER_ID, {
        currentPassword: PLAINTEXT_PASSWORD,
        newPassword: 'BrandNew123!',
      });

      expect(repo.updateTeamMember).toHaveBeenCalledWith(
        BUSINESS_ID,
        USER_ID,
        expect.objectContaining({ password_hash: expect.any(String) }),
      );
      expect(sessions.revokeAllSessions).toHaveBeenCalledWith(USER_ID);
    });

    it('stores a bcrypt hash, never the plaintext', async () => {
      repo.findTeamMemberById.mockResolvedValue(buildTeamMember());

      await service.changePassword(BUSINESS_ID, USER_ID, {
        currentPassword: PLAINTEXT_PASSWORD,
        newPassword: 'BrandNew123!',
      });

      const stored = repo.updateTeamMember.mock.calls[0][2].password_hash as string;
      expect(stored).not.toContain('BrandNew123!');
      expect(bcrypt.compareSync('BrandNew123!', stored)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // Password reset lifecycle
  // ═══════════════════════════════════════════

  describe('requestPasswordReset', () => {
    it('stores a hashed token keyed to businessId:userId', async () => {
      repo.findTeamMemberByEmail.mockResolvedValue(buildTeamMember());

      await service.requestPasswordReset('test@example.com');

      expect(redis.set).toHaveBeenCalledTimes(1);
      const [key, value, mode, ttl] = redis.set.mock.calls[0];
      expect(key).toMatch(/^gosumo:pwreset:[0-9a-f]{64}$/);
      expect(value).toBe(`${BUSINESS_ID}:${USER_ID}`);
      expect(mode).toBe('EX');
      expect(ttl).toBe(60 * 60);
    });

    it('stores only the SHA-256 hash — the raw token never reaches Redis', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      repo.findTeamMemberByEmail.mockResolvedValue(buildTeamMember());

      await service.requestPasswordReset('test@example.com');

      const storedKey = redis.set.mock.calls[0][0] as string;
      const loggedUrl = (log.mock.calls.find((c) =>
        String(c[0]).includes('reset-password?token='),
      )?.[0] ?? '') as string;
      const rawToken = loggedUrl.split('token=')[1] ?? '';

      expect(rawToken).toBeTruthy();
      expect(storedKey).not.toContain(rawToken);
      expect(storedKey).toBe(
        `gosumo:pwreset:${crypto.createHash('sha256').update(rawToken).digest('hex')}`,
      );
      log.mockRestore();
    });

    it('is a silent no-op for an unknown email (no account enumeration)', async () => {
      repo.findTeamMemberByEmail.mockResolvedValue(null);

      await expect(
        service.requestPasswordReset('nobody@example.com'),
      ).resolves.toBeUndefined();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('is a silent no-op for an OAuth-only account', async () => {
      repo.findTeamMemberByEmail.mockResolvedValue(
        buildTeamMember({ password_hash: null }),
      );

      await expect(
        service.requestPasswordReset('oauth@example.com'),
      ).resolves.toBeUndefined();
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    const dto = { token: 'raw-reset-token', newPassword: 'BrandNew123!' };

    it('redeems a valid token, rehashes, and revokes all sessions', async () => {
      redis.get.mockResolvedValue(`${BUSINESS_ID}:${USER_ID}`);
      repo.findTeamMemberById.mockResolvedValue(buildTeamMember());

      await service.resetPassword(dto);

      expect(repo.findTeamMemberById).toHaveBeenCalledWith(BUSINESS_ID, USER_ID);
      expect(repo.updateTeamMember).toHaveBeenCalledWith(
        BUSINESS_ID,
        USER_ID,
        expect.objectContaining({ password_hash: expect.any(String) }),
      );
      // Single-use: the token is deleted, and old credentials are dead everywhere.
      expect(redis.del).toHaveBeenCalled();
      expect(sessions.revokeAllSessions).toHaveBeenCalledWith(USER_ID);
    });

    it('looks the token up by its SHA-256 hash, not the raw value', async () => {
      redis.get.mockResolvedValue(`${BUSINESS_ID}:${USER_ID}`);
      repo.findTeamMemberById.mockResolvedValue(buildTeamMember());

      await service.resetPassword(dto);

      expect(redis.get).toHaveBeenCalledWith(
        `gosumo:pwreset:${crypto.createHash('sha256').update(dto.token).digest('hex')}`,
      );
    });

    it('rejects an unknown or expired token', async () => {
      redis.get.mockResolvedValue(null);

      await expect(service.resetPassword(dto)).rejects.toThrow(BadRequestException);
      expect(repo.updateTeamMember).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('refuses a legacy value with no tenant prefix and burns the token', async () => {
      redis.get.mockResolvedValue(USER_ID); // pre-tenant format, no ':'

      await expect(service.resetPassword(dto)).rejects.toThrow(
        'Invalid or expired reset token',
      );
      expect(redis.del).toHaveBeenCalled();
      expect(repo.findTeamMemberById).not.toHaveBeenCalled();
    });

    it('refuses a value whose separator is leading and burns the token', async () => {
      redis.get.mockResolvedValue(`:${USER_ID}`);

      await expect(service.resetPassword(dto)).rejects.toThrow(
        'Invalid or expired reset token',
      );
      expect(redis.del).toHaveBeenCalled();
      expect(repo.updateTeamMember).not.toHaveBeenCalled();
    });

    it('refuses a value with a tenant but an empty user id', async () => {
      redis.get.mockResolvedValue(`${BUSINESS_ID}:`);

      await expect(service.resetPassword(dto)).rejects.toThrow(
        'Invalid or expired reset token',
      );
      expect(redis.del).toHaveBeenCalled();
      expect(repo.findTeamMemberById).not.toHaveBeenCalled();
    });

    it('burns the token when the referenced account is gone', async () => {
      redis.get.mockResolvedValue(`${BUSINESS_ID}:${USER_ID}`);
      repo.findTeamMemberById.mockResolvedValue(null);

      await expect(service.resetPassword(dto)).rejects.toThrow(
        'Invalid or expired reset token',
      );
      expect(redis.del).toHaveBeenCalled();
      expect(repo.updateTeamMember).not.toHaveBeenCalled();
      expect(sessions.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('stores a verifiable bcrypt hash of the new password', async () => {
      redis.get.mockResolvedValue(`${BUSINESS_ID}:${USER_ID}`);
      repo.findTeamMemberById.mockResolvedValue(buildTeamMember());

      await service.resetPassword(dto);

      const stored = repo.updateTeamMember.mock.calls[0][2].password_hash as string;
      expect(bcrypt.compareSync(dto.newPassword, stored)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════
  // Slug generation
  // ═══════════════════════════════════════════

  describe('business slug generation', () => {
    it('slugifies the business name when the slug is free', async () => {
      repo.findTeamMemberByEmail.mockResolvedValue(null);
      repo.createTeamMemberWithBusiness.mockResolvedValue(buildTeamMember());
      repo.isSlugTaken.mockResolvedValue(false);

      await service.register({
        email: 'new@example.com',
        password: PLAINTEXT_PASSWORD,
        businessName: '  Sharma & Sons Realty!! ',
      });

      expect(repo.createTeamMemberWithBusiness).toHaveBeenCalledWith(
        'new@example.com',
        'new',
        expect.any(String),
        '  Sharma & Sons Realty!! ',
        'sharma-sons-realty',
      );
    });

    it('appends a random suffix when the slug is taken', async () => {
      repo.findTeamMemberByEmail.mockResolvedValue(null);
      repo.createTeamMemberWithBusiness.mockResolvedValue(buildTeamMember());
      repo.isSlugTaken.mockResolvedValue(true);

      await service.register({
        email: 'new@example.com',
        password: PLAINTEXT_PASSWORD,
        businessName: 'Acme Realty',
      });

      const slug = repo.createTeamMemberWithBusiness.mock.calls[0][4] as string;
      expect(slug).toMatch(/^acme-realty-[0-9a-f]{6}$/);
    });

    it('falls back to "business" when the name has no slug-able characters', async () => {
      repo.findTeamMemberByEmail.mockResolvedValue(null);
      repo.createTeamMemberWithBusiness.mockResolvedValue(buildTeamMember());
      repo.isSlugTaken.mockResolvedValue(false);

      await service.register({
        email: 'new@example.com',
        password: PLAINTEXT_PASSWORD,
        businessName: '!!! ###',
      });

      expect(repo.createTeamMemberWithBusiness.mock.calls[0][4]).toBe('business');
    });

    it('prefers an explicit name over the email local-part', async () => {
      repo.findTeamMemberByEmail.mockResolvedValue(null);
      repo.createTeamMemberWithBusiness.mockResolvedValue(buildTeamMember());

      await service.register({
        email: 'new@example.com',
        password: PLAINTEXT_PASSWORD,
        businessName: 'Acme',
        name: '  Priya  ',
      });

      expect(repo.createTeamMemberWithBusiness.mock.calls[0][1]).toBe('Priya');
    });

    it('falls back to the email local-part when the name is blank', async () => {
      repo.findTeamMemberByEmail.mockResolvedValue(null);
      repo.createTeamMemberWithBusiness.mockResolvedValue(buildTeamMember());

      await service.register({
        email: 'someone@example.com',
        password: PLAINTEXT_PASSWORD,
        businessName: 'Acme',
        name: '   ',
      });

      expect(repo.createTeamMemberWithBusiness.mock.calls[0][1]).toBe('someone');
    });
  });

  // ═══════════════════════════════════════════
  // Google OAuth provisioning fallbacks
  // ═══════════════════════════════════════════

  describe('handleGoogleLogin — business naming fallbacks', () => {
    it('names the business after the email local-part when the profile has no name', async () => {
      repo.findTeamMemberByGoogleId.mockResolvedValue(null);
      repo.findTeamMemberByEmail.mockResolvedValue(null);
      repo.createOAuthTeamMemberWithBusiness.mockResolvedValue(buildTeamMember());

      await service.handleGoogleLogin({
        googleId: 'g-2',
        email: 'priya@example.com',
        name: '',
        avatarUrl: null,
      });

      expect(repo.createOAuthTeamMemberWithBusiness).toHaveBeenCalledWith(
        'priya@example.com',
        '',
        'priya',
        'priya',
        'g-2',
        null,
      );
    });

    it('links Google to an existing local account with the same email', async () => {
      repo.findTeamMemberByGoogleId.mockResolvedValue(null);
      repo.findTeamMemberByEmail.mockResolvedValue(buildTeamMember());
      repo.linkGoogleAccount.mockResolvedValue(
        buildTeamMember({ google_id: 'g-3' }),
      );

      await service.handleGoogleLogin({
        googleId: 'g-3',
        email: 'test@example.com',
        name: 'Test',
        avatarUrl: 'https://cdn/a.png',
      });

      expect(repo.linkGoogleAccount).toHaveBeenCalledWith(
        BUSINESS_ID,
        USER_ID,
        'g-3',
        'https://cdn/a.png',
      );
      expect(repo.createOAuthTeamMemberWithBusiness).not.toHaveBeenCalled();
    });

    it('rejects a suspended account provisioned via Google', async () => {
      repo.findTeamMemberByGoogleId.mockResolvedValue(
        buildTeamMember({ status: 'SUSPENDED' as TeamMemberWithBusiness['status'] }),
      );

      await expect(
        service.handleGoogleLogin({
          googleId: 'g-4',
          email: 'test@example.com',
          name: 'Test',
          avatarUrl: null,
        }),
      ).rejects.toThrow(/suspended/);
      expect(sessions.createSession).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════
  // getProfile
  // ═══════════════════════════════════════════

  describe('getProfile', () => {
    it('projects the team member and its business onto the profile shape', async () => {
      repo.findTeamMemberById.mockResolvedValue(
        buildTeamMember({ login_count: 7, last_login_at: new Date('2026-01-01') }),
      );

      const profile = await service.getProfile(BUSINESS_ID, USER_ID);

      expect(profile).toMatchObject({
        id: USER_ID,
        email: 'test@example.com',
        businessId: BUSINESS_ID,
        businessName: 'Test Business',
        businessSlug: 'test-business',
        loginCount: 7,
      });
      // The password hash must never surface on a profile response.
      expect(profile).not.toHaveProperty('password_hash');
    });

    it('throws NotFound when the user is absent from the tenant', async () => {
      repo.findTeamMemberById.mockResolvedValue(null);

      await expect(service.getProfile(BUSINESS_ID, USER_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
