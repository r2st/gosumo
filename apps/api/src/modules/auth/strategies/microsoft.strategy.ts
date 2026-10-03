import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-microsoft';

export interface MicrosoftProfile {
  microsoftId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

@Injectable()
export class MicrosoftStrategy extends PassportStrategy(Strategy, 'microsoft') {
  private readonly logger = new Logger(MicrosoftStrategy.name);

  constructor(configService: ConfigService) {
    const clientID = configService.get<string>('app.microsoft.clientId');
    const clientSecret = configService.get<string>('app.microsoft.clientSecret');
    const callbackURL = configService.get<string>('app.microsoft.callbackUrl');

    super({
      clientID: clientID ?? 'MICROSOFT_CLIENT_ID_NOT_CONFIGURED',
      clientSecret: clientSecret ?? 'MICROSOFT_CLIENT_SECRET_NOT_CONFIGURED',
      callbackURL,
      scope: ['user.read'],
      tenant: 'common',
      authorizationURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    });

    if (!clientID || !clientSecret) {
      this.logger.warn(
        'Microsoft OAuth is not configured (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET missing); /auth/microsoft routes will not work',
      );
    }
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: (err: Error | null, user?: MicrosoftProfile) => void,
  ): void {
    const email =
      profile.emails?.[0]?.value ??
      profile._json?.mail ??
      profile._json?.userPrincipalName;

    if (!email) {
      done(new Error('Microsoft account did not return an email address'), undefined);
      return;
    }

    const user: MicrosoftProfile = {
      microsoftId: profile.id,
      email: email.toLowerCase(),
      name: profile.displayName || email.split('@')[0] || 'User',
      avatarUrl: null,
    };

    done(null, user);
  }
}
