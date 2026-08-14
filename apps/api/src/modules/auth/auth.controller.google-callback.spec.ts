/**
 * `AuthController.googleCallback` — how the OAuth tokens get back to the browser.
 *
 * This handler is the one place in the API that hands a refresh token to a
 * *navigation* rather than to a fetch response, and where it puts that token in
 * the URL decides who else gets a copy of it.
 *
 * A query string is part of the request line. It reaches the reverse proxy's
 * access log, any CDN in front of it, and the `Referer` header that the
 * callback page attaches to its very next request — so a seven-day refresh
 * token in a query string is a silent account takeover for anyone who can read
 * a log, for as long as that log is retained. A fragment is never transmitted:
 * the browser strips it before the request line is built and never puts it in
 * `Referer`.
 *
 * These tests pin the fragment, and pin that the query string stays empty —
 * the failure mode is a well-meaning refactor that "also" passes the tokens as
 * query params for compatibility, which restores the whole leak.
 */
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

describe('AuthController.googleCallback', () => {
  let controller: AuthController;
  let authService: { handleGoogleLogin: jest.Mock };
  let redirect: jest.Mock;

  /** The URL the handler redirected to. */
  async function callback(): Promise<string> {
    const req = {
      user: { email: 'operator@acme.in', googleId: 'g-1' },
      headers: { 'user-agent': 'Mozilla/5.0' },
      socket: { remoteAddress: '203.0.113.9' },
    } as unknown as Request;
    await controller.googleCallback(req, { redirect } as unknown as Response);
    return redirect.mock.calls[0]![0] as string;
  }

  beforeEach(async () => {
    authService = { handleGoogleLogin: jest.fn().mockResolvedValue(TOKENS) };
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

  it('puts no credential in the query string, where a proxy would log it', async () => {
    const url = new URL(await callback());

    expect(url.search).toBe('');
    expect(url.searchParams.get('accessToken')).toBeNull();
    expect(url.searchParams.get('refreshToken')).toBeNull();
  });

  it('keeps the refresh token out of everything a server would see', async () => {
    const url = new URL(await callback());

    // Everything before the '#' is what leaves the browser as the request line.
    const transmitted = url.origin + url.pathname + url.search;
    expect(transmitted).not.toContain(TOKENS.refreshToken);
    expect(transmitted).not.toContain(TOKENS.accessToken);
  });

  it('lands on the dashboard callback route of the configured frontend', async () => {
    const url = new URL(await callback());

    expect(url.origin).toBe('https://gosumo.aiknol.com');
    expect(url.pathname).toBe('/auth/callback');
  });

  it('escapes a token that contains URL-significant characters', async () => {
    authService.handleGoogleLogin.mockResolvedValue({
      ...TOKENS,
      refreshToken: 'a+b/c=d&e#f',
    });

    const url = new URL(await callback());
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));

    // An unescaped '#' would truncate the fragment and an unescaped '&' would
    // split it into a bogus extra parameter.
    expect(fragment.get('refreshToken')).toBe('a+b/c=d&e#f');
  });

  it('passes the caller’s IP and user agent through to the session record', async () => {
    await callback();

    expect(authService.handleGoogleLogin).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'operator@acme.in' }),
      expect.objectContaining({ ip: '203.0.113.9', userAgent: 'Mozilla/5.0' }),
    );
  });
});
