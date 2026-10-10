import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [k: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@/components/public-layout', () => ({
  PublicNav: () => <nav data-testid="public-nav" />,
  PublicFooter: () => <footer data-testid="public-footer" />,
}));

describe('Blog Index SEO articles', () => {
  it('renders new SEO blog posts', async () => {
    const { default: BlogIndex } = await import('@/app/blog/page');
    render(<BlogIndex />);

    expect(screen.getByText('Best CRM for Freelancers in India: What Actually Works in 2026')).toBeInTheDocument();
    expect(screen.getByText('AI Client Management: How Small Businesses Are Winning with Automation')).toBeInTheDocument();
    expect(screen.getByText('7 Client Retention Strategies That Actually Work for Service Businesses')).toBeInTheDocument();
  });

  it('still renders existing blog posts', async () => {
    const { default: BlogIndex } = await import('@/app/blog/page');
    render(<BlogIndex />);

    expect(screen.getByText('How AI Transforms Customer Support Response Times')).toBeInTheDocument();
    expect(screen.getByText('5 Metrics Every Support Team Should Track')).toBeInTheDocument();
    expect(screen.getByText('The Complete Guide to Automated Ticket Routing')).toBeInTheDocument();
  });

  it('renders new round 2 SEO blog posts', async () => {
    const { default: BlogIndex } = await import('@/app/blog/page');
    render(<BlogIndex />);

    expect(screen.getByText('Best Help Desk Software for Small Businesses in India: 2026 Guide')).toBeInTheDocument();
    expect(screen.getByText('How to Build a Knowledge Base for Your Indian Business: Step-by-Step')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp Customer Support for Indian Businesses: Complete Setup Guide')).toBeInTheDocument();
  });

  it('renders all 12 blog post links', async () => {
    const { default: BlogIndex } = await import('@/app/blog/page');
    const { container } = render(<BlogIndex />);
    const links = container.querySelectorAll('a[href^="/blog/"]');
    expect(links.length).toBe(12);
  });
});
