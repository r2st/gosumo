/**
 * Login must not answer questions it was not asked.
 *
 * `POST /v1/auth/login` is `@Public()` and reachable by anyone. Everything here
 * is about the two channels other than the response body that used to tell a
 * caller whether an address is a GoSumo account:
 *
 *   - **The clock.** A real account costs a bcrypt verification before it can
 *     answer; an address with no stored hash used to reach the throw having
 *     done one indexed query. Identical wording on both branches does not help
 *     when one of them returns two orders of magnitude sooner.
 *   - **The suspension message.** It was produced *before* the password was
 *     checked, so it answered for anyone — no credential required.
 *
 * These assert the *work*, not the wall clock: a duration assertion on a
 * bcrypt round is exactly the test that goes flaky on a loaded CI box, and what
 * makes the two paths indistinguishable is that they do the same thing, not
 * that they happened to take the same number of milliseconds on one run.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService, resolveBcryptCost } from './auth.service';

/**
 * `bcryptjs` exports non-configurable properties, so `jest.spyOn` cannot wrap
 * them. Mock the module instead and delegate to the real implementation — the
 * assertions below are about *which* calls happen, and a stubbed bcrypt would
 * make every one of them vacuous.
 */
jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof import('bcryptjs')>('bcryptjs');
  return {
    ...actual,
    hash: jest.fn(actual.hash),
    compare: jest.fn(actual.compare),
  };
});

import { AuthRepository, TeamMemberWithBusiness } from './auth.repository';
import { SessionService } from './session.service';
import { REDIS_CLIENT } from './redis.provider';

const hashMock = bcrypt.hash as unknown as jest.Mock;
const compareMock = bcrypt.compare as unknown as jest.Mock;

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const BUSINESS_ID = '660e8400-e29b-41d4-a716-446655440000';
const PASSWORD = 'Test1234!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

function buildTeamMember(
  overrides: Partial<TeamMemberWithBusiness> = {},
): TeamMemberWithBusiness {
  return {
    id: USER_ID,
    business_id: BUSINESS_ID,
    email: 'test@example.com',
    name: 'test',
    avatar_url: null,
    role: 'OWNER' as const,
    status: 'ACTIVE' as const,
    phone: null,
    password_hash: PASSWORD_HASH,
    totp_secret: null,
    last_login_at: null,
    login_count: 0,
    notification_prefs: {},
    invite_token: null,
    invited_by: null,
    invited_at: null,
    auth_provider: 'LOCAL' as const,
    google_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    business: {
      id: BUSINESS_ID,
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
      onboarding_progress: {},
      is_active: true,
      intelligence_opt_in: false,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    },
    ...overrides,
  } as TeamMemberWithBusiness;
}

/** The cost baked into a bcrypt hash string (`$2a$12$...` → 12). */
function costOf(hash: string): number {
  const parts = hash.split('$');
  return Number(parts[2]);
}

describe('AuthService — login discloses nothing about which addresses exist', () => {
  let service: AuthService;
  let repo: { findTeamMemberByEmail: jest.Mock; updateLastLogin: jest.Mock };
  let redis: {
    get: jest.Mock;
    del: jest.Mock;
    incr: jest.Mock;
    expire: jest.Mock;
    ttl: jest.Mock;
  };
  beforeEach(async () => {
    hashMock.mockClear();
    compareMock.mockClear();

    repo = {
      findTeamMemberByEmail: jest.fn(),
      updateLastLogin: jest.fn().mockResolvedValue(undefined),
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      ttl: jest.fn().mockResolvedValue(900),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AuthRepository, useValue: repo },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('tok') } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_k: string, fallback?: string) => fallback) },
        },
        {
          provide: SessionService,
          useValue: { createSession: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  // ═══════════════════════════════════════════
  // The clock
  // ═══════════════════════════════════════════

  it('verifies a password even when no account has that address', async () => {
    repo.findTeamMemberByEmail.mockResolvedValue(null);

    await expect(service.login({ email: 'nobody@example.com', password: PASSWORD })).rejects.toThrow(
      UnauthorizedException,
    );

    // The whole point: the miss path pays for a bcrypt round like the hit path,
    // instead of returning as soon as the query comes back empty.
    expect(compareMock).toHaveBeenCalledTimes(1);
    const [submitted, against] = compareMock.mock.calls[0] as [string, string];
    expect(submitted).toBe(PASSWORD);
    expect(against).toMatch(/^\$2[aby]\$/);
  });

  it('verifies a password for an OAuth-only account with no stored hash', async () => {
    // Same branch, different cause — an account that exists but logs in through
    // Google. It must be as slow to reject as a password account, or the gap
    // just moves rather than closing.
    repo.findTeamMemberByEmail.mockResolvedValue(
      buildTeamMember({ password_hash: null, auth_provider: 'GOOGLE' as const }),
    );

    await expect(service.login({ email: 'test@example.com', password: PASSWORD })).rejects.toThrow(
      UnauthorizedException,
    );

    expect(compareMock).toHaveBeenCalledTimes(1);
  });

  it('spends the same bcrypt cost on a miss as a stored hash would', async () => {
    // A dummy hash at a cheaper cost would be a quieter version of the same
    // leak — still measurably faster than the real thing.
    repo.findTeamMemberByEmail.mockResolvedValue(null);

    await expect(service.login({ email: 'nobody@example.com', password: PASSWORD })).rejects.toThrow(
      UnauthorizedException,
    );

    const [, against] = compareMock.mock.calls[0] as [string, string];
    expect(costOf(against)).toBe(resolveBcryptCost());
  });

  it('never compares against a hash that could actually match', async () => {
    repo.findTeamMemberByEmail.mockResolvedValue(null);

    await expect(service.login({ email: 'nobody@example.com', password: PASSWORD })).rejects.toThrow(
      UnauthorizedException,
    );

    const [, against] = compareMock.mock.calls[0] as [string, string];
    // Belt and braces: the sentinel must not be a hash of anything guessable,
    // or the miss path would start issuing tokens.
    await expect(bcrypt.compare(PASSWORD, against)).resolves.toBe(false);
    await expect(bcrypt.compare('', against)).resolves.toBe(false);
  });

  it('derives the sentinel hash once per process, not once per request', async () => {
    repo.findTeamMemberByEmail.mockResolvedValue(null);
    for (let i = 0; i < 3; i += 1) {
      await expect(
        service.login({ email: `nobody${i}@example.com`, password: PASSWORD }),
      ).rejects.toThrow(UnauthorizedException);
    }

    // Three misses, one derivation — otherwise the mitigation for a disclosure
    // would be a way to burn a bcrypt round per unauthenticated request.
    expect(hashMock).toHaveBeenCalledTimes(1);
    const hashes = compareMock.mock.calls.map((c) => c[1] as string);
    expect(new Set(hashes).size).toBe(1);
  });

  it('still rejects a miss with the shared wording', async () => {
    repo.findTeamMemberByEmail.mockResolvedValue(null);

    await expect(
      service.login({ email: 'nobody@example.com', password: PASSWORD }),
    ).rejects.toThrow('Invalid email or password');
  });

  it('still charges a miss against the lockout', async () => {
    repo.findTeamMemberByEmail.mockResolvedValue(null);

    await expect(
      service.login({ email: 'nobody@example.com', password: PASSWORD }),
    ).rejects.toThrow(UnauthorizedException);

    expect(redis.incr).toHaveBeenCalledWith('gosumo:nobody@example.com:login_attempts');
  });

  // ═══════════════════════════════════════════
  // The suspension message
  // ═══════════════════════════════════════════

  describe('a suspended account', () => {
    beforeEach(() => {
      repo.findTeamMemberByEmail.mockResolvedValue(
        buildTeamMember({ status: 'SUSPENDED' as TeamMemberWithBusiness['status'] }),
      );
    });

    it('is indistinguishable from any other address to a caller with the wrong password', async () => {
      // The oracle this closes: anyone could ask "is this address a suspended
      // GoSumo account?" and read the answer off the message, holding no
      // credential at all.
      await expect(
        service.login({ email: 'test@example.com', password: 'WrongPass1!' }),
      ).rejects.toThrow('Invalid email or password');
    });

    it('charges a wrong-password attempt against the lockout like any other', async () => {
      // Returning before the password check also meant these attempts were
      // never counted — that one address could be guessed at without limit.
      await expect(
        service.login({ email: 'test@example.com', password: 'WrongPass1!' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(redis.incr).toHaveBeenCalledWith('gosumo:test@example.com:login_attempts');
    });

    it('is disclosed to the one caller who proved they own the account', async () => {
      // Suspension is not a secret from its owner — telling them is the reason
      // the distinct message exists.
      await expect(
        service.login({ email: 'test@example.com', password: PASSWORD }),
      ).rejects.toThrow('Account has been suspended');
    });

    it('reaches the password check before deciding what to say', async () => {
      await expect(
        service.login({ email: 'test@example.com', password: 'WrongPass1!' }),
      ).rejects.toThrow(UnauthorizedException);

      expect(compareMock).toHaveBeenCalledTimes(1);
    });

    it('never issues tokens for a correct password', async () => {
      // Reordering the check must not have turned suspension into a warning.
      await expect(
        service.login({ email: 'test@example.com', password: PASSWORD }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
