import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthRepository, TeamMemberWithBusiness } from './auth.repository';
import { RolesGuard } from './guards/roles.guard';
import { JwtStrategy } from './strategies/jwt.strategy';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { ROLES_KEY } from './decorators/roles.decorator';

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
  password_hash: 'scrypt:abcdef1234567890:' + 'a'.repeat(128),
  totp_secret: null,
  last_login_at: null,
  login_count: 0,
  notification_prefs: {},
  invite_token: null,
  invited_by: null,
  invited_at: null,
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
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  },
};

const mockAuthRepository = {
  findTeamMemberByEmail: jest.fn(),
  findTeamMemberById: jest.fn(),
  createTeamMemberWithBusiness: jest.fn(),
  updateTeamMember: jest.fn(),
  updateLastLogin: jest.fn(),
  isSlugTaken: jest.fn(),
  isBusinessEmailTaken: jest.fn(),
};

const mockJwtService = {
  signAsync: jest.fn().mockResolvedValue('mock.jwt.token'),
  verify: jest.fn(),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: string | number) => {
    const config: Record<string, string | number> = {
      'app.jwt.secret': 'test-secret-key-for-jwt',
      'app.redis.host': 'localhost',
      'app.redis.port': 6379,
    };
    return config[key] ?? defaultValue;
  }),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

// Mock ioredis before importing AuthService
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AuthRepository, useValue: mockAuthRepository },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);

    // Reset all mocks
    jest.clearAllMocks();
    mockRedis.get.mockReset();
    mockRedis.set.mockReset();
    mockRedis.del.mockReset();
  });

  // ─────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────

  describe('register', () => {
    it('should register a new user and return tokens', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(null);
      mockAuthRepository.isBusinessEmailTaken.mockResolvedValue(false);
      mockAuthRepository.isSlugTaken.mockResolvedValue(false);
      mockAuthRepository.createTeamMemberWithBusiness.mockResolvedValue(mockTeamMember);
      mockRedis.set.mockResolvedValue('OK');

      const result = await service.register({
        email: 'new@example.com',
        password: 'securepassword123',
        businessName: 'My Business',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result).toHaveProperty('expiresIn');
      expect(mockAuthRepository.createTeamMemberWithBusiness).toHaveBeenCalledWith(
        'new@example.com',
        'new',
        expect.any(String),
        'My Business',
        'my-business',
      );
    });

    it('should throw ConflictException if email already exists', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(mockTeamMember);

      await expect(
        service.register({
          email: 'test@example.com',
          password: 'securepassword123',
          businessName: 'Another Business',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException if business email is taken', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(null);
      mockAuthRepository.isBusinessEmailTaken.mockResolvedValue(true);

      await expect(
        service.register({
          email: 'taken@example.com',
          password: 'securepassword123',
          businessName: 'Taken Business',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should append random suffix when slug is taken', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(null);
      mockAuthRepository.isBusinessEmailTaken.mockResolvedValue(false);
      mockAuthRepository.isSlugTaken.mockResolvedValue(true);
      mockAuthRepository.createTeamMemberWithBusiness.mockResolvedValue(mockTeamMember);
      mockRedis.set.mockResolvedValue('OK');

      await service.register({
        email: 'new@example.com',
        password: 'securepassword123',
        businessName: 'Test Business',
      });

      const slugArg = mockAuthRepository.createTeamMemberWithBusiness.mock.calls[0][4] as string;
      expect(slugArg).toMatch(/^test-business-[a-f0-9]{6}$/);
    });
  });

  // ─────────────────────────────────────────────
  // Login
  // ─────────────────────────────────────────────

  describe('login', () => {
    it('should throw UnauthorizedException for non-existent email', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: 'nonexistent@example.com', password: 'whatever' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for suspended accounts', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue({
        ...mockTeamMember,
        status: 'SUSPENDED',
      });

      await expect(
        service.login({ email: 'test@example.com', password: 'whatever' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for missing password hash', async () => {
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue({
        ...mockTeamMember,
        password_hash: null,
      });

      await expect(
        service.login({ email: 'test@example.com', password: 'whatever' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should return tokens on successful login with valid credentials', async () => {
      // We need to register first to get a real hash, then login with it
      // For unit tests, we mock at a higher level
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue(null);
      mockAuthRepository.isBusinessEmailTaken.mockResolvedValue(false);
      mockAuthRepository.isSlugTaken.mockResolvedValue(false);
      mockAuthRepository.createTeamMemberWithBusiness.mockImplementation(
        async (_email: string, _name: string, hash: string) => ({
          ...mockTeamMember,
          password_hash: hash,
        }),
      );
      mockRedis.set.mockResolvedValue('OK');
      mockAuthRepository.updateLastLogin.mockResolvedValue(undefined);

      // Register to get a real password hash
      await service.register({
        email: 'logintest@example.com',
        password: 'testpassword123',
        businessName: 'Login Test',
      });

      // Now get the hash that was used during registration
      const registeredHash = mockAuthRepository.createTeamMemberWithBusiness.mock.calls[0][2] as string;

      // Mock login lookup with the real hash
      mockAuthRepository.findTeamMemberByEmail.mockResolvedValue({
        ...mockTeamMember,
        password_hash: registeredHash,
      });

      const result = await service.login({
        email: 'logintest@example.com',
        password: 'testpassword123',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
    });
  });

  // ─────────────────────────────────────────────
  // Refresh tokens
  // ─────────────────────────────────────────────

  describe('refreshTokens', () => {
    it('should throw UnauthorizedException for invalid refresh token', async () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await expect(service.refreshTokens('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException when refresh token is revoked', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: mockTeamMember.id,
        businessId: mockTeamMember.business_id,
        email: mockTeamMember.email,
        role: mockTeamMember.role,
      });
      mockRedis.get.mockResolvedValue(null);

      await expect(service.refreshTokens('valid-but-revoked')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw and invalidate on token reuse (hash mismatch)', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: mockTeamMember.id,
        businessId: mockTeamMember.business_id,
        email: mockTeamMember.email,
        role: mockTeamMember.role,
      });
      mockRedis.get.mockResolvedValue('different-hash-value');

      await expect(service.refreshTokens('reused-token')).rejects.toThrow(
        UnauthorizedException,
      );

      expect(mockRedis.del).toHaveBeenCalledWith(
        `gosumo:refresh:${mockTeamMember.id}`,
      );
    });
  });

  // ─────────────────────────────────────────────
  // Logout
  // ─────────────────────────────────────────────

  describe('logout', () => {
    it('should delete refresh token from Redis', async () => {
      mockRedis.del.mockResolvedValue(1);

      await service.logout(mockTeamMember.id);

      expect(mockRedis.del).toHaveBeenCalledWith(
        `gosumo:refresh:${mockTeamMember.id}`,
      );
    });
  });

  // ─────────────────────────────────────────────
  // Profile
  // ─────────────────────────────────────────────

  describe('getProfile', () => {
    it('should return user profile with business info', async () => {
      mockAuthRepository.findTeamMemberById.mockResolvedValue(mockTeamMember);

      const profile = await service.getProfile(mockTeamMember.id);

      expect(profile).toEqual({
        id: mockTeamMember.id,
        email: 'test@example.com',
        name: 'test',
        role: 'OWNER',
        status: 'ACTIVE',
        businessId: mockTeamMember.business_id,
        businessName: 'Test Business',
        businessSlug: 'test-business',
        lastLoginAt: null,
        loginCount: 0,
      });
    });

    it('should throw NotFoundException for non-existent user', async () => {
      mockAuthRepository.findTeamMemberById.mockResolvedValue(null);

      await expect(service.getProfile('nonexistent-id')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─────────────────────────────────────────────
  // Change password
  // ─────────────────────────────────────────────

  describe('changePassword', () => {
    it('should throw NotFoundException for non-existent user', async () => {
      mockAuthRepository.findTeamMemberById.mockResolvedValue(null);

      await expect(
        service.changePassword('nonexistent', {
          currentPassword: 'old',
          newPassword: 'newpassword123',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw UnauthorizedException for wrong current password', async () => {
      mockAuthRepository.findTeamMemberById.mockResolvedValue({
        ...mockTeamMember,
        password_hash: 'scrypt:salt123:' + 'b'.repeat(128),
      });

      await expect(
        service.changePassword(mockTeamMember.id, {
          currentPassword: 'wrongpassword',
          newPassword: 'newpassword123',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});

// ─────────────────────────────────────────────
// RolesGuard
// ─────────────────────────────────────────────

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  function createMockContext(userRole: string, requiredRoles?: string[]): ExecutionContext {
    const mockContext = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn().mockReturnValue({
        getRequest: jest.fn().mockReturnValue({
          user: { sub: 'user-id', businessId: 'biz-id', email: 'test@test.com', role: userRole },
        }),
      }),
    } as unknown as ExecutionContext;

    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(requiredRoles);

    return mockContext;
  }

  it('should allow access when no roles are required', () => {
    const context = createMockContext('VIEWER', undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow OWNER to access MANAGER-required routes', () => {
    const context = createMockContext('OWNER', ['MANAGER']);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should allow MANAGER to access STAFF-required routes', () => {
    const context = createMockContext('MANAGER', ['STAFF']);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should deny VIEWER access to STAFF-required routes', () => {
    const context = createMockContext('VIEWER', ['STAFF']);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should deny STAFF access to OWNER-required routes', () => {
    const context = createMockContext('STAFF', ['OWNER']);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('should allow access when user has one of multiple required roles', () => {
    const context = createMockContext('MANAGER', ['OWNER', 'MANAGER']);
    expect(guard.canActivate(context)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// JwtStrategy
// ─────────────────────────────────────────────

describe('JwtStrategy', () => {
  it('should throw error when JWT_SECRET is not configured', () => {
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    expect(() => new JwtStrategy(configService)).toThrow('JWT_SECRET is not configured');
  });

  it('should validate and return AuthenticatedUser from payload', () => {
    const configService = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as unknown as ConfigService;

    const strategy = new JwtStrategy(configService);
    const payload = {
      sub: 'user-id',
      businessId: 'biz-id',
      email: 'test@example.com',
      role: 'OWNER',
    };

    const result = strategy.validate(payload);

    expect(result).toEqual({
      sub: 'user-id',
      businessId: 'biz-id',
      email: 'test@example.com',
      role: 'OWNER',
    });
  });

  it('should throw UnauthorizedException for payload missing sub', () => {
    const configService = {
      get: jest.fn().mockReturnValue('test-secret'),
    } as unknown as ConfigService;

    const strategy = new JwtStrategy(configService);

    expect(() =>
      strategy.validate({
        sub: '',
        businessId: 'biz-id',
        email: 'test@example.com',
        role: 'OWNER',
      }),
    ).toThrow(UnauthorizedException);
  });
});
