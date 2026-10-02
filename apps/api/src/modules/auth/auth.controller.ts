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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
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
import { AuthThrottle } from './auth-throttle.decorator';
import { SelfService } from './decorators/self-service.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { clientIp } from '../../common/utils/client-ip.util';

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
  @AuthThrottle('register')
  @Post('register')
  @ApiOperation({ summary: 'Register a new business and owner account' })
  @ApiResponse({ status: 201, description: 'Account created', type: AuthTokensDto })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  @ApiResponse({ status: 429, description: 'Too many signup attempts from this address' })
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
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
  @AuthThrottle('login')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful', type: AuthTokensDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({ status: 429, description: 'Too many login attempts from this address' })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
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
  @AuthThrottle('refresh')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token using a refresh token' })
  @ApiResponse({ status: 200, description: 'Tokens refreshed', type: AuthTokensDto })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiResponse({ status: 429, description: 'Too many refresh attempts from this address' })
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
  @ApiResponse({ status: 200, description: 'Paginated google list for this business' })
  googleAuth(): void {
    // Passport redirects to Google's consent screen; this body never runs.
  }

  @Public()
  @Get('google/callback')
  @UseGuards(AuthGuard('google'))
  @ApiOperation({ summary: 'Google OAuth callback — issues tokens and redirects to the dashboard' })
  @ApiResponse({ status: 200, description: 'Paginated callback list for this business' })
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const profile = req.user as GoogleProfile;
    const tokens = await this.authService.handleGoogleLogin(profile, this.sessionMeta(req));

    const frontendUrl = this.configService.get<string>(
      'app.frontendUrl',
      'http://localhost:3001',
    );
    // The tokens go in the URL *fragment*, not the query string.
    //
    // A fragment is never transmitted: it does not appear in the request line,
    // so it stays out of the reverse proxy's access log, out of any upstream
    // CDN, and out of the `Referer` header the callback page sends on its next
    // request. A query string is in all three, and `refreshToken` is a
    // seven-day credential — one that reaches an access log is a silent
    // account takeover for as long as the log is retained.
    //
    // The dashboard's callback page reads the fragment; it also still accepts
    // the query form, so deploy the web app before the API.
    const fragment =
      `accessToken=${encodeURIComponent(tokens.accessToken)}` +
      `&refreshToken=${encodeURIComponent(tokens.refreshToken)}` +
      `&expiresIn=${tokens.expiresIn}`;

    res.redirect(`${frontendUrl}/auth/callback#${fragment}`);
  }

  // ─────────────────────────────────────────────
  // Password reset
  // ─────────────────────────────────────────────

  @Public()
  @AuthThrottle('forgot-password')
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a password reset link' })
  @ApiResponse({ status: 200, description: 'Reset link sent if the account exists' })
  @ApiResponse({ status: 429, description: 'Too many reset requests' })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<{ message: string }> {
    await this.authService.requestPasswordReset(dto.email);
    // Identical response regardless of account existence (no enumeration).
    return { message: 'If an account exists for that email, a reset link has been sent.' };
  }

  @Public()
  @AuthThrottle('reset-password')
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using a reset token' })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiResponse({ status: 429, description: 'Too many reset attempts from this address' })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<{ message: string }> {
    await this.authService.resetPassword(dto);
    return { message: 'Password has been reset. Please log in with your new password.' };
  }

  // ─────────────────────────────────────────────
  // Session management (authenticated)
  // ─────────────────────────────────────────────

  @SelfService()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Logout the current session' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<{ message: string }> {
    await this.authService.logout(user.sub, user.sessionId);
    return { message: 'Logged out successfully' };
  }

  @SelfService()
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

  @SelfService()
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke a specific session' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'sessionId', description: 'Session UUID' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  async revokeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('sessionId', UuidValidationPipe) sessionId: string,
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
    return this.authService.getProfile(user.businessId, user.sub);
  }

  @SelfService()
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
    await this.authService.changePassword(user.businessId, user.sub, dto);
    return { message: 'Password changed successfully' };
  }

  private sessionMeta(req: Request): SessionMeta {
    return {
      // Shared with AuthThrottleGuard so a session record and the throttle
      // window that admitted it always name the same caller.
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    };
  }
}
