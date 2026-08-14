import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// ── Mocks ────────────────────────────────────────────────────────────────────

// next/navigation
const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();
// Swappable: `useSearchParams()` is typed nullable and really is null on a
// statically rendered pass, which is one of the branches under test.
let searchParamsValue: URLSearchParams | null = mockSearchParams;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => searchParamsValue,
}));

// token-store
const tokenStoreState: Record<string, string | null> = {
  accessToken: null,
  refreshToken: null,
};
vi.mock('@/lib/token-store', () => ({
  tokenStore: {
    getAccessToken: () => tokenStoreState.accessToken,
    setAccessToken: (t: string | null) => { tokenStoreState.accessToken = t; },
    getRefreshToken: () => tokenStoreState.refreshToken,
    setRefreshToken: (t: string | null) => { tokenStoreState.refreshToken = t; },
    clear: () => { tokenStoreState.accessToken = null; tokenStoreState.refreshToken = null; },
  },
}));

// auth-provider
const mockRefreshProfile = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    status: 'unauthenticated',
    user: null,
    business: null,
    refreshProfile: mockRefreshProfile,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  }),
}));

// ── Import AFTER mocks ──────────────────────────────────────────────────────
import AuthCallbackPage from '@/app/auth/callback/page';

// ── Helpers ─────────────────────────────────────────────────────────────────

function setSearchParams(params: Record<string, string>) {
  // URLSearchParams is mutable — clear & repopulate
  Array.from(mockSearchParams.keys()).forEach((k) => mockSearchParams.delete(k));
  Object.entries(params).forEach(([k, v]) => mockSearchParams.set(k, v));
}

/** Put the tokens where the API actually delivers them — the URL fragment. */
function setHash(params: Record<string, string>) {
  const q = new URLSearchParams(params).toString();
  window.location.hash = q ? `#${q}` : '';
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AuthCallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tokenStoreState.accessToken = null;
    tokenStoreState.refreshToken = null;
    mockRefreshProfile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    setSearchParams({});
    window.location.hash = '';
    searchParamsValue = mockSearchParams;
  });

  it('stores tokens, refreshes auth state, then navigates to /dashboard', async () => {
    setSearchParams({
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
    });

    render(<AuthCallbackPage />);

    await waitFor(() => {
      expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
    });

    // Tokens should be stored BEFORE refreshProfile is called
    expect(tokenStoreState.accessToken).toBe('access-abc');
    expect(tokenStoreState.refreshToken).toBe('refresh-xyz');

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/dashboard');
    });
  });

  /**
   * The API returns the tokens in the fragment rather than the query string: a
   * fragment is never put on the wire, so the seven-day refresh token stays out
   * of the reverse proxy's access log and out of the `Referer` header this page
   * sends on its next request. If this page ever stops reading the fragment,
   * sign-in silently breaks; if it stops clearing it, the credentials sit in
   * the tab's history entry for anyone with the machine.
   */
  it('reads the tokens from the URL fragment', async () => {
    setHash({ accessToken: 'access-frag', refreshToken: 'refresh-frag', expiresIn: '900' });

    render(<AuthCallbackPage />);

    await waitFor(() => {
      expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
    });
    expect(tokenStoreState.accessToken).toBe('access-frag');
    expect(tokenStoreState.refreshToken).toBe('refresh-frag');
  });

  it('clears the fragment from the address bar once the tokens are stored', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    setHash({ accessToken: 'access-frag', refreshToken: 'refresh-frag' });

    render(<AuthCallbackPage />);

    await waitFor(() => {
      // Rewritten to the bare path — jsdom serves this page from "/".
      expect(replaceState).toHaveBeenCalledWith(null, '', window.location.pathname);
    });
    const [, , url] = replaceState.mock.calls[0]!;
    expect(String(url)).not.toContain('refresh-frag');
    replaceState.mockRestore();
  });

  it('prefers the fragment over a query string carrying different tokens', async () => {
    // Belt and braces: if a stale link still carries query tokens, the freshly
    // issued fragment pair is the one that wins.
    setSearchParams({ accessToken: 'access-query', refreshToken: 'refresh-query' });
    setHash({ accessToken: 'access-frag', refreshToken: 'refresh-frag' });

    render(<AuthCallbackPage />);

    await waitFor(() => {
      expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
    });
    expect(tokenStoreState.accessToken).toBe('access-frag');
    expect(tokenStoreState.refreshToken).toBe('refresh-frag');
  });

  it('still accepts the query form, so a dashboard ahead of the API keeps working', async () => {
    setSearchParams({ accessToken: 'access-query', refreshToken: 'refresh-query' });

    render(<AuthCallbackPage />);

    await waitFor(() => {
      expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
    });
    expect(tokenStoreState.accessToken).toBe('access-query');
    // Nothing to scrub from the address bar — there was no fragment.
    expect(window.location.hash).toBe('');
  });

  it('redirects to /login with error when tokens are missing', async () => {
    setSearchParams({}); // no tokens

    render(<AuthCallbackPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login?error=google_auth_failed');
    });

    expect(mockRefreshProfile).not.toHaveBeenCalled();
    expect(tokenStoreState.accessToken).toBeNull();
    expect(tokenStoreState.refreshToken).toBeNull();
  });

  it('redirects to /login when only accessToken is present', async () => {
    setSearchParams({ accessToken: 'access-abc' }); // missing refreshToken

    render(<AuthCallbackPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login?error=google_auth_failed');
    });
  });

  /**
   * `useRouter()` hands back a fresh object every render, so `router` in the
   * effect's dependency list changes identity on every re-render and the effect
   * re-runs. The `processed` ref is the only thing stopping a second pass — and
   * a second pass would re-store the tokens after the fragment has already been
   * scrubbed (so from a now-empty URL), and fire a second refreshProfile.
   */
  it('processes the callback once, however many times the effect re-runs', async () => {
    setHash({ accessToken: 'access-frag', refreshToken: 'refresh-frag' });

    const { rerender } = render(<AuthCallbackPage />);
    await waitFor(() => expect(mockRefreshProfile).toHaveBeenCalledTimes(1));

    rerender(<AuthCallbackPage />);
    rerender(<AuthCallbackPage />);

    expect(mockRefreshProfile).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('reads the fragment even when useSearchParams is null', async () => {
    // Next types the hook nullable and returns null on a statically rendered
    // pass. Reading `.get` off it unguarded would throw here — before the
    // fragment, which carries the real tokens, is ever looked at.
    searchParamsValue = null;
    setHash({ accessToken: 'access-frag', refreshToken: 'refresh-frag' });

    render(<AuthCallbackPage />);

    await waitFor(() => expect(mockRefreshProfile).toHaveBeenCalledTimes(1));
    expect(tokenStoreState.accessToken).toBe('access-frag');
    expect(tokenStoreState.refreshToken).toBe('refresh-frag');
  });

  it('fails the sign-in cleanly when searchParams is null and there is no fragment', async () => {
    searchParamsValue = null;

    render(<AuthCallbackPage />);

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith('/login?error=google_auth_failed'),
    );
    expect(tokenStoreState.accessToken).toBeNull();
  });

  it('falls back to window.location.replace when refreshProfile fails', async () => {
    const originalReplace = window.location.replace;
    const locationReplaceMock = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, replace: locationReplaceMock },
      writable: true,
    });

    mockRefreshProfile.mockRejectedValue(new Error('network error'));

    setSearchParams({
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
    });

    render(<AuthCallbackPage />);

    await waitFor(() => {
      expect(locationReplaceMock).toHaveBeenCalledWith('/dashboard');
    });

    // Should NOT have used router.replace (that's the SPA navigation)
    expect(mockReplace).not.toHaveBeenCalled();

    // Restore
    Object.defineProperty(window, 'location', {
      value: { ...window.location, replace: originalReplace },
      writable: true,
    });
  });
});
