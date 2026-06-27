import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// ── Mocks ────────────────────────────────────────────────────────────────────

// next/navigation
const mockReplace = vi.fn();
const mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
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
