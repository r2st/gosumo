/**
 * GoogleStrategy unit tests.
 *
 * `AuthController.googleCallback` is `@Public()`, and the allowlist in
 * `public-route-contract.spec.ts` justifies that with "Passport validates the
 * Google authorization code and populates request.user before the handler
 * runs". This file tests the code that does the populating — the normalisation
 * step where a Google profile becomes the `GoogleProfile` that AuthService
 * trusts as an identity.
 *
 * The branch that matters most is the missing-email one. Google profiles are
 * not guaranteed to carry an email (the scope can be declined, and service
 * accounts have none), and the identity AuthService builds is keyed on it. A
 * strategy that let an email-less profile through would hand the auth flow an
 * `undefined` account key.
 *
 * The constructor's fallback branch is exercised too: the app must still boot
 * with Google unconfigured, because most self-hosted deployments never set it —
 * but it must say so, not fail silently at first use.
 */

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Profile } from 'passport-google-oauth20';

import { GoogleProfile, GoogleStrategy } from './google.strategy';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const CONFIGURED = {
  'app.google.clientId': 'client-id',
  'app.google.clientSecret': 'client-secret',
  'app.google.callbackUrl': 'https://gosumo.example/auth/google/callback',
};

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'google-user-1',
    displayName: 'Asha Rao',
    emails: [{ value: 'Asha.Rao@Example.com' }],
    photos: [{ value: 'https://lh3.googleusercontent.com/a/asha' }],
    ...overrides,
  } as Profile;
}

/** Runs `validate` and returns whatever it handed the Passport callback. */
function runValidate(
  strategy: GoogleStrategy,
  p: Profile,
): { error: Error | null | undefined; user: GoogleProfile | undefined } {
  let error: Error | null | undefined;
  let user: GoogleProfile | undefined;

  strategy.validate('access', 'refresh', p, ((e: Error | null, u?: GoogleProfile) => {
    error = e;
    user = u;
  }) as never);

  return { error, user };
}

describe('GoogleStrategy construction', () => {
  it('constructs when Google is configured', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    new GoogleStrategy(configWith(CONFIGURED));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([
    ['client id', { ...CONFIGURED, 'app.google.clientId': undefined }],
    ['client secret', { ...CONFIGURED, 'app.google.clientSecret': undefined }],
    ['both credentials', { 'app.google.callbackUrl': CONFIGURED['app.google.callbackUrl'] }],
  ])('still boots without a %s, but warns', (_label, values) => {
    // passport-google-oauth20 throws on empty credentials at construction time,
    // so the placeholders are what keep an unconfigured deployment bootable.
    // The warning is the only thing that stops that from being silent.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    expect(() => new GoogleStrategy(configWith(values))).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Google OAuth is not configured'));

    warn.mockRestore();
  });
});

describe('GoogleStrategy.validate', () => {
  const strategy = () => new GoogleStrategy(configWith(CONFIGURED));

  it('normalises a complete profile', () => {
    const { error, user } = runValidate(strategy(), profile());

    expect(error).toBeNull();
    expect(user).toEqual({
      googleId: 'google-user-1',
      // Lower-cased: account lookup is by email, and Google preserves the
      // casing the user typed. Two casings must not become two accounts.
      email: 'asha.rao@example.com',
      name: 'Asha Rao',
      avatarUrl: 'https://lh3.googleusercontent.com/a/asha',
    });
  });

  it('refuses a profile with no email', () => {
    const { error, user } = runValidate(strategy(), profile({ emails: undefined }));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/did not return an email/);
    expect(user).toBeUndefined();
  });

  it('refuses a profile whose email list is empty', () => {
    const { error, user } = runValidate(strategy(), profile({ emails: [] }));

    expect(error).toBeInstanceOf(Error);
    expect(user).toBeUndefined();
  });

  it('falls back to the email local part when Google sends no display name', () => {
    const { user } = runValidate(strategy(), profile({ displayName: '' }));

    // The display name keeps the casing Google sent, while the email key is
    // lower-cased — the name is a label, the email is an identifier.
    expect(user?.name).toBe('Asha.Rao');
    expect(user?.email).toBe('asha.rao@example.com');
  });

  it('uses a placeholder name when even the local part is unusable', () => {
    const { user } = runValidate(
      strategy(),
      profile({ displayName: '', emails: [{ value: '@example.com', verified: true }] }),
    );
    expect(user?.name).toBe('User');
  });

  it('records a null avatar rather than undefined when there is no photo', () => {
    // The column is nullable; `undefined` would be dropped by Prisma on update
    // and leave a stale avatar in place after the user removes theirs.
    const { user } = runValidate(strategy(), profile({ photos: undefined }));
    expect(user?.avatarUrl).toBeNull();
  });

  it('records a null avatar when the photo list is empty', () => {
    const { user } = runValidate(strategy(), profile({ photos: [] }));
    expect(user?.avatarUrl).toBeNull();
  });
});
