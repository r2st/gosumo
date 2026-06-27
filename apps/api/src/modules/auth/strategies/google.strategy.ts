import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile, VerifyCallback } from 'passport-google-oauth20';

/**
 * Normalized identity extracted from a Google profile and handed to AuthService.
 * Passport attaches this to `request.user` on the callback route.
 */
export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(configService: ConfigService) {
    const clientID = configService.get<string>('app.google.clientId');
    const clientSecret = configService.get<string>('app.google.clientSecret');
    const callbackURL = configService.get<string>('app.google.callbackUrl');

    super({
      // passport-google-oauth20 requires non-empty credentials at construction
      // time. Fall back to placeholders so the app still boots when Google is
      // not configured; the route will fail clearly if actually used.
      clientID: clientID ?? 'GOOGLE_CLIENT_ID_NOT_CONFIGURED',
      clientSecret: clientSecret ?? 'GOOGLE_CLIENT_SECRET_NOT_CONFIGURED',
      callbackURL,
      scope: ['email', 'profile'],
    });

    if (!clientID || !clientSecret) {
      this.logger.warn(
        'Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing); /auth/google routes will not work',
      );
    }
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      done(new Error('Google account did not return an email address'), undefined);
      return;
    }

    const user: GoogleProfile = {
      googleId: profile.id,
      email: email.toLowerCase(),
      name: profile.displayName || email.split('@')[0] || 'User',
      avatarUrl: profile.photos?.[0]?.value ?? null,
    };

    done(null, user);
  }
}
