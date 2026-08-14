import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MorningBriefing } from './morning-briefing';
import type { MorningBriefing as Briefing } from '@/lib/realty-types';

// Mock the data hook so the component renders in isolation (no react-query).
const useMorningBriefing = vi.fn();
vi.mock('@/hooks/use-realty', () => ({
  useMorningBriefing: () => useMorningBriefing(),
}));

function makeBriefing(overrides: Partial<Briefing> = {}): Briefing {
  return {
    date: '2026-07-03',
    hotLeads: [{ leadId: 'l1', name: 'Rahul M', detail: '2BHK · Baner · ₹90.0L' }],
    visitsToday: [{ leadId: 'l2', name: 'Priya S', detail: '3BHK · Wakad' }],
    followupsDue: [
      { leadId: 'l3', name: 'Amit K', detail: 'Follow-up due · 2BHK' },
      { leadId: 'l4', name: 'Neha T', detail: 'Follow-up due · 1BHK' },
    ],
    pendingApprovals: 3,
    pipeline: [{ stage: 'NEW', count: 5 }],
    generatedAt: '2026-07-03T02:00:00.000Z',
    ...overrides,
  };
}

describe('MorningBriefing', () => {
  it('renders the three buckets with counts and the pending-approvals footer', () => {
    useMorningBriefing.mockReturnValue({ data: makeBriefing(), isLoading: false, isError: false });
    render(<MorningBriefing />);

    expect(screen.getByText('Hot leads')).toBeInTheDocument();
    expect(screen.getByText('Visits today')).toBeInTheDocument();
    expect(screen.getByText('Follow-ups due')).toBeInTheDocument();
    expect(screen.getByText('Rahul M')).toBeInTheDocument();
    // pluralized pending-approvals summary
    expect(screen.getByText(/3 drafts to review/i)).toBeInTheDocument();
  });

  it('shows a loading state while fetching', () => {
    useMorningBriefing.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<MorningBriefing />);
    expect(screen.getByText(/building your briefing/i)).toBeInTheDocument();
  });

  it('renders nothing when the briefing errors (realty not provisioned)', () => {
    useMorningBriefing.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    const { container } = render(<MorningBriefing />);
    expect(container).toBeEmptyDOMElement();
  });

  it('handles the singular draft label', () => {
    useMorningBriefing.mockReturnValue({
      data: makeBriefing({ pendingApprovals: 1 }),
      isLoading: false,
      isError: false,
    });
    render(<MorningBriefing />);
    expect(screen.getByText(/1 draft to review/i)).toBeInTheDocument();
  });
});

/**
 * The briefing is the first thing an agent sees each morning, so the two
 * degenerate shapes matter: a bucket with nothing in it, and a lead the
 * ingestion never captured a name for (a missed call, a portal row with only a
 * phone). Both are ordinary, and neither should render a blank line.
 */
describe('MorningBriefing degenerate rows', () => {
  it('says so when a bucket is empty rather than rendering an empty list', () => {
    useMorningBriefing.mockReturnValue({
      data: makeBriefing({ hotLeads: [], visitsToday: [], followupsDue: [] }),
      isLoading: false,
      isError: false,
    });
    render(<MorningBriefing />);

    expect(screen.getAllByText('Nothing yet')).toHaveLength(3);
    // The headings stay — an agent should see that the bucket exists and is
    // clear, not that the section vanished.
    expect(screen.getByText('Hot leads')).toBeInTheDocument();
  });

  it('labels a nameless lead rather than leaving the link blank', () => {
    useMorningBriefing.mockReturnValue({
      data: makeBriefing({
        hotLeads: [{ leadId: 'l9', name: null, detail: '2BHK · Hinjewadi' }],
      }),
      isLoading: false,
      isError: false,
    });
    render(<MorningBriefing />);

    expect(screen.getByText('Unknown buyer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Hinjewadi/ })).toHaveAttribute(
      'href',
      '/leads?lead=l9',
    );
  });
});
