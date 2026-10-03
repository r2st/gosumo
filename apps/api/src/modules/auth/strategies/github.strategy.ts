import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-github2';

export interface GitHubProfile {
  githubId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

@Injectable()
export class GitHubStrategy extends PassportStrategy(Strategy, 'github') {
  private readonly logger = new Logger(GitHubStrategy.name);

  constructor(configService: ConfigService) {
    const clientID = configService.get<string>('app.github.clientId');
    const clientSecret = configService.get<string>('app.github.clientSecret');
    const callbackURL = configService.get<string>('app.github.callbackUrl');

    super({
      clientID: clientID ?? 'GITHUB_CLIENT_ID_NOT_CONFIGURED',
      clientSecret: clientSecret ?? 'GITHUB_CLIENT_SECRET_NOT_CONFIGURED',
      callbackURL,
      scope: ['user:email'],
    });

    if (!clientID || !clientSecret) {
      this.logger.warn(
        'GitHub OAuth is not configured (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET missing); /auth/github routes will not work',
      );
    }
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: (err: Error | null, user?: GitHubProfile) => void,
  ): void {
    const emails: Array<{ value: string; primary?: boolean; verified?: boolean }> =
      profile.emails ?? [];
    const primary = emails.find((e) => e.primary && e.verified) ?? emails[0];
    const email = primary?.value;

    if (!email) {
      done(new Error('GitHub account did not return an email address'), undefined);
      return;
    }

    const user: GitHubProfile = {
      githubId: String(profile.id),
      email: email.toLowerCase(),
      name: profile.displayName || profile.username || email.split('@')[0] || 'User',
      avatarUrl: profile.photos?.[0]?.value ?? null,
    };

    done(null, user);
  }
}
