import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Q {
  data?: { total: number };
  isLoading: boolean;
  isError: boolean;
}

let leadsQ: Q = { data: { total: 100 }, isLoading: false, isError: false };
let visitsQ: Q = { data: { total: 12 }, isLoading: false, isError: false };

vi.mock('@/hooks/use-realty', () => ({
  useLeads: () => leadsQ,
  useSiteVisits: () => visitsQ,
}));

import { NorthStarKpi } from './north-star-kpi';
import { NORTH_STAR_GOAL } from '@/lib/realty-ui';

function progressBar(container: HTMLElement) {
  return container.querySelector('.rounded-full.transition-all') as HTMLElement | null;
}

describe('NorthStarKpi', () => {
  beforeEach(() => {
    leadsQ = { data: { total: 100 }, isLoading: false, isError: false };
    visitsQ = { data: { total: 12 }, isLoading: false, isError: false };
  });

  it('renders visits per 100 leads to one decimal', () => {
    render(<NorthStarKpi />);
    expect(screen.getByText('12.0')).toBeInTheDocument();
  });

  it('shows the underlying totals', () => {
    render(<NorthStarKpi />);
    expect(screen.getByText('12 visits · 100 leads')).toBeInTheDocument();
  });

  it('singularises a count of one', () => {
    leadsQ = { data: { total: 1 }, isLoading: false, isError: false };
    visitsQ = { data: { total: 1 }, isLoading: false, isError: false };
    render(<NorthStarKpi />);
    expect(screen.getByText('1 visit · 1 lead')).toBeInTheDocument();
  });

  it('states the goal', () => {
    render(<NorthStarKpi />);
    expect(screen.getByText(`Goal ≥ ${NORTH_STAR_GOAL}`)).toBeInTheDocument();
  });

  describe('target status', () => {
    it('reads on target at the goal exactly', () => {
      visitsQ = { data: { total: 8 }, isLoading: false, isError: false };
      render(<NorthStarKpi />);
      expect(screen.getByText('On target')).toBeInTheDocument();
    });

    it('reads below target just under the goal', () => {
      visitsQ = { data: { total: 7 }, isLoading: false, isError: false };
      render(<NorthStarKpi />);
      expect(screen.getByText('Below target')).toBeInTheDocument();
    });
  });

  describe('progress bar', () => {
    it('fills proportionally below the goal', () => {
      visitsQ = { data: { total: 4 }, isLoading: false, isError: false };
      const { container } = render(<NorthStarKpi />);
      expect(progressBar(container)).toHaveStyle({ width: '50%' });
    });

    it('caps at 100% when the goal is beaten', () => {
      // 24 visits per 100 leads is 3× the goal; an uncapped width overflows
      // the track and paints outside the card.
      visitsQ = { data: { total: 24 }, isLoading: false, isError: false };
      const { container } = render(<NorthStarKpi />);
      expect(progressBar(container)).toHaveStyle({ width: '100%' });
    });

    it('sits at 0% while loading', () => {
      leadsQ = { isLoading: true, isError: false };
      const { container } = render(<NorthStarKpi />);
      expect(progressBar(container)).toHaveStyle({ width: '0%' });
    });
  });

  describe('empty and loading states', () => {
    it('shows 0.0 rather than NaN when there are no leads yet', () => {
      // A fresh tenant has zero leads; dividing by it must not render "NaN".
      leadsQ = { data: { total: 0 }, isLoading: false, isError: false };
      visitsQ = { data: { total: 0 }, isLoading: false, isError: false };
      render(<NorthStarKpi />);
      expect(screen.getByText('0.0')).toBeInTheDocument();
    });

    it('treats missing totals as zero', () => {
      leadsQ = { isLoading: false, isError: false };
      visitsQ = { isLoading: false, isError: false };
      render(<NorthStarKpi />);
      expect(screen.getByText('0.0')).toBeInTheDocument();
    });

    it('hides the number and status while either query loads', () => {
      visitsQ = { isLoading: true, isError: false };
      render(<NorthStarKpi />);
      expect(screen.queryByText('12.0')).not.toBeInTheDocument();
      expect(screen.queryByText('On target')).not.toBeInTheDocument();
      expect(screen.queryByText('Below target')).not.toBeInTheDocument();
    });

    it('still shows the goal chip while loading, so the card keeps its height', () => {
      leadsQ = { isLoading: true, isError: false };
      render(<NorthStarKpi />);
      expect(screen.getByText(`Goal ≥ ${NORTH_STAR_GOAL}`)).toBeInTheDocument();
    });
  });

  describe('non-realty tenants', () => {
    it('renders nothing when the leads endpoint errors', () => {
      // Commerce-only tenants have no /realty endpoints; the card must vanish
      // rather than show a broken 0.0 or an error box on their dashboard.
      leadsQ = { isLoading: false, isError: true };
      const { container } = render(<NorthStarKpi />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when the site-visits endpoint errors', () => {
      visitsQ = { isLoading: false, isError: true };
      const { container } = render(<NorthStarKpi />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
