import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { AuthRepository, TeamMemberWithBusiness } from './auth.repository';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

/** Refresh token Redis key prefix — TTL 7 days */
const REFRESH_TOKEN_PREFIX = 'gosumo:refresh:';
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const ACCESS_TOKEN_TTL = '15m';
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const BCRYPT_COST = 12;

interface JwtPayload {
  sub: string;
  businessId: string;
  email: string;
  role: string;
}

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, secondsToken: string, seconds: number): Promise<string | null>;
  del(key: string): Promise<number>;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly redis: RedisLike;

  constructor(
    private readonly authRepository: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    // Dynamic import of ioredis — injecting via constructor to avoid module-level dependency issues
    // In a production setup you'd use a dedicated Redis module, but for now we create an instance
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Redis = require('ioredis');
    const redisHost = this.configService.get<string>('app.redis.host', 'localhost');
    const redisPort = this.configService.get<number>('app.redis.port', 6379);
    this.redis = new Redis({ host: redisHost, port: redisPort }) as RedisLike;
  }

  // ─────────────────────────────────────────────
  // Registration
  // ─────────────────────────────────────────────

  async register(dto: RegisterDto): Promise<AuthTokensDto> {
    const { email, password, businessName } = dto;

    // Check if email already used
    const existing = await this.authRepository.findTeamMemberByEmail(email);
    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    // Check if business email is taken (businesses table has unique email)
    const emailTaken = await this.authRepository.isBusinessEmailTaken(email);
    if (emailTaken) {
      throw new ConflictException('A business with this email already exists');
    }

    // Generate slug from business name
    let slug = this.slugify(businessName);

    // Ensure slug uniqueness by appending random suffix if needed
    const slugTaken = await this.authRepository.isSlugTaken(slug);
    if (slugTaken) {
      slug = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    }

    // Hash password with bcrypt cost 12
    const passwordHash = await this.hashPassword(password);

    // Extract a display name from the email (before @)
    const name = email.split('@')[0] ?? 'User';

    // Create business + team member in transaction
    const teamMember = await this.authRepository.createTeamMemberWithBusiness(
      email,
      name,
      passwordHash,
      businessName,
      slug,
    );

    this.logger.log(`New registration: ${email} for business '${businessName}'`);

    // Generate tokens
    return this.generateTokens(teamMember);
  }

  // ─────────────────────────────────────────────
  // Login
  // ─────────────────────────────────────────────

  async login(dto: LoginDto): Promise<AuthTokensDto> {
    const { email, password } = dto;

    const teamMember = await this.authRepository.findTeamMemberByEmail(email);
    if (!teamMember) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!teamMember.password_hash) {
      throw new UnauthorizedException('Account not set up for password login');
    }

    if (teamMember.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account has been suspended');
    }

    const isPasswordValid = await this.verifyPassword(password, teamMember.password_hash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Update login stats (fire-and-forget, don't block login)
    this.authRepository.updateLastLogin(teamMember.id).catch((err: Error) => {
      this.logger.warn(`Failed to update last login for ${teamMember.id}: ${err.message}`);
    });

    this.logger.log(`Login: ${email}`);

    return this.generateTokens(teamMember);
  }

  // ─────────────────────────────────────────────
  // Refresh tokens
  // ─────────────────────────────────────────────

  async refreshTokens(refreshToken: string): Promise<AuthTokensDto> {
    // Verify the refresh token JWT
    let payload: JwtPayload;
    try {
      payload = this.jwtService.verify<JwtPayload>(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Check that the refresh token hash matches what's stored in Redis
    const storedHash = await this.redis.get(`${REFRESH_TOKEN_PREFIX}${payload.sub}`);
    if (!storedHash) {
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    const tokenHash = this.hashToken(refreshToken);
    if (storedHash !== tokenHash) {
      // Possible token reuse attack — invalidate all tokens
      await this.redis.del(`${REFRESH_TOKEN_PREFIX}${payload.sub}`);
      this.logger.warn(`Refresh token reuse detected for user ${payload.sub}`);
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    // Fetch fresh user data
    const teamMember = await this.authRepository.findTeamMemberById(payload.sub);
    if (!teamMember) {
      throw new UnauthorizedException('User account not found');
    }

    if (teamMember.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account has been suspended');
    }

    return this.generateTokens(teamMember);
  }

  // ─────────────────────────────────────────────
  // Logout
  // ─────────────────────────────────────────────

  async logout(userId: string): Promise<void> {
    await this.redis.del(`${REFRESH_TOKEN_PREFIX}${userId}`);
    this.logger.log(`Logout: user ${userId}`);
  }

  // ─────────────────────────────────────────────
  // Profile
  // ─────────────────────────────────────────────

  async getProfile(userId: string): Promise<{
    id: string;
    email: string;
    name: string;
    role: string;
    status: string;
    businessId: string;
    businessName: string;
    businessSlug: string;
    lastLoginAt: Date | null;
    loginCount: number;
  }> {
    const teamMember = await this.authRepository.findTeamMemberById(userId);
    if (!teamMember) {
      throw new NotFoundException('User not found');
    }

    return {
      id: teamMember.id,
      email: teamMember.email,
      name: teamMember.name,
      role: teamMember.role,
      status: teamMember.status,
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

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const teamMember = await this.authRepository.findTeamMemberById(userId);
    if (!teamMember) {
      throw new NotFoundException('User not found');
    }

    if (!teamMember.password_hash) {
      throw new BadRequestException('Account not set up for password login');
    }

    const isValid = await this.verifyPassword(dto.currentPassword, teamMember.password_hash);
    if (!isValid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const newHash = await this.hashPassword(dto.newPassword);
    await this.authRepository.updateTeamMember(userId, {
      password_hash: newHash,
    });

    // Invalidate refresh token to force re-login on other devices
    await this.redis.del(`${REFRESH_TOKEN_PREFIX}${userId}`);

    this.logger.log(`Password changed for user ${userId}`);
  }

  // ─────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────

  private async generateTokens(teamMember: TeamMemberWithBusiness): Promise<AuthTokensDto> {
    const payload: JwtPayload = {
      sub: teamMember.id,
      businessId: teamMember.business_id,
      email: teamMember.email,
      role: teamMember.role,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, { expiresIn: ACCESS_TOKEN_TTL }),
      this.jwtService.signAsync(payload, { expiresIn: '7d' }),
    ]);

    // Store refresh token hash in Redis
    const tokenHash = this.hashToken(refreshToken);
    await this.redis.set(
      `${REFRESH_TOKEN_PREFIX}${teamMember.id}`,
      tokenHash,
      'EX',
      REFRESH_TOKEN_TTL_SECONDS,
    );

    const tokens = new AuthTokensDto();
    tokens.accessToken = accessToken;
    tokens.refreshToken = refreshToken;
    tokens.expiresIn = ACCESS_TOKEN_TTL_SECONDS;
    return tokens;
  }

  private async hashPassword(password: string): Promise<string> {
    // Use Node.js crypto scrypt as a fallback since bcrypt is not in package.json
    // We implement bcrypt-compatible hashing via the crypto module
    // Actually, let's use a dynamic require for bcrypt if available, else use scrypt
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bcrypt = require('bcrypt');
      return bcrypt.hash(password, BCRYPT_COST) as Promise<string>;
    } catch {
      // bcrypt not installed — use scrypt
      return new Promise<string>((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString('hex');
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
          if (err) reject(err);
          else resolve(`scrypt:${salt}:${derivedKey.toString('hex')}`);
        });
      });
    }
  }

  private async verifyPassword(password: string, hash: string): Promise<boolean> {
    if (hash.startsWith('scrypt:')) {
      // scrypt format: scrypt:<salt>:<hash>
      const parts = hash.split(':');
      if (parts.length !== 3) return false;
      const salt = parts[1]!;
      const storedHash = parts[2]!;
      return new Promise<boolean>((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
          if (err) reject(err);
          else resolve(crypto.timingSafeEqual(
            Buffer.from(storedHash, 'hex'),
            derivedKey,
          ));
        });
      });
    }

    // bcrypt hash
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bcrypt = require('bcrypt');
      return bcrypt.compare(password, hash) as Promise<boolean>;
    } catch {
      return false;
    }
  }

  /**
   * Slugify a business name: lowercase, replace non-alphanumeric with hyphens,
   * collapse multiple hyphens, trim leading/trailing hyphens.
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * SHA-256 hash of a token for safe storage.
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
