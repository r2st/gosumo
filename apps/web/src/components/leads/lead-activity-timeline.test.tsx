/**
 * LeadActivityTimeline — the lead dossier's activity stream.
 *
 * The merge itself lives in `lib/lead-timeline.ts` and is tested there. What
 * this component decides is what the agent sees while the picture is still
 * incomplete: the visit list is a second request that resolves after the lead,
 * so the timeline has to render the lifecycle events it already has rather
 * than sitting on a spinner until the visits land. The spinner is therefore
 * gated on "loading *and* nothing to show yet", and that pair is the thing
 * worth pinning — a refactor to plain `isLoading` blanks a populated timeline
 * every time the dossier reopens.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lead, SiteVisit } from '@/lib/realty-types';

const visitsQ = {
  data: undefined as { data: SiteVisit[] } | undefined,
  isLoading: false,
};

vi.mock('@/hooks/use-realty', () => ({
  useLeadVisits: () => visitsQ,
}));

import { LeadActivityTimeline } from './lead-activity-timeline';

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    businessId: 'biz-1',
    assignedAgentId: null,
    conversationId: null,
    clientId: null,
    whatsappPhone: '+919876543210',
    altPhone: null,
    email: null,
    name: 'Rahul M',
    languagePref: 'en',
    source: 'PORTAL',
    subSource: null,
    listingRef: null,
    firstTouchAt: null,
    bltc: {
      budgetMinPaise: null,
      budgetMaxPaise: null,
      localities: [],
      timelineMonths: null,
      config: null,
      purpose: null,
      financing: null,
    },
    qualScore: 62,
    temperature: 'WARM',
    stage: 'NEW',
    matchedUnitIds: [],
    extractedFacts: [],
    objections: [],
    promises: [],
    optOut: false,
    shareConsent: false,
    exchangeStatus: 'NONE',
    nextFollowupAt: null,
    lastActivityAt: null,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  visitsQ.data = { data: [] };
  visitsQ.isLoading = false;
});

describe('LeadActivityTimeline', () => {
  it('renders the lifecycle events the lead already carries', () => {
    render(<LeadActivityTimeline lead={makeLead()} />);
    expect(screen.getByText('Lead captured')).toBeInTheDocument();
  });

  it('spins only while there is genuinely nothing to show', () => {
    // A lead with no usable createdAt produces no events at all, so the visit
    // request is the only thing that could still fill the timeline.
    visitsQ.isLoading = true;
    const { container } = render(<LeadActivityTimeline lead={makeLead({ createdAt: '' })} />);
    expect(container.querySelector('svg.animate-spin')).not.toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('keeps showing the lead’s own events while the visits are still loading', () => {
    visitsQ.isLoading = true;
    render(<LeadActivityTimeline lead={makeLead()} />);

    expect(screen.getByText('Lead captured')).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
  });

  it('says there is nothing recorded once the requests have settled empty', () => {
    render(<LeadActivityTimeline lead={makeLead({ createdAt: '' })} />);
    expect(screen.getByText('No activity recorded yet.')).toBeInTheDocument();
  });

  it('survives a visits request that resolved to nothing at all', () => {
    visitsQ.data = undefined;
    render(<LeadActivityTimeline lead={makeLead()} />);
    expect(screen.getByText('Lead captured')).toBeInTheDocument();
  });

  it('flags a scheduled follow-up as upcoming, and dated events not at all', () => {
    render(
      <LeadActivityTimeline lead={makeLead({ nextFollowupAt: '2026-07-01T09:00:00.000Z' })} />,
    );

    expect(screen.getByText('Follow-up scheduled')).toBeInTheDocument();
    expect(screen.getAllByText('Upcoming')).toHaveLength(1);
  });
});
