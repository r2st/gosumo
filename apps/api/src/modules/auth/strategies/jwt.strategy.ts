import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import { SessionService } from '../session.service';
import { ConfigurationError } from '@gosumo/shared';

/**
 * Which of the two tokens in a pair this one is.
 *
 * Access and refresh tokens are signed with the same secret and, apart from
 * `jti`/`exp`, carry byte-identical claims. Without this discriminator the
 * bearer guard could not tell them apart, so a refresh token was a perfectly
 * valid `Authorization: Bearer` credential — see {@link JwtPayload.type}.
 */
export type JwtTokenType = 'access' | 'refresh';

export interface JwtPayload {
  sub: string;
  businessId: string;
  email: string;
  role: string;
  sessionId?: string;
  /**
   * Access or refresh. Optional only because tokens signed before this claim
   * existed are still in circulation; see {@link JwtStrategy.validate} and
   * `AuthService.refreshTokens` for how each side treats a missing value.
   */
  type?: JwtTokenType;
  /**
   * Unique id for this individual token (RFC 7519 `jti`).
   *
   * Every other claim in this payload is stable across a refresh — `sessionId`
   * deliberately so — which left `iat` as the only thing distinguishing a
   * rotated token from the one it replaced. `iat` has one-second resolution, so
   * a rotation that completed inside the same second re-signed a byte-identical
   * refresh token, and the "has this token been rotated away?" check in
   * `SessionService.verifyRefreshToken` compares hashes: an identical token
   * hashes identically, so a replayed old token was indistinguishable from the
   * legitimate new one and passed. `jti` makes each signing unique by
   * construction, independent of the clock.
   */
  jti?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly logger = new Logger(JwtStrategy.name);

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

    // Only an access token may authenticate a request.
    //
    // Both tokens in a pair are signed with the same secret and carry the same
    // claims, so before the `type` claim existed this guard accepted either
    // one: a refresh token worked as a bearer credential against every
    // protected route. That turned the two properties the refresh token is
    // given precisely because it is long-lived into liabilities — it lives for
    // seven days rather than fifteen minutes, and it is the half that gets
    // written down (localStorage, the OAuth callback fragment, the logout
    // request body). It also made rotation decorative: a rotated-away refresh
    // token is rejected at `/auth/refresh`, but it kept working as an access
    // token until its own seven-day expiry, so detecting a stolen token bought
    // nothing.
    //
    // Tokens signed before the claim existed have no `type` and are rejected
    // here. That is deliberate, and it costs an active user nothing: the
    // dashboard's API client already refreshes once on a 401 and replays the
    // request, and `refreshTokens` still accepts a type-less refresh token, so
    // the pair silently upgrades on the next call. Accepting them instead
    // would leave every refresh token issued before the deploy usable as a
    // bearer credential for a further seven days, which is the whole bug.
    if (payload.type !== 'access') {
      throw new UnauthorizedException('This token cannot be used to authenticate a request');
    }

    // Session-bound tokens are rejected once their session is revoked or expires,
    // so logout / session-revocation takes effect immediately (not after 15 min).
    if (payload.sessionId) {
      const active = await this.sessionService.isActive(payload.sub, payload.sessionId);
      if (!active) {
        throw new UnauthorizedException('Session has expired or been revoked');
      }
      // Best-effort recency update; failures must not block the request.
      void this.sessionService
        .touch(payload.sub, payload.sessionId)
        .catch((err: unknown) => {
          this.logger.debug(
            `Session touch failed for user ${payload.sub}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
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
