import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => ({ get: vi.fn() }),
}));

vi.mock('@/components/google-button', () => ({
  GoogleButton: ({ label }: { label?: string }) => <button>{label ?? 'Sign in with Google'}</button>,
}));

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    login: vi.fn().mockResolvedValue(true),
    register: vi.fn().mockResolvedValue(true),
  }),
}));

describe('Landing page SEO sections', () => {
  it('renders testimonials section', async () => {
    const { LandingPage } = await import('@/app/landing-page');
    render(<LandingPage />);

    expect(screen.getByText('Trusted by businesses across India')).toBeInTheDocument();
    expect(screen.getByText('Meera Joshi')).toBeInTheDocument();
    expect(screen.getByText('Arjun Reddy')).toBeInTheDocument();
    expect(screen.getByText('Kavitha Nair')).toBeInTheDocument();
    expect(screen.getByText('Rohit Sharma')).toBeInTheDocument();
  });

  it('renders FAQ section', async () => {
    const { LandingPage } = await import('@/app/landing-page');
    render(<LandingPage />);

    expect(screen.getByText('Frequently asked questions')).toBeInTheDocument();
    expect(screen.getByText('What is DoAide Desk?')).toBeInTheDocument();
    expect(screen.getByText('Which messaging channels are supported?')).toBeInTheDocument();
    expect(screen.getByText('How does the AI help with responses?')).toBeInTheDocument();
  });

  it('expands FAQ answer on click', async () => {
    const { LandingPage } = await import('@/app/landing-page');
    render(<LandingPage />);

    const question = screen.getByText('What is DoAide Desk?');
    fireEvent.click(question);
    expect(screen.getByText(/AI-powered client management platform/)).toBeInTheDocument();
  });

  it('renders JSON-LD FAQPage schema', async () => {
    const { LandingPage } = await import('@/app/landing-page');
    const { container } = render(<LandingPage />);

    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    const faqScript = Array.from(scripts).find((s) => s.textContent?.includes('FAQPage'));
    expect(faqScript).toBeTruthy();
    const json = JSON.parse(faqScript!.textContent!);
    expect(json['@type']).toBe('FAQPage');
    expect(json.mainEntity.length).toBe(8);
  });

  it('renders CTA section', async () => {
    const { LandingPage } = await import('@/app/landing-page');
    render(<LandingPage />);

    expect(screen.getByText('Stop losing clients to missed messages')).toBeInTheDocument();
    expect(screen.getByText('Start Free — No Credit Card Required')).toBeInTheDocument();
  });
});
