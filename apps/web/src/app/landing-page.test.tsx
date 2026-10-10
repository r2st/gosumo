/**
 * Split-layout landing page at `/` with embedded auth form (409A design).
 *
 * Tests verify structural integrity: the auth tabs switch correctly,
 * form fields are present, branding and pipeline are visible.
 */
import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: '--font-sans' }),
  Noto_Sans_Devanagari: () => ({ variable: '--font-devanagari' }),
}));

vi.mock('@/providers/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="theme-provider">{children}</div>
  ),
  themeInitScript: 'window.__theme=1',
}));
vi.mock('@/providers/language-provider', () => ({
  LanguageProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="language-provider">{children}</div>
  ),
  langInitScript: 'window.__lang=1',
}));
vi.mock('@/providers/query-provider', () => ({
  QueryProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="query-provider">{children}</div>
  ),
}));
vi.mock('@/providers/toast-provider', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="toast-provider">{children}</div>
  ),
}));
vi.mock('@/providers/auth-provider', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-provider">{children}</div>
  ),
  useAuth: () => ({
    login: vi.fn(),
    register: vi.fn(),
    status: 'unauthenticated' as const,
  }),
}));

vi.mock('@/components/google-button', () => ({
  GoogleButton: ({ label }: { label?: string }) => (
    <button type="button">{label ?? 'Continue with Google'}</button>
  ),
}));

import { LandingPage } from './landing-page';
import Home, { metadata as homeMetadata } from './page';
import RootLayout, { metadata as rootMetadata, viewport } from './layout';

describe('landing page — auth form', () => {
  it('defaults to the Sign in tab with login fields', () => {
    render(<LandingPage />);

    const signinTab = screen.getAllByRole('tab', { name: 'Sign in' });
    expect(signinTab.length).toBeGreaterThan(0);
    expect(signinTab[0]).toHaveAttribute('aria-selected', 'true');

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('switches to the Create account tab with registration fields', () => {
    render(<LandingPage />);

    const registerTab = screen.getAllByRole('tab', { name: 'Create account' });
    fireEvent.click(registerTab[0]);

    expect(registerTab[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Business name')).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
  });

  it('shows the forgot password link only in sign-in mode', () => {
    render(<LandingPage />);

    expect(screen.getByText('Forgot?')).toBeInTheDocument();
    expect(screen.getByText('Forgot?').closest('a')).toHaveAttribute('href', '/forgot-password');

    fireEvent.click(screen.getAllByRole('tab', { name: 'Create account' })[0]);
    expect(screen.queryByText('Forgot?')).not.toBeInTheDocument();
  });

  it('shows the Google auth button in both tabs', () => {
    render(<LandingPage />);
    expect(screen.getByText('Continue with Google')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('tab', { name: 'Create account' })[0]);
    expect(screen.getByText('Sign up with Google')).toBeInTheDocument();
  });
});

describe('landing page — pipeline graphic', () => {
  it('lists the four pipeline stages', () => {
    render(<LandingPage />);

    for (const label of ['Receive', 'Route', 'Respond', 'Resolve']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});

describe('landing page — branding', () => {
  it('shows the headline', () => {
    render(<LandingPage />);
    expect(screen.getByText('Client conversations, unified.')).toBeInTheDocument();
  });

  it('shows the subtitle', () => {
    render(<LandingPage />);
    expect(
      screen.getByText(/AI-powered client management across WhatsApp/),
    ).toBeInTheDocument();
  });

  it('dates the footer to the current year and credits GoSumo', () => {
    render(<LandingPage />);
    expect(
      screen.getByText(new RegExp(`© ${new Date().getFullYear()} GoSumo`)),
    ).toBeInTheDocument();
  });
});

describe('landing page — metadata', () => {
  it('describes the product in its page metadata', () => {
    expect(homeMetadata.title).toBe('GoSumo Realty — AI-powered lead management for real estate brokers');
    expect(String(homeMetadata.description)).toContain('AI-driven interface');
  });
});

describe('RootLayout', () => {
  it('nests the providers so React Query is available to the auth provider', () => {
    render(
      <RootLayout>
        <p>page body</p>
      </RootLayout>,
    );

    const theme = screen.getByTestId('theme-provider');
    const query = within(theme).getByTestId('query-provider');
    const auth = within(query).getByTestId('auth-provider');
    expect(within(auth).getByText('page body')).toBeInTheDocument();
  });

  it('inlines the theme and language bootstrap scripts before paint', () => {
    const { container } = render(
      <RootLayout>
        <p>page body</p>
      </RootLayout>,
    );

    const scripts = Array.from(container.querySelectorAll('script')).map((s) => s.innerHTML);
    expect(scripts).toContain('window.__theme=1');
    expect(scripts).toContain('window.__lang=1');
  });

  it('declares the PWA metadata the installable app depends on', () => {
    expect(rootMetadata.manifest).toBe('/manifest.json');
    expect(rootMetadata.applicationName).toBe('GoSumo Realty');
    expect(rootMetadata.appleWebApp).toMatchObject({ capable: true, title: 'GoSumo Realty' });
    expect(viewport.themeColor).toEqual([
      { media: '(prefers-color-scheme: dark)', color: '#0A0A0B' },
      { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    ]);
  });

  it('templates child page titles under the product name', () => {
    expect(rootMetadata.title).toMatchObject({
      default: 'GoSumo Realty',
      template: '%s · GoSumo Realty',
    });
  });
});
