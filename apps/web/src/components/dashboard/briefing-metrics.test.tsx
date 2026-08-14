/**
 * The four-tile morning-briefing row.
 *
 * Two behaviours matter here and both are invisible in the markup. The first is
 * that the tiles count *lengths* of the briefing's three item lists but read
 * `pendingApprovals` as a plain number — mixing those up would show "4" drafts
 * because the array happens to have four entries somewhere else. The second is
 * the error branch: realty is an add-on, so a tenant without it provisioned
 * gets a 404 from the briefing endpoint, and the row must disappear entirely
 * rather than render four zeroes that look like a real, empty day.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MorningBriefing } from '@/lib/realty-types';

let briefing: { data?: MorningBriefing; isLoading: boolean; isError: boolean } = {
  data: undefined,
  isLoading: false,
  isError: false,
};

vi.mock('@/hooks/use-realty', () => ({
  useMorningBriefing: () => briefing,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { BriefingMetrics } from './briefing-metrics';

const item = (id: string) => ({ id, name: id, reason: 'why' }) as never;

function makeBriefing(overrides: Partial<MorningBriefing> = {}): MorningBriefing {
  return {
    date: '2026-08-14',
    hotLeads: [item('l1'), item('l2')],
    visitsToday: [item('v1')],
    followupsDue: [item('f1'), item('f2'), item('f3')],
    pendingApprovals: 5,
    pipeline: [],
    generatedAt: '2026-08-14T02:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  briefing = { data: makeBriefing(), isLoading: false, isError: false };
});

describe('BriefingMetrics', () => {
  it('counts each list and reads the approval total straight through', () => {
    render(<BriefingMetrics />);

    const tile = (label: string) => screen.getByText(label).closest('div')!.parentElement!;

    expect(tile("Today's visits")).toHaveTextContent('1');
    expect(tile('Hot leads')).toHaveTextContent('2');
    expect(tile('Follow-ups due')).toHaveTextContent('3');
    // `pendingApprovals` is already a count — five drafts, not five of anything else.
    expect(tile('Drafts to approve')).toHaveTextContent('5');
  });

  it('points each tile at the screen that acts on it', () => {
    render(<BriefingMetrics />);

    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/sitevisits', '/leads', '/leads', '/approvals']);
  });

  it('shows skeletons rather than zeroes while the briefing is in flight', () => {
    briefing = { data: undefined, isLoading: true, isError: false };
    const { container } = render(<BriefingMetrics />);

    // Four labels stay up so the row does not jump when the numbers land…
    expect(screen.getByText('Hot leads')).toBeInTheDocument();
    // …but no count is rendered yet — a "0" here reads as a real answer.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.animate-pulse').length).toBe(4);
  });

  it('renders nothing when realty is not provisioned for the tenant', () => {
    briefing = { data: undefined, isLoading: false, isError: true };
    const { container } = render(<BriefingMetrics />);

    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to zero for each tile when the briefing is empty', () => {
    briefing = {
      data: makeBriefing({ hotLeads: [], visitsToday: [], followupsDue: [], pendingApprovals: 0 }),
      isLoading: false,
      isError: false,
    };
    render(<BriefingMetrics />);

    expect(screen.getAllByText('0')).toHaveLength(4);
  });
});
