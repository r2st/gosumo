/**
 * The four unauthenticated screens plus the split-panel shell they render into.
 *
 * These pages are thin, but every one of them has a branch that decides where
 * the user ends up: login honours a `?next=` hand-off and has to distinguish
 * "wrong password" (an ApiError with a server message) from "2FA required"
 * (a *successful* call that returns false); register sends a partial user to
 * /login rather than /dashboard; reset-password refuses to render a form at all
 * without a token and compares the two password fields before it spends a
 * request. Those are the assertions worth having — a wrong branch here locks a
 * real user out of the product and no type error would catch it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => searchParams,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const login = vi.fn();
const register = vi.fn();
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ login, register }),
}));

const forgotPassword = vi.fn();
const resetPassword = vi.fn();
vi.mock('@/lib/api-client', async (importOriginal) => {
  // ApiError must stay the real class — every one of these pages narrows on
  // `err instanceof ApiError` to decide whether to surface the server's message
  // or a generic fallback, and a stubbed class would silently take the
  // fallback branch in every test.
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return {
    ...actual,
    api: {
      auth: {
        forgotPassword: (...args: unknown[]) => forgotPassword(...args),
        resetPassword: (...args: unknown[]) => resetPassword(...args),
        googleUrl: () => 'http://api.test/v1/auth/google',
      },
    },
  };
});

const tokens = { access: null as string | null, refresh: null as string | null };
vi.mock('@/lib/token-store', () => ({
  tokenStore: {
    setAccessToken: (t: string | null) => {
      tokens.access = t;
    },
    setRefreshToken: (t: string | null) => {
      tokens.refresh = t;
    },
    getAccessToken: () => tokens.access,
    getRefreshToken: () => tokens.refresh,
    clear: () => {
      tokens.access = null;
      tokens.refresh = null;
    },
  },
}));

import { ApiError } from '@/lib/api-client';
import AuthLayout from './layout';
import LoginPage from './login/page';
import RegisterPage from './register/page';
import ForgotPasswordPage from './forgot-password/page';
import ResetPasswordPage from './reset-password/page';

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
  tokens.access = null;
  tokens.refresh = null;
  login.mockResolvedValue(true);
  register.mockResolvedValue(true);
  forgotPassword.mockResolvedValue(undefined);
  resetPassword.mockResolvedValue({ accessToken: 'a1', refreshToken: 'r1' });
});

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/**
 * jsdom enforces constraint validation, so a click on a submit button never
 * reaches `onSubmit` while a `required` field is still empty. Every error-path
 * test therefore has to fill the form first — otherwise it would pass for the
 * wrong reason today and keep passing if the handler were deleted tomorrow.
 */
function fillCredentials() {
  type(/^Email$/, 'priya@sharma.in');
  type(/^Password$/, 'hunter2hunter2');
}

describe('AuthLayout', () => {
  it('frames the form with the brand panel, current year and DoAide attribution', () => {
    render(
      <AuthLayout>
        <p>form goes here</p>
      </AuthLayout>,
    );

    expect(screen.getByText('form goes here')).toBeInTheDocument();
    expect(
      screen.getByText(/AI-powered client management across every channel/),
    ).toBeInTheDocument();
    const footer = screen.getByText(new RegExp(`© ${new Date().getFullYear()}`));
    expect(footer).toBeInTheDocument();
    expect(footer.closest('p')!.textContent).toContain('DoAide');
  });
});

describe('LoginPage', () => {
  it('signs in and lands on the dashboard', async () => {
    render(<LoginPage />);

    type(/^Email$/, 'priya@sharma.in');
    type(/^Password$/, 'hunter2hunter2');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('priya@sharma.in', 'hunter2hunter2'));
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('returns the user to the page they were sent away from', async () => {
    searchParams = new URLSearchParams('next=/leads/lead-1');
    render(<LoginPage />);

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/leads/lead-1'));
  });

  it('explains that the account needs 2FA when login resolves false', async () => {
    login.mockResolvedValue(false);
    render(<LoginPage />);

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(
      await screen.findByText('Two-factor authentication is required for this account.'),
    ).toBeInTheDocument();
    // A 2FA hand-off is not a successful sign-in — it must not navigate.
    expect(replace).not.toHaveBeenCalled();
  });

  it("surfaces the server's message for a rejected credential", async () => {
    login.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is wrong.'));
    render(<LoginPage />);

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Email or password is wrong.')).toBeInTheDocument();
  });

  it('falls back to a generic message for a non-API failure', async () => {
    login.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<LoginPage />);

    fillCredentials();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Unable to sign in. Please try again.')).toBeInTheDocument();
  });

  it('sends the Google button to the backend OAuth entry point', () => {
    // jsdom refuses to navigate, so `window.location.href = ...` is a no-op
    // unless location is replaced with a plain writable object first.
    const original = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...original, href: original.href },
      writable: true,
      configurable: true,
    });

    render(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));

    expect(window.location.href).toBe('http://api.test/v1/auth/google');

    Object.defineProperty(window, 'location', {
      value: original,
      writable: true,
      configurable: true,
    });
  });
});

describe('RegisterPage', () => {
  function fillRegistration() {
    type(/Business name/, 'Sharma Realty');
    type(/Your name/, 'Priya Sharma');
    type(/^Email$/, 'priya@sharma.in');
    type(/^Password$/, 'hunter2hunter2');
  }

  it('creates the workspace and goes straight to the dashboard', async () => {
    render(<RegisterPage />);
    fillRegistration();
    type(/^Phone$/, '+91 98765 43210');

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith({
        businessName: 'Sharma Realty',
        name: 'Priya Sharma',
        email: 'priya@sharma.in',
        password: 'hunter2hunter2',
        phone: '+91 98765 43210',
      }),
    );
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('omits an empty phone rather than sending a blank string', async () => {
    render(<RegisterPage />);
    fillRegistration();

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ phone: undefined })),
    );
  });

  it('routes to /login when registration did not produce a session', async () => {
    register.mockResolvedValue(false);
    render(<RegisterPage />);
    fillRegistration();

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
  });

  it('shows the API message when the email is already taken', async () => {
    register.mockRejectedValue(
      new ApiError(409, 'EMAIL_TAKEN', 'That email already has a workspace.'),
    );
    render(<RegisterPage />);
    fillRegistration();

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('That email already has a workspace.')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('falls back to a generic message for a non-API failure', async () => {
    register.mockRejectedValue(new Error('offline'));
    render(<RegisterPage />);
    fillRegistration();

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByText('Unable to create your account. Please try again.'),
    ).toBeInTheDocument();
  });
});

describe('ForgotPasswordPage', () => {
  it('confirms without revealing whether the address exists', async () => {
    render(<ForgotPasswordPage />);

    type(/^Email$/, 'priya@sharma.in');
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    expect(forgotPassword).toHaveBeenCalledWith('priya@sharma.in');
    // The wording is deliberately conditional — it must not confirm the account.
    expect(screen.getByText(/If an account exists for/)).toBeInTheDocument();
    expect(screen.getByText('priya@sharma.in')).toBeInTheDocument();
  });

  it('keeps the form up and reports the API message on failure', async () => {
    forgotPassword.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many attempts.'));
    render(<ForgotPasswordPage />);

    type(/^Email$/, 'priya@sharma.in');
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByText('Too many attempts.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument();
  });

  it('falls back to a generic message for a non-API failure', async () => {
    forgotPassword.mockRejectedValue(new Error('offline'));
    render(<ForgotPasswordPage />);

    type(/^Email$/, 'priya@sharma.in');
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(
      await screen.findByText('Unable to send the reset link. Please try again.'),
    ).toBeInTheDocument();
  });
});

describe('ResetPasswordPage', () => {
  it('refuses to render a form when the link carries no token', () => {
    render(<ResetPasswordPage />);

    expect(screen.getByText('Invalid reset link')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset password' })).not.toBeInTheDocument();
  });

  it('stores the returned token pair and signs the user in', async () => {
    searchParams = new URLSearchParams('token=reset-token-abc');
    render(<ResetPasswordPage />);

    type(/New password/, 'newpassword123');
    type(/Confirm password/, 'newpassword123');
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() =>
      expect(resetPassword).toHaveBeenCalledWith('reset-token-abc', 'newpassword123'),
    );
    expect(tokens.access).toBe('a1');
    expect(tokens.refresh).toBe('r1');
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('catches a mismatched confirmation before spending a request', async () => {
    searchParams = new URLSearchParams('token=reset-token-abc');
    render(<ResetPasswordPage />);

    type(/New password/, 'newpassword123');
    type(/Confirm password/, 'newpassword124');
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('reports an expired link without storing anything', async () => {
    searchParams = new URLSearchParams('token=stale');
    resetPassword.mockRejectedValue(new ApiError(400, 'TOKEN_EXPIRED', 'This link has expired.'));
    render(<ResetPasswordPage />);

    type(/New password/, 'newpassword123');
    type(/Confirm password/, 'newpassword123');
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByText('This link has expired.')).toBeInTheDocument();
    expect(tokens.access).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('falls back to a generic message for a non-API failure', async () => {
    searchParams = new URLSearchParams('token=stale');
    resetPassword.mockRejectedValue(new Error('offline'));
    render(<ResetPasswordPage />);

    type(/New password/, 'newpassword123');
    type(/Confirm password/, 'newpassword123');
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(
      await screen.findByText('Unable to reset your password. The link may have expired.'),
    ).toBeInTheDocument();
  });
});
