import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

const TOKENS = {
  accessToken: 'access.jwt.value',
  refreshToken: 'refresh-token-value',
  expiresIn: 900,
};

describe('AuthController.githubCallback', () => {
  let controller: AuthController;
  let authService: { handleGitHubLogin: jest.Mock };
  let redirect: jest.Mock;

  async function callback(): Promise<string> {
    const req = {
      user: { email: 'dev@acme.in', githubId: 'gh-42' },
      headers: { 'user-agent': 'Mozilla/5.0' },
      socket: { remoteAddress: '203.0.113.10' },
    } as unknown as Request;
    await controller.githubCallback(req, { redirect } as unknown as Response);
    return redirect.mock.calls[0]![0] as string;
  }

  beforeEach(async () => {
    authService = { handleGitHubLogin: jest.fn().mockResolvedValue(TOKENS) };
    redirect = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, fallback?: string) =>
              key === 'app.frontendUrl' ? 'https://gosumo.aiknol.com' : fallback,
            ),
          },
        },
      ],
    }).compile();

    controller = module.get(AuthController);
  });

  it('returns the tokens in the URL fragment', async () => {
    const url = new URL(await callback());
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));

    expect(fragment.get('accessToken')).toBe(TOKENS.accessToken);
    expect(fragment.get('refreshToken')).toBe(TOKENS.refreshToken);
    expect(fragment.get('expiresIn')).toBe(String(TOKENS.expiresIn));
  });

  it('puts no credential in the query string', async () => {
    const url = new URL(await callback());

    expect(url.search).toBe('');
    expect(url.searchParams.get('accessToken')).toBeNull();
    expect(url.searchParams.get('refreshToken')).toBeNull();
  });

  it('keeps the refresh token out of the transmitted portion', async () => {
    const url = new URL(await callback());
    const transmitted = url.origin + url.pathname + url.search;

    expect(transmitted).not.toContain(TOKENS.refreshToken);
    expect(transmitted).not.toContain(TOKENS.accessToken);
  });

  it('lands on the dashboard callback route', async () => {
    const url = new URL(await callback());

    expect(url.origin).toBe('https://gosumo.aiknol.com');
    expect(url.pathname).toBe('/auth/callback');
  });

  it('passes the caller IP and user agent to the session record', async () => {
    await callback();

    expect(authService.handleGitHubLogin).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'dev@acme.in' }),
      expect.objectContaining({ ip: '203.0.113.10', userAgent: 'Mozilla/5.0' }),
    );
  });

  it('escapes URL-significant characters in tokens', async () => {
    authService.handleGitHubLogin.mockResolvedValue({
      ...TOKENS,
      refreshToken: 'a+b/c=d&e#f',
    });

    const url = new URL(await callback());
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));

    expect(fragment.get('refreshToken')).toBe('a+b/c=d&e#f');
  });
});
