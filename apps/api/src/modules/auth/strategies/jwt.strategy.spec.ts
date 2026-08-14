import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigurationError } from '@gosumo/shared';
import { JwtStrategy, JwtPayload } from './jwt.strategy';
import { SessionService } from '../session.service';

const config = (secret?: string): ConfigService =>
  ({ get: () => secret }) as unknown as ConfigService;

const payload = (overrides: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: 'user-1',
  businessId: 'biz-1',
  email: 'op@example.com',
  role: 'MANAGER',
  ...overrides,
});

describe('JwtStrategy', () => {
  let sessions: { isActive: jest.Mock; touch: jest.Mock };
  let strategy: JwtStrategy;

  beforeEach(() => {
    sessions = {
      isActive: jest.fn().mockResolvedValue(true),
      touch: jest.fn().mockResolvedValue(undefined),
    };
    strategy = new JwtStrategy(
      config('a-secret'),
      sessions as unknown as SessionService,
    );
  });

  describe('construction', () => {
    it('refuses to boot without a signing secret', () => {
      expect(
        () =>
          new JwtStrategy(config(), sessions as unknown as SessionService),
      ).toThrow(ConfigurationError);
    });

    it('names the missing config key in the failure', () => {
      expect(
        () =>
          new JwtStrategy(config(''), sessions as unknown as SessionService),
      ).toThrow(/JWT_SECRET is not configured/);
    });
  });

  describe('validate', () => {
    it('maps the claims onto the authenticated user', async () => {
      await expect(strategy.validate(payload())).resolves.toEqual({
        sub: 'user-1',
        businessId: 'biz-1',
        email: 'op@example.com',
        role: 'MANAGER',
        sessionId: undefined,
      });
    });

    it('rejects a token with no subject', async () => {
      await expect(strategy.validate(payload({ sub: '' }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token carrying no tenant, so nothing runs untenanted', async () => {
      await expect(
        strategy.validate(payload({ businessId: '' })),
      ).rejects.toThrow('Invalid token payload');
    });

    it('skips the session lookup entirely for a session-less token', async () => {
      await strategy.validate(payload());
      expect(sessions.isActive).not.toHaveBeenCalled();
      expect(sessions.touch).not.toHaveBeenCalled();
    });
  });

  describe('session-bound tokens', () => {
    const bound = payload({ sessionId: 'sess-1' });

    it('accepts a token whose session is still active', async () => {
      await expect(strategy.validate(bound)).resolves.toEqual(
        expect.objectContaining({ sessionId: 'sess-1' }),
      );
      expect(sessions.isActive).toHaveBeenCalledWith('user-1', 'sess-1');
    });

    it('rejects a token whose session was revoked, without waiting for expiry', async () => {
      sessions.isActive.mockResolvedValueOnce(false);
      await expect(strategy.validate(bound)).rejects.toThrow(
        'Session has expired or been revoked',
      );
      expect(sessions.touch).not.toHaveBeenCalled();
    });

    it('refreshes session recency on every accepted request', async () => {
      await strategy.validate(bound);
      expect(sessions.touch).toHaveBeenCalledWith('user-1', 'sess-1');
    });

    it('lets the request through when the recency update fails', async () => {
      sessions.touch.mockRejectedValueOnce(new Error('redis down'));
      await expect(strategy.validate(bound)).resolves.toEqual(
        expect.objectContaining({ sub: 'user-1' }),
      );
    });

    it('does not await the recency update, so a slow Redis cannot stall auth', async () => {
      let settle: (() => void) | undefined;
      sessions.touch.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );
      await expect(strategy.validate(bound)).resolves.toBeDefined();
      settle?.();
    });

    it('propagates a session-store failure rather than admitting the token', async () => {
      sessions.isActive.mockRejectedValueOnce(new Error('redis down'));
      await expect(strategy.validate(bound)).rejects.toThrow('redis down');
    });
  });
});
