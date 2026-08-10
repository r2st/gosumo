import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { SessionService } from '../session.service';
import { ConfigurationError } from '@gosumo/shared';

export interface JwtPayload {
  sub: string;
  businessId: string;
  email: string;
  role: string;
  sessionId?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly sessionService: SessionService,
  ) {
    const secret = configService.get<string>('app.jwt.secret');
    if (!secret) {
      throw new ConfigurationError('app.jwt.secret', 'JWT_SECRET is not configured');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    if (!payload.sub || !payload.businessId) {
      throw new UnauthorizedException('Invalid token payload');
    }

    // Session-bound tokens are rejected once their session is revoked or expires,
    // so logout / session-revocation takes effect immediately (not after 15 min).
    if (payload.sessionId) {
      const active = await this.sessionService.isActive(payload.sub, payload.sessionId);
      if (!active) {
        throw new UnauthorizedException('Session has expired or been revoked');
      }
      // Best-effort recency update; failures must not block the request.
      void this.sessionService.touch(payload.sub, payload.sessionId).catch(() => undefined);
    }

    return {
      sub: payload.sub,
      businessId: payload.businessId,
      email: payload.email,
      role: payload.role,
      sessionId: payload.sessionId,
    };
  }
}
