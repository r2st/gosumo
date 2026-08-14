import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  UnauthorizedException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthRepository, TeamMemberWithBusiness } from './auth.repository';
import { SessionService } from './session.service';
import { REDIS_CLIENT } from './redis.provider';
import { RolesGuard } from './guards/roles.guard';
import { JwtStrategy } from './strategies/jwt.strategy';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';

// ─────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────

const mockTeamMember: TeamMemberWithBusiness = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  business_id: '660e8400-e29b-41d4-a716-446655440000',
  email: 'test@example.com',
  name: 'test',
  avatar_url: null,
  role: 'OWNER' as const,
  status: 'ACTIVE' as const,
  phone: null,
  password_hash: '$2a$12$OErbnr3nw.qAPBVB5wiOduM02PW1ARc6H6e7/1jxhtymPCK4vu3F.',
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
    id: '660e8400-e29b-41d4-a716-446655440000',
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
};

const mockAuthRepository = {
  findTeamMemberByEmail: jest.fn(),
  findTeamMemberById: jest.fn(),
  findTeamMemberByGoogleId: jest.fn(),
  isBusinessEmailTaken: jest.fn(),
  createTeamMemberWithBusiness: jest.fn(),
  createOAuthTeamMemberWithBusiness: jest.fn(),
  linkGoogleAccount: jest.fn(),
  updateLastLogin: jest.fn().mockResolvedValue(undefined),
  updatePassword: jest.fn(),
  updateTeamMember: jest.fn().mockResolvedValue(undefined),
  isSlugTaken: jest.fn().mockResolvedValue(false),
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('mock-jwt-token'),
  signAsync: jest.fn().mockResolvedValue('mock-jwt-token'),
  verify: jest.fn(),
};

const mockConfigService = {
  get: jest.fn((key: string) => {
    const config: Record<string, string> = {
      'app.jwt.secret': 'test-secret-key-for-testing',
      'app.jwt.accessTokenTtl': '15m',
      'app.jwt.refreshTokenTtl': '7d',
    };
    return config[key];
  }),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  ttl: jest.fn(),
};

const mockSessionService = {
  createSession: jest.fn().mockResolvedValue({
    sessionId: 'session-id-123',
    userId: '550e8400-e29b-41d4-a716-446655440000',
    businessId: '660e8400-e29b-41d4-a716-446655440000',
    refreshTokenHash: 'hash',
    ip: null,
    userAgent: null,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  }),
  revokeSession: jest.fn().mockResolvedValue(undefined),
  revokeAllSessions: jest.fn().mockResolvedValue(undefined),
  isActive: jest.fn().mockResolvedValue(true),
  touch: jest.fn().mockResolvedValue(undefined),
  listSessions: jest.fn().mockResolvedValue([]),
  validateRefreshToken: jest.fn().mockResolvedValue(true),
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AuthRepository, useValue: mockAuthRepository },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SessionService, useValue: mockSessionService },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);

    jest.clearAllMocks();
    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.del.mockReset();
    mockRedis.incr.mockReset();
    mockRedis.expire.mockReset();
    mockRedis.ttl.mockReset();
  });

  describe('register', () => {
    it('should register a new user and return tokens', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(null);
      mockAuthRepository.isBusinessEmailTaken.mockResolvedValue(false);
      mockAuthRepository.createTeamMemberWithBusiness.mockResolvedValue(mockTeamMember);

      const result = await service.register({
        email: 'new@example.com',
        password: 'Test1234!',
        businessName: 'New Business',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(mockAuthRepository.createTeamMemberWithBusiness).toHaveBeenCalled();
      expect(mockSessionService.createSession).toHaveBeenCalled();
    });

    it('should throw ConflictException if email exists', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(mockTeamMember);

      await expect(
        service.register({
          email: 'test@example.com',
          password: 'Test1234!',
          businessName: 'Test',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException if business email taken', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(null);
      mockAuthRepository.isBusinessEmailTaken.mockResolvedValue(true);

      await expect(
        service.register({
          email: 'new@example.com',
          password: 'Test1234!',
          businessName: 'New',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('login', () => {
    it('should login with valid credentials', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(mockTeamMember);

      const result = await service.login({
        email: 'test@example.com',
        password: 'Test1234!',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(mockSessionService.createSession).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException for wrong password', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(mockTeamMember);

      await expect(
        service.login({
          email: 'test@example.com',
          password: 'WrongPassword1!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for non-existent user', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.incr.mockResolvedValue(1);
      mockRedis.expire.mockResolvedValue(1);
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(null);

      await expect(
        service.login({
          email: 'nobody@example.com',
          password: 'Test1234!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for suspended account', async () => {
      mockRedis.get.mockResolvedValue(null);
      const suspendedMember = { ...mockTeamMember, status: 'SUSPENDED' as const };
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(suspendedMember);

      await expect(
        service.login({
          email: 'test@example.com',
          password: 'Test1234!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refreshTokens', () => {
    it('should throw UnauthorizedException for invalid token', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });

      await expect(service.refreshTokens('bad-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('logout', () => {
    it('should revoke session on logout', async () => {
      await service.logout(mockTeamMember.id, 'session-id-123');

      expect(mockSessionService.revokeSession).toHaveBeenCalledWith(
        mockTeamMember.id,
        'session-id-123',
      );
    });

    it('should revoke all sessions via logoutAll', async () => {
      await service.logoutAll(mockTeamMember.id);

      expect(mockSessionService.revokeAllSessions).toHaveBeenCalledWith(
        mockTeamMember.id,
      );
    });
  });

  describe('getProfile', () => {
    it('should return user profile with business info', async () => {
      mockAuthRepository.findTeamMemberById.mockResolvedValue(mockTeamMember);

      const profile = await service.getProfile(
        mockTeamMember.business_id,
        mockTeamMember.id,
      );

      expect(profile).toEqual({
        id: mockTeamMember.id,
        email: 'test@example.com',
        name: 'test',
        role: 'OWNER',
        status: 'ACTIVE',
        authProvider: 'LOCAL',
        avatarUrl: null,
        businessId: '660e8400-e29b-41d4-a716-446655440000',
        businessName: 'Test Business',
        businessSlug: 'test-business',
        lastLoginAt: null,
        loginCount: 0,
      });
    });

    it('should throw NotFoundException for non-existent user', async () => {
      mockAuthRepository.findTeamMemberById.mockResolvedValue(null);

      await expect(
        service.getProfile(mockTeamMember.business_id, 'non-existent-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('changePassword', () => {
    it('should change password with valid current password', async () => {
      mockAuthRepository.findTeamMemberById.mockResolvedValue(mockTeamMember);
      mockAuthRepository.updatePassword.mockResolvedValue(undefined);

      await service.changePassword(mockTeamMember.business_id, mockTeamMember.id, {
        currentPassword: 'Test1234!',
        newPassword: 'NewPass567!',
      });

      expect(mockAuthRepository.updateTeamMember).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException for wrong current password', async () => {
      mockAuthRepository.findTeamMemberById.mockResolvedValue(mockTeamMember);

      await expect(
        service.changePassword(mockTeamMember.business_id, mockTeamMember.id, {
          currentPassword: 'WrongOld1!',
          newPassword: 'NewPass567!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw NotFoundException for non-existent user', async () => {
      mockAuthRepository.findTeamMemberById.mockResolvedValue(null);

      await expect(
        service.changePassword(mockTeamMember.business_id, 'non-existent', {
          currentPassword: 'Test1234!',
          newPassword: 'NewPass567!',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  const createMockContext = (role: string): ExecutionContext =>
    ({
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    }) as unknown as ExecutionContext;

  it('should allow access when no roles required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(createMockContext('VIEWER'))).toBe(true);
  });

  it('should allow OWNER to access MANAGER-required routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['MANAGER']);
    expect(guard.canActivate(createMockContext('OWNER'))).toBe(true);
  });

  it('should deny VIEWER access to MANAGER-required routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['MANAGER']);
    expect(() => guard.canActivate(createMockContext('VIEWER'))).toThrow();
  });

  it('should deny STAFF access to OWNER-required routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['OWNER']);
    expect(() => guard.canActivate(createMockContext('STAFF'))).toThrow();
  });

  it('should allow MANAGER access to STAFF-required routes', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['STAFF']);
    expect(guard.canActivate(createMockContext('MANAGER'))).toBe(true);
  });
});

describe('JwtStrategy', () => {
  it('should throw if JWT_SECRET is missing', () => {
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    const sessionSvc = {} as unknown as SessionService;
    expect(() => new JwtStrategy(configService, sessionSvc)).toThrow(
      'JWT_SECRET is not configured',
    );
  });

  it('should validate and return AuthenticatedUser from payload', async () => {
    const configService = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as unknown as ConfigService;

    const sessionSvc = {
      isActive: jest.fn().mockResolvedValue(true),
      touch: jest.fn().mockResolvedValue(undefined),
    } as unknown as SessionService;

    const strategy = new JwtStrategy(configService, sessionSvc);
    const payload = {
      sub: 'user-id',
      businessId: 'biz-id',
      email: 'test@example.com',
      role: 'OWNER',
    };

    const result = await strategy.validate(payload);

    expect(result).toEqual({
      sub: 'user-id',
      businessId: 'biz-id',
      email: 'test@example.com',
      role: 'OWNER',
      sessionId: undefined,
    });
  });

  it('should throw UnauthorizedException for payload missing sub', async () => {
    const configService = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as unknown as ConfigService;

    const sessionSvc = {
      isActive: jest.fn().mockResolvedValue(true),
      touch: jest.fn().mockResolvedValue(undefined),
    } as unknown as SessionService;

    const strategy = new JwtStrategy(configService, sessionSvc);

    await expect(
      strategy.validate({
        sub: '',
        businessId: 'biz-id',
        email: 'test@example.com',
        role: 'OWNER',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
describe('AuthService — Google OAuth', () => {
  let service: AuthService;
  let jwtSignCalls: Array<Record<string, unknown>>;

  beforeEach(async () => {
    jwtSignCalls = [];
    const capturingJwtService = {
      ...mockJwtService,
      signAsync: jest.fn().mockImplementation((payload: Record<string, unknown>) => {
        jwtSignCalls.push(payload);
        return Promise.resolve('mock-jwt-token');
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AuthRepository, useValue: mockAuthRepository },
        { provide: JwtService, useValue: capturingJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SessionService, useValue: mockSessionService },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);

    jest.clearAllMocks();
    jwtSignCalls = [];
    mockRedis.get.mockReset();
  });

  const googleProfile = {
    googleId: 'google-123',
    email: 'google@example.com',
    name: 'Google User',
    avatarUrl: 'https://example.com/avatar.jpg',
  };

  const googleTeamMember: TeamMemberWithBusiness = {
    ...mockTeamMember,
    id: '770e8400-e29b-41d4-a716-446655440000',
    email: 'google@example.com',
    name: 'Google User',
    auth_provider: 'GOOGLE' as const,
    google_id: 'google-123',
    avatar_url: 'https://example.com/avatar.jpg',
  };

  it('should return tokens for existing Google-linked user', async () => {
    mockAuthRepository.findTeamMemberByGoogleId.mockResolvedValue(googleTeamMember);

    const result = await service.handleGoogleLogin(googleProfile);

    expect(result).toHaveProperty('accessToken');
    expect(result).toHaveProperty('refreshToken');
    expect(mockSessionService.createSession).toHaveBeenCalled();
  });

  it('should link Google account to existing email user', async () => {
    mockAuthRepository.findTeamMemberByGoogleId.mockResolvedValue(null);
    mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(mockTeamMember);
    mockAuthRepository.linkGoogleAccount.mockResolvedValue(googleTeamMember);

    const result = await service.handleGoogleLogin(googleProfile);

    expect(result).toHaveProperty('accessToken');
    expect(mockAuthRepository.linkGoogleAccount).toHaveBeenCalledWith(
      mockTeamMember.business_id,
      mockTeamMember.id,
      'google-123',
      'https://example.com/avatar.jpg',
    );
  });

  it('should create new user for brand-new Google sign-up', async () => {
    mockAuthRepository.findTeamMemberByGoogleId.mockResolvedValue(null);
    mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(null);
    mockAuthRepository.createOAuthTeamMemberWithBusiness.mockResolvedValue(googleTeamMember);

    const result = await service.handleGoogleLogin(googleProfile);

    expect(result).toHaveProperty('accessToken');
    expect(mockAuthRepository.createOAuthTeamMemberWithBusiness).toHaveBeenCalled();
  });

  it('should throw UnauthorizedException for suspended Google user', async () => {
    const suspendedGoogle = { ...googleTeamMember, status: 'SUSPENDED' as const };
    mockAuthRepository.findTeamMemberByGoogleId.mockResolvedValue(suspendedGoogle);

    await expect(service.handleGoogleLogin(googleProfile)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should generate JWT with same payload structure as normal login', async () => {
    // Google OAuth login
    mockAuthRepository.findTeamMemberByGoogleId.mockResolvedValue(googleTeamMember);
    await service.handleGoogleLogin(googleProfile);

    const googlePayload = jwtSignCalls[0];

    // Verify the JWT payload has all required fields for JwtAuthGuard
    expect(googlePayload).toHaveProperty('sub', googleTeamMember.id);
    expect(googlePayload).toHaveProperty('businessId', googleTeamMember.business_id);
    expect(googlePayload).toHaveProperty('email', googleTeamMember.email);
    expect(googlePayload).toHaveProperty('role', googleTeamMember.role);
    expect(googlePayload).toHaveProperty('sessionId');
    expect(typeof googlePayload!['sessionId']).toBe('string');
    expect((googlePayload!['sessionId'] as string).length).toBeGreaterThan(0);
  });

  it('should call signAsync with identical keys for Google and local login', async () => {
    // Google OAuth login
    mockAuthRepository.findTeamMemberByGoogleId.mockResolvedValue(googleTeamMember);
    await service.handleGoogleLogin(googleProfile);
    const googleKeys = Object.keys(jwtSignCalls[0]!).sort();

    jwtSignCalls = [];

    // Local login
    mockRedis.get.mockResolvedValue(null);
    mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(mockTeamMember);
    await service.login({ email: 'test@example.com', password: 'Test1234!' });
    const localKeys = Object.keys(jwtSignCalls[0]!).sort();

    expect(googleKeys).toEqual(localKeys);
  });
});

describe('JwtAuthGuard — global registration', () => {
  it('should be registered as APP_GUARD in AuthModule', async () => {
    // Import the module metadata to verify APP_GUARD is registered
    const { AuthModule } = await import('./auth.module');
    const moduleMetadata = Reflect.getMetadata('providers', AuthModule) as Array<
      { provide: unknown; useClass: unknown } | NewableFunction
    >;

    // APP_GUARD is a Symbol/InjectionToken — assert a provider is registered
    // against it, and that its useClass is JwtAuthGuard.
    const appGuardProvider = moduleMetadata?.find(
      (p) => typeof p === 'object' && p !== null && 'provide' in p
        && (p as { provide: unknown }).provide?.toString?.().includes('APP_GUARD'),
    );
    expect(appGuardProvider).toBeDefined();

    const guardProviders = moduleMetadata?.filter(
      (p) => typeof p === 'object' && p !== null && 'useClass' in p,
    ) as Array<{ provide: unknown; useClass: NewableFunction }>;

    const hasJwtAuthGuard = guardProviders?.some(
      (p) => p.useClass?.name === 'JwtAuthGuard',
    );

    expect(hasJwtAuthGuard).toBe(true);
  });
});
