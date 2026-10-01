import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Logo, LogoMark } from './logo';

describe('LogoMark', () => {
  it('is exposed to assistive tech as a named image', () => {
    // The mark is the only branding in the collapsed sidebar, so it has to
    // announce itself rather than being an unlabelled decorative <svg>.
    render(<LogoMark />);
    expect(screen.getByRole('img', { name: 'DoAide Desk' })).toBeInTheDocument();
  });

  it('defaults to a 32px square', () => {
    render(<LogoMark />);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('class')).toContain('h-8');
    expect(svg.getAttribute('class')).toContain('w-8');
  });

  it('accepts a size override', () => {
    render(<LogoMark className="h-12 w-12" />);
    expect(screen.getByRole('img').getAttribute('class')).toContain('h-12');
  });

  it('keeps a square viewBox so the mark never distorts', () => {
    render(<LogoMark />);
    expect(screen.getByRole('img')).toHaveAttribute('viewBox', '0 0 32 32');
  });
});

describe('Logo', () => {
  it('shows the wordmark alongside the mark by default', () => {
    render(<Logo />);
    expect(screen.getByRole('img', { name: 'DoAide Desk' })).toBeInTheDocument();
    expect(screen.getByText('DoAide')).toBeInTheDocument();
  });

  it('hides the wordmark on request, for narrow rails', () => {
    render(<Logo showWordmark={false} />);
    expect(screen.getByRole('img', { name: 'DoAide Desk' })).toBeInTheDocument();
    expect(screen.queryByText('DoAide')).not.toBeInTheDocument();
  });

  it('merges a caller className onto the wrapper', () => {
    const { container } = render(<Logo className="justify-center" />);
    expect(container.firstElementChild?.className).toContain('justify-center');
    expect(container.firstElementChild?.className).toContain('flex');
  });
});
