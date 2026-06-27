import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { SessionDto } from './dto/session.dto';
import { SessionMeta } from './session.service';
import { GoogleProfile } from './strategies/google.strategy';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // Local auth
  // ─────────────────────────────────────────────

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new business and owner account' })
  @ApiResponse({ status: 201, description: 'Account created', type: AuthTokensDto })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async register(@Body() dto: RegisterDto, @Req() req: Request): Promise<any> {
    const tokens = await this.authService.register(dto, this.sessionMeta(req));
    const payload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return {
      user: {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        businessId: payload.businessId,
        name: dto.name,
        twoFactorEnabled: false,
        createdAt: new Date().toISOString(),
      },
      tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      requiresTwoFactor: false,
    };
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful', type: AuthTokensDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() dto: LoginDto, @Req() req: Request): Promise<any> {
    const tokens = await this.authService.login(dto, this.sessionMeta(req));
    // Decode user info from the access token to include in response
    const payload = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    return {
      user: {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        businessId: payload.businessId,
        name: payload.email.split('@')[0],
        twoFactorEnabled: false,
        createdAt: new Date().toISOString(),
      },
      tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      requiresTwoFactor: false,
    };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token using a refresh token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed', type: AuthTokensDto })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(@Body('refreshToken') refreshToken: string): Promise<AuthTokensDto> {
    return this.authService.refreshTokens(refreshToken);
  }

  // ─────────────────────────────────────────────
  // Google OAuth
  // ─────────────────────────────────────────────

  @Public()
  @Get('google')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Begin Google OAuth login (redirects to Google)' })
  googleAuth(): void {
    // Passport redirects to Google's consent screen; this body never runs.
  }

  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Google OAuth callback — issues tokens and redirects to the dashboard' })
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const profile = req.user as GoogleProfile;
    const tokens = await this.authService.handleGoogleLogin(profile, this.sessionMeta(req));

    const frontendUrl = this.configService.get<string>(
      'app.frontendUrl',
      'http://localhost:3001',
    );
    const redirectUrl =
      `${frontendUrl}/auth/callback` +
      `?accessToken=${encodeURIComponent(tokens.accessToken)}` +
      `&refreshToken=${encodeURIComponent(tokens.refreshToken)}` +
      `&expiresIn=${tokens.expiresIn}`;

    res.redirect(redirectUrl);
  }

  // ─────────────────────────────────────────────
  // Password reset
  // ─────────────────────────────────────────────

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset link' })
  @ApiResponse({ status: 200, description: 'Reset link sent if the account exists' })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.authService.requestPasswordReset(dto.email);
    // Identical response regardless of account existence (no enumeration).
    return { message: 'If an account exists for that email, a reset link has been sent.' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using a reset token' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.authService.resetPassword(dto);
    return { message: 'Password has been reset. Please log in with your new password.' };
  }

  // ─────────────────────────────────────────────
  // Session management (authenticated)
  // ─────────────────────────────────────────────

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Logout the current session' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<{ message: string }> {
    await this.authService.logout(user.sub, user.sessionId);
    return { message: 'Logged out successfully' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Logout all sessions for the current user' })
  @ApiResponse({ status: 200, description: 'All sessions revoked' })
  async logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<{ message: string }> {
    await this.authService.logoutAll(user.sub);
    return { message: 'All sessions have been revoked' };
  }

  @Get('sessions')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List active sessions for the current user' })
  @ApiResponse({ status: 200, description: 'Active sessions', type: [SessionDto] })
  async getSessions(@CurrentUser() user: AuthenticatedUser): Promise<SessionDto[]> {
    return this.authService.getActiveSessions(user.sub, user.sessionId);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke a specific session' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId') sessionId: string,
  ): Promise<{ message: string }> {
    await this.authService.revokeSession(user.sub, sessionId);
    return { message: 'Session revoked' };
  }

  // ─────────────────────────────────────────────
  // Profile / password
  // ─────────────────────────────────────────────

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get the current user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  async getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.sub);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Change password for the current user' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 401, description: 'Current password is incorrect' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ message: string }> {
    await this.authService.changePassword(user.sub, dto);
    return { message: 'Password changed successfully' };
  }

  private sessionMeta(req: Request): SessionMeta {
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()) ??
      req.ip ??
      null;
    return {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
    };
  }
}
