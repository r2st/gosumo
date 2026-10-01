/**
 * The redesigned marketing page at `/` with embedded auth form.
 *
 * The landing page combines the product showcase and auth form into one
 * split-layout view. Tests verify structural integrity: the auth form
 * functions, feature highlights are present, tabs switch correctly, and
 * the mobile-first layout has the right pieces.
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
  it('defaults to the Sign Up tab with all registration fields', () => {
    render(<LandingPage />);

    const signupTab = screen.getAllByRole('tab', { name: 'Sign Up' });
    expect(signupTab.length).toBeGreaterThan(0);
    expect(signupTab[0]).toHaveAttribute('aria-selected', 'true');

    expect(screen.getByLabelText('Business name')).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Account' })).toBeInTheDocument();
  });

  it('switches to the Log In tab with login fields', () => {
    render(<LandingPage />);

    const loginTab = screen.getAllByRole('tab', { name: 'Log In' });
    fireEvent.click(loginTab[0]);

    expect(loginTab[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Business name')).not.toBeInTheDocument();
  });

  it('shows the forgot password link only in login mode', () => {
    render(<LandingPage />);

    expect(screen.queryByText('Forgot?')).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('tab', { name: 'Log In' })[0]);
    const forgotLink = screen.getByText('Forgot?');
    expect(forgotLink).toHaveAttribute('href', '/forgot-password');
  });

  it('shows the Google auth button in both tabs', () => {
    render(<LandingPage />);
    expect(screen.getByText('Sign up with Google')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('tab', { name: 'Log In' })[0]);
    expect(screen.getByText('Continue with Google')).toBeInTheDocument();
  });
});

describe('landing page — feature highlights', () => {
  it('lists all four feature highlights', () => {
    render(<LandingPage />);

    for (const label of ['30s response', 'BLTC scoring', 'Auto site visits', '90-day nurture']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });
});

describe('landing page — branding', () => {
  it('shows DoAide Desk branding', () => {
    render(<LandingPage />);

    const doaideTexts = screen.getAllByText('DoAide');
    expect(doaideTexts.length).toBeGreaterThan(0);

    const deskTexts = screen.getAllByText('Desk');
    expect(deskTexts.length).toBeGreaterThan(0);
  });

  it('shows the tagline', () => {
    render(<LandingPage />);

    const taglines = screen.getAllByText('AI-powered client management across every channel');
    expect(taglines.length).toBeGreaterThan(0);
  });

  it('dates the footer to the current year and credits DoAide', () => {
    render(<LandingPage />);

    expect(
      screen.getByText(new RegExp(`© ${new Date().getFullYear()} DoAide Desk`)),
    ).toBeInTheDocument();
  });
});

describe('landing page — metadata', () => {
  it('describes the product as realty-first in its page metadata', () => {
    expect(homeMetadata.title).toBe('DoAide Desk — AI-powered client management across every channel');
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
    expect(rootMetadata.applicationName).toBe('DoAide Desk');
    expect(rootMetadata.appleWebApp).toMatchObject({ capable: true, title: 'DoAide Desk' });
    expect(viewport.themeColor).toBe('#0A0A0B');
  });

  it('templates child page titles under the product name', () => {
    expect(rootMetadata.title).toMatchObject({
      default: 'DoAide Desk',
      template: '%s · DoAide Desk',
    });
  });
});
