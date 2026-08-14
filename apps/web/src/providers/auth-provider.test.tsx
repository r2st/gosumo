/**
 * AuthProvider — the dashboard's session lifecycle.
 *
 * Every screen behind the login wall depends on this component reaching the
 * right terminal state, and the failure modes are asymmetric: getting
 * "authenticated" wrong shows a broken shell, but getting "unauthenticated"
 * wrong strands a signed-in user on the login page or, worse, leaves stale
 * tokens behind after a logout.
 *
 * The cases pinned here are the ones with no visible UI of their own: the
 * silent bootstrap on mount (which must not even try when there is no refresh
 * token), the 2FA branch of login (which must NOT store tokens or mark the
 * session authenticated), and the forced logout the API client triggers when a
 * refresh finally fails.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth, useOptionalAuth } from './auth-provider';
import { tokenStore } from '@/lib/token-store';
import { api, setOnAuthFailure } from '@/lib/api-client';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>('@/lib/api-client');
  return {
    ...actual,
    setOnAuthFailure: vi.fn(),
    api: {
      auth: {
        me: vi.fn(),
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      },
      business: { me: vi.fn() },
    },
  };
});

const mockApi = vi.mocked(api, true);
const mockSetOnAuthFailure = vi.mocked(setOnAuthFailure);

const USER = { id: 'u1', name: 'Asha', email: 'asha@example.com', role: 'OWNER' };
const BUSINESS = { id: 'b1', name: 'Rao Textiles' };
const TOKENS = { accessToken: 'access-1', refreshToken: 'refresh-1' };

function installLocalStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

/** Renders the session state and exposes the actions as buttons. */
function Probe() {
  const { status, user, business, login, register, logout } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.name ?? 'none'}</span>
      <span data-testid="business">{business?.name ?? 'none'}</span>
      <button onClick={() => void login('asha@example.com', 'pw')}>login</button>
      <button
        onClick={() =>
          void register({
            businessName: 'Rao Textiles',
            name: 'Asha',
            email: 'asha@example.com',
            password: 'pw',
          })
        }
      >
        register
      </button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

/** Click a probe button inside act(), awaiting the async handler. */
async function click(name: string) {
  await act(async () => {
    screen.getByText(name).click();
  });
}

beforeEach(() => {
  installLocalStorage();
  vi.clearAllMocks();
  tokenStore.clear();
  mockApi.auth.me.mockResolvedValue(USER as never);
  mockApi.business.me.mockResolvedValue(BUSINESS as never);
  mockApi.auth.logout.mockResolvedValue(undefined as never);
});

afterEach(() => {
  tokenStore.clear();
});

describe('bootstrap on mount', () => {
  it('settles as unauthenticated without calling the API when there is no refresh token', async () => {
    renderProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    // No stored session means there is nothing to bootstrap from — hitting the
    // API here would 401 on every cold load.
    expect(mockApi.auth.me).not.toHaveBeenCalled();
  });

  it('loads the session when a refresh token is present', async () => {
    tokenStore.setRefreshToken('refresh-1');

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('Asha');
    expect(screen.getByTestId('business')).toHaveTextContent('Rao Textiles');
  });

  it('falls back to unauthenticated when the session lookup fails', async () => {
    tokenStore.setRefreshToken('refresh-1');
    mockApi.auth.me.mockRejectedValue(new Error('401'));

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  it('still authenticates when only the business profile fails to load', async () => {
    // The business call is best-effort; losing it must not sign the user out.
    tokenStore.setRefreshToken('refresh-1');
    mockApi.business.me.mockRejectedValue(new Error('500'));

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('user')).toHaveTextContent('Asha');
    expect(screen.getByTestId('business')).toHaveTextContent('none');
  });
});

describe('login', () => {
  it('stores both tokens and authenticates on a complete login', async () => {
    mockApi.auth.login.mockResolvedValue({
      requiresTwoFactor: false,
      user: USER,
      tokens: TOKENS,
    } as never);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await click('login');

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(tokenStore.getAccessToken()).toBe('access-1');
    expect(tokenStore.getRefreshToken()).toBe('refresh-1');
  });

  it('stores nothing and stays unauthenticated when 2FA is required', async () => {
    // The tokens are not issued until the TOTP step completes; treating this
    // as a login would hand the shell a half-authenticated session.
    mockApi.auth.login.mockResolvedValue({ requiresTwoFactor: true } as never);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await click('login');

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    expect(tokenStore.getAccessToken()).toBeNull();
    expect(tokenStore.getRefreshToken()).toBeNull();
    expect(mockApi.business.me).not.toHaveBeenCalled();
  });

  it('authenticates even when the business profile is unavailable', async () => {
    mockApi.auth.login.mockResolvedValue({
      requiresTwoFactor: false,
      user: USER,
      tokens: TOKENS,
    } as never);
    mockApi.business.me.mockRejectedValue(new Error('500'));

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await click('login');

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('business')).toHaveTextContent('none');
  });
});

describe('register', () => {
  it('authenticates through the same path as login', async () => {
    mockApi.auth.register.mockResolvedValue({
      requiresTwoFactor: false,
      user: USER,
      tokens: TOKENS,
    } as never);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await click('register');

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(tokenStore.getAccessToken()).toBe('access-1');
  });

  it('honours a 2FA requirement on registration too', async () => {
    mockApi.auth.register.mockResolvedValue({ requiresTwoFactor: true } as never);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await click('register');

    expect(tokenStore.getAccessToken()).toBeNull();
  });
});

describe('logout', () => {
  it('revokes the refresh token server-side, clears both, and returns to login', async () => {
    tokenStore.setRefreshToken('refresh-1');

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await click('logout');

    expect(mockApi.auth.logout).toHaveBeenCalledWith('refresh-1');
    expect(tokenStore.getAccessToken()).toBeNull();
    expect(tokenStore.getRefreshToken()).toBeNull();
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('clears the local session even when the revoke call fails', async () => {
    // A server that cannot be reached must not leave the user apparently
    // signed in on this device.
    tokenStore.setRefreshToken('refresh-1');
    mockApi.auth.logout.mockRejectedValue(new Error('network'));

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await click('logout');

    expect(tokenStore.getRefreshToken()).toBeNull();
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('skips the revoke call when there is no refresh token to revoke', async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));

    await click('logout');

    expect(mockApi.auth.logout).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('/login');
  });
});

describe('forced logout from the API client', () => {
  it('registers a handler that clears the session and redirects', async () => {
    tokenStore.setRefreshToken('refresh-1');

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    // The provider hands this callback to the API client, which invokes it when
    // a refresh can no longer be completed.
    const handler = mockSetOnAuthFailure.mock.calls.at(-1)?.[0];
    expect(handler).toBeTypeOf('function');

    await act(async () => {
      handler?.();
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(tokenStore.getRefreshToken()).toBeNull();
    expect(replace).toHaveBeenCalledWith('/login');
  });
});

describe('useAuth outside a provider', () => {
  it('throws, so a component depending on the session fails loudly', () => {
    function Orphan() {
      useAuth();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow(/must be used within an AuthProvider/);
  });

  it('useOptionalAuth returns null instead, so role-gated controls stay renderable', () => {
    function Orphan() {
      const ctx = useOptionalAuth();
      return <span data-testid="ctx">{ctx === null ? 'null' : 'present'}</span>;
    }

    render(<Orphan />);

    expect(screen.getByTestId('ctx')).toHaveTextContent('null');
  });
});
