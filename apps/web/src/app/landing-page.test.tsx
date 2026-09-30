/**
 * The marketing page at `/` and the root layout that wraps every route.
 *
 * The landing page is static markup, so the assertions worth writing are the
 * ones a copy edit or a careless refactor would break in a way that costs
 * money: every call to action has to reach `/register` (a dead CTA on the
 * pricing card is invisible in review), exactly one plan may carry the
 * "Most popular" ribbon, and the anchor nav has to point at sections that
 * actually exist on the page. The layout test pins the provider nesting —
 * React Query must sit inside the theme/language providers and outside the
 * auth provider, because the auth provider issues queries on mount.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// next/font/google reaches out to Google's CDN at module load, which is neither
// available nor meaningful here; the layout only uses the returned CSS variable.
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
}));

import Home, { metadata as homeMetadata } from './page';
import RootLayout, { metadata as rootMetadata, viewport } from './layout';

describe('landing page structure', () => {
  it('lists all five jobs the product claims to do', () => {
    render(<Home />);

    const section = document.getElementById('features')!;
    for (const job of ['Speed', 'Qualification', 'Site visits', 'Follow-up', 'Memory']) {
      expect(within(section).getByRole('heading', { name: job })).toBeInTheDocument();
    }
  });

  it('walks the three steps in order', () => {
    render(<Home />);

    const section = document.getElementById('how')!;
    const steps = within(section).getAllByRole('heading', { level: 3 });
    expect(steps.map((h) => h.textContent)).toEqual([
      'Capture leads from any source',
      'AI qualifies and matches inventory',
      'Broker closes deals',
    ]);
  });

  it('prices three plans and highlights exactly one', () => {
    render(<Home />);

    const section = document.getElementById('pricing')!;
    expect(within(section).getByRole('heading', { name: 'Solo' })).toBeInTheDocument();
    expect(within(section).getByText('₹9,999')).toBeInTheDocument();
    expect(within(section).getByRole('heading', { name: 'Developer' })).toBeInTheDocument();

    // Two ribbons would make the pricing table read as a mistake.
    expect(within(section).getAllByText('Most popular')).toHaveLength(1);
  });

  it('sends every call to action to the signup route', () => {
    render(<Home />);

    const ctas = screen.getAllByRole('link', { name: /Start free trial/ });
    // Header, hero, three pricing cards, the banner and the footer.
    expect(ctas).toHaveLength(7);
    for (const cta of ctas) expect(cta).toHaveAttribute('href', '/register');
  });

  it('offers sign-in for an existing customer', () => {
    render(<Home />);

    const signIn = screen.getAllByRole('link', { name: 'Sign in' });
    expect(signIn.length).toBeGreaterThan(0);
    for (const link of signIn) expect(link).toHaveAttribute('href', '/login');
  });

  it('anchors the nav at sections that exist on the page', () => {
    render(<Home />);

    const anchors = screen
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'))
      .filter((href): href is string => Boolean(href?.startsWith('#')));

    expect(new Set(anchors)).toEqual(new Set(['#features', '#how', '#pricing']));
    for (const anchor of new Set(anchors)) {
      expect(document.getElementById(anchor.slice(1))).not.toBeNull();
    }
  });

  it('dates the footer to the current year and credits DoAide', () => {
    render(<Home />);

    expect(
      screen.getByText(new RegExp(`© ${new Date().getFullYear()} GoSumo`)),
    ).toBeInTheDocument();
    const footer = screen.getByText(new RegExp(`© ${new Date().getFullYear()} GoSumo`)).closest('p')!;
    expect(footer.textContent).toContain('DoAide');
  });

  it('describes the product as realty-first in its page metadata', () => {
    expect(homeMetadata.title).toBe('GoSumo Realty — AI lead manager for real estate');
    expect(String(homeMetadata.description)).toContain('Budget-Location-Timeline-Configuration');
  });
});

describe('RootLayout', () => {
  it('nests the providers so React Query is available to the auth provider', () => {
    render(
      <RootLayout>
        <p>page body</p>
      </RootLayout>,
    );

    // AuthProvider fires `api.auth.me()` on mount, so it must be inside the
    // query provider; the theme and language providers wrap everything so the
    // pre-paint scripts and the rendered tree agree.
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
    expect(rootMetadata.applicationName).toBe('GoSumo');
    expect(rootMetadata.appleWebApp).toMatchObject({ capable: true, title: 'GoSumo' });
    expect(viewport.themeColor).toBe('#4F46E5');
  });

  it('templates child page titles under the product name', () => {
    expect(rootMetadata.title).toMatchObject({
      default: 'GoSumo — AI Client Management',
      template: '%s · GoSumo',
    });
  });
});
