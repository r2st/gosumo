import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock Next.js modules
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// --- ShareButtons ---
import { ShareButtons } from '@/components/share-buttons';

describe('ShareButtons', () => {
  it('renders WhatsApp, X/Twitter, and copy link buttons', () => {
    render(<ShareButtons url="https://example.com" title="Test" />);
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('X / Twitter')).toBeInTheDocument();
    expect(screen.getByText('Copy link')).toBeInTheDocument();
  });

  it('WhatsApp link has correct href', () => {
    render(<ShareButtons url="https://example.com" title="My Tool" />);
    const link = screen.getByText('WhatsApp').closest('a');
    expect(link?.href).toContain('wa.me');
    expect(link?.href).toContain('My%20Tool');
  });

  it('X/Twitter link has correct href', () => {
    render(<ShareButtons url="https://example.com" title="My Tool" />);
    const link = screen.getByText('X / Twitter').closest('a');
    expect(link?.href).toContain('twitter.com/intent/tweet');
  });

  it('copies link to clipboard on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ShareButtons url="https://example.com" title="Test" />);
    fireEvent.click(screen.getByText('Copy link'));
    expect(writeText).toHaveBeenCalledWith('https://example.com');
    await waitFor(() => expect(screen.getByText('Copied!')).toBeInTheDocument());
  });
});

// --- PublicLayout ---
import { PublicNav, PublicFooter } from '@/components/public-layout';

describe('PublicNav', () => {
  it('renders navigation links', () => {
    render(<PublicNav />);
    expect(screen.getByText('Free Tools')).toBeInTheDocument();
    expect(screen.getByText('Blog')).toBeInTheDocument();
    expect(screen.getByText('Embed')).toBeInTheDocument();
    expect(screen.getByText('Get Started')).toBeInTheDocument();
  });

  it('links point to correct paths', () => {
    render(<PublicNav />);
    expect(screen.getByText('Free Tools').closest('a')?.getAttribute('href')).toBe('/tools');
    expect(screen.getByText('Blog').closest('a')?.getAttribute('href')).toBe('/blog');
  });
});

describe('PublicFooter', () => {
  it('renders copyright and links', () => {
    render(<PublicFooter />);
    expect(screen.getByText(/Apprend Technologies/)).toBeInTheDocument();
  });
});

// --- ResponseTimeCalculator ---
import { ResponseTimeCalculator } from '@/app/tools/response-time-calculator/calculator';

describe('ResponseTimeCalculator', () => {
  it('renders with default entries and stats', () => {
    render(<ResponseTimeCalculator />);
    expect(screen.getByText('Response Time Calculator')).toBeInTheDocument();
    expect(screen.getByText('Average Response')).toBeInTheDocument();
    expect(screen.getByText('SLA Compliance')).toBeInTheDocument();
  });

  it('calculates correct average from defaults', () => {
    render(<ResponseTimeCalculator />);
    // defaults: 5, 12, 3 => avg = 6.7
    expect(screen.getByText('6.7 min')).toBeInTheDocument();
  });

  it('adds a new entry', () => {
    render(<ResponseTimeCalculator />);
    const input = screen.getByPlaceholderText('Add response time');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.click(screen.getByText('Add'));
    expect(screen.getByText('10m')).toBeInTheDocument();
  });

  it('removes an entry', () => {
    render(<ResponseTimeCalculator />);
    const removeButtons = screen.getAllByText('×');
    fireEvent.click(removeButtons[0]);
    expect(screen.queryByText('5m')).not.toBeInTheDocument();
  });
});

// --- TicketVolumeForecaster ---
import { TicketVolumeForecaster } from '@/app/tools/ticket-volume-forecaster/forecaster';

describe('TicketVolumeForecaster', () => {
  it('renders with default data and forecasts', () => {
    render(<TicketVolumeForecaster />);
    expect(screen.getByText('Ticket Volume Forecaster')).toBeInTheDocument();
    expect(screen.getByText('Weekly Average')).toBeInTheDocument();
    expect(screen.getByText('Next Week Forecast')).toBeInTheDocument();
  });

  it('adds a new week entry', () => {
    render(<TicketVolumeForecaster />);
    const input = screen.getByPlaceholderText('Ticket count');
    fireEvent.change(input, { target: { value: '200' } });
    fireEvent.click(screen.getByText('Add Week'));
    expect(screen.getByText('Week 5')).toBeInTheDocument();
  });
});

// --- CsatCalculator ---
import { CsatCalculator } from '@/app/tools/csat-calculator/calculator';

describe('CsatCalculator', () => {
  it('renders with default survey responses', () => {
    render(<CsatCalculator />);
    expect(screen.getByText('CSAT Calculator')).toBeInTheDocument();
    expect(screen.getByText('CSAT Score')).toBeInTheDocument();
    expect(screen.getByText('Total Responses')).toBeInTheDocument();
  });

  it('calculates correct CSAT from defaults', () => {
    render(<CsatCalculator />);
    // defaults: [2, 5, 15, 45, 33] → total=100, satisfied=78, CSAT=78.0%
    expect(screen.getByText('78.0%')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('updates when survey counts change', () => {
    render(<CsatCalculator />);
    const inputs = screen.getAllByRole('spinbutton');
    // Change "Very Satisfied" to 50
    fireEvent.change(inputs[4], { target: { value: '50' } });
    // New total: 2+5+15+45+50=117, satisfied=95, CSAT=81.2%
    expect(screen.getByText('117')).toBeInTheDocument();
  });
});

// --- EmbedGenerator ---
import { EmbedGenerator } from '@/app/embed/generator';

describe('EmbedGenerator', () => {
  it('renders the embed generator form', () => {
    render(<EmbedGenerator />);
    expect(screen.getByText('Embed Widget Generator')).toBeInTheDocument();
    expect(screen.getByText('Embed Code')).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('generates correct snippet with default values', () => {
    render(<EmbedGenerator />);
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toContain('data-position="bottom-right"');
    expect(pre?.textContent).toContain('data-theme="dark"');
  });

  it('updates position in snippet', () => {
    render(<EmbedGenerator />);
    fireEvent.click(screen.getByText('bottom left'));
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toContain('data-position="bottom-left"');
  });

  it('copies embed code to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<EmbedGenerator />);
    fireEvent.click(screen.getByText('Copy Code'));
    expect(writeText).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Copied!')).toBeInTheDocument());
  });
});

// --- Sitemap ---
import sitemap from '@/app/sitemap';

describe('sitemap', () => {
  it('returns all expected URLs', () => {
    const entries = sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain('https://gosumo.aiknol.com');
    expect(urls).toContain('https://gosumo.aiknol.com/tools');
    expect(urls).toContain('https://gosumo.aiknol.com/tools/response-time-calculator');
    expect(urls).toContain('https://gosumo.aiknol.com/blog');
    expect(urls).toContain('https://gosumo.aiknol.com/embed');
    expect(entries.length).toBeGreaterThanOrEqual(10);
  });
});

// --- Robots ---
import robots from '@/app/robots';

describe('robots', () => {
  it('returns valid robots config', () => {
    const config = robots();
    expect(config.sitemap).toBe('https://gosumo.aiknol.com/sitemap.xml');
    expect(config.rules).toBeDefined();
  });
});
