import { render, screen } from '@testing-library/react';
import { Target } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { KpiCard } from './kpi-card';

describe('KpiCard', () => {
  it('renders the label and value', () => {
    render(<KpiCard label="Open leads" value="128" icon={Target} />);
    expect(screen.getByText('Open leads')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
  });

  it('renders an optional hint', () => {
    render(<KpiCard label="Open leads" value="128" icon={Target} hint="vs last week" />);
    expect(screen.getByText('vs last week')).toBeInTheDocument();
  });

  describe('loading', () => {
    it('replaces the value with a skeleton', () => {
      render(<KpiCard label="Open leads" value="128" icon={Target} loading />);
      expect(screen.queryByText('128')).not.toBeInTheDocument();
      expect(screen.getByText('Open leads')).toBeInTheDocument();
    });

    it('hides the hint and trend, which would be stale numbers', () => {
      // Showing last render's trend beside a loading value tells the operator
      // something that is no longer known to be true.
      render(
        <KpiCard label="Open leads" value="128" icon={Target} hint="vs last week" trend={5} loading />,
      );
      expect(screen.queryByText('vs last week')).not.toBeInTheDocument();
      expect(screen.queryByText('5.0%')).not.toBeInTheDocument();
    });
  });

  describe('trend', () => {
    it('shows a positive trend in green', () => {
      const { container } = render(<KpiCard label="Leads" value="128" icon={Target} trend={12.34} />);
      expect(screen.getByText('12.3%')).toBeInTheDocument();
      expect(container.querySelector('.text-emerald-600')).toBeTruthy();
    });

    it('shows a negative trend in red, as a magnitude', () => {
      // The arrow carries the direction; a "-8.0%" beside a down arrow reads
      // as a double negative.
      const { container } = render(<KpiCard label="Leads" value="128" icon={Target} trend={-8} />);
      expect(screen.getByText('8.0%')).toBeInTheDocument();
      expect(container.querySelector('.text-rose-600')).toBeTruthy();
    });

    it('treats a flat trend as non-negative', () => {
      const { container } = render(<KpiCard label="Leads" value="128" icon={Target} trend={0} />);
      expect(screen.getByText('0.0%')).toBeInTheDocument();
      expect(container.querySelector('.text-emerald-600')).toBeTruthy();
    });

    it('renders a zero trend rather than treating it as absent', () => {
      // `trend` is checked with `typeof === 'number'` precisely so 0 survives;
      // a truthiness check would hide a genuinely flat week.
      render(<KpiCard label="Leads" value="128" icon={Target} trend={0} />);
      expect(screen.getByText('0.0%')).toBeInTheDocument();
    });

    it('omits the trend row when no trend is supplied', () => {
      const { container } = render(<KpiCard label="Leads" value="128" icon={Target} />);
      expect(container.querySelector('.text-emerald-600')).toBeNull();
      expect(container.querySelector('.text-rose-600')).toBeNull();
    });
  });

  it('defaults the icon tile to the accent colours', () => {
    const { container } = render(<KpiCard label="Leads" value="1" icon={Target} />);
    expect(container.querySelector('.bg-accent')).toBeTruthy();
  });

  it('accepts an icon tile override', () => {
    const { container } = render(
      <KpiCard label="Leads" value="1" icon={Target} iconClassName="bg-rose-100 text-rose-700" />,
    );
    expect(container.querySelector('.bg-rose-100')).toBeTruthy();
    expect(container.querySelector('.bg-accent')).toBeNull();
  });
});
