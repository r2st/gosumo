import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteVisit } from '@/lib/realty-types';

interface VisitsState {
  data?: { data: SiteVisit[] };
  isLoading: boolean;
  isError: boolean;
}
let visitsQ: VisitsState = { isLoading: false, isError: false };
const useLeadVisits = vi.fn((_leadId: string) => visitsQ);

vi.mock('@/hooks/use-realty', () => ({
  useLeadVisits: (id: string) => useLeadVisits(id),
}));

import { LeadVisitHistory } from './lead-visit-history';

function visit(overrides: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: 'v1',
    scheduledAt: '2026-08-20T05:30:00.000Z',
    status: 'BOOKED',
    outcome: 'PENDING',
    feedback: null,
    ...overrides,
  } as SiteVisit;
}

function withVisits(visits: SiteVisit[]) {
  visitsQ = { data: { data: visits }, isLoading: false, isError: false };
}

describe('LeadVisitHistory', () => {
  beforeEach(() => {
    useLeadVisits.mockClear();
    withVisits([]);
  });

  it('queries visits for the given lead', () => {
    render(<LeadVisitHistory leadId="lead-9" />);
    expect(useLeadVisits).toHaveBeenCalledWith('lead-9');
  });

  it('always renders its heading', () => {
    render(<LeadVisitHistory leadId="l1" />);
    expect(screen.getByText('Site visits')).toBeInTheDocument();
  });

  describe('states', () => {
    it('shows a spinner while loading', () => {
      visitsQ = { isLoading: true, isError: false };
      render(<LeadVisitHistory leadId="l1" />);
      expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    });

    it('reports a failure', () => {
      visitsQ = { isLoading: false, isError: true };
      render(<LeadVisitHistory leadId="l1" />);
      expect(screen.getByText('Could not load visits.')).toBeInTheDocument();
    });

    it('explains an empty history', () => {
      render(<LeadVisitHistory leadId="l1" />);
      expect(screen.getByText('No site visits scheduled yet.')).toBeInTheDocument();
    });

    it('treats a missing payload as empty rather than crashing', () => {
      visitsQ = { isLoading: false, isError: false };
      render(<LeadVisitHistory leadId="l1" />);
      expect(screen.getByText('No site visits scheduled yet.')).toBeInTheDocument();
    });
  });

  describe('the visit list', () => {
    it('renders one row per visit', () => {
      withVisits([visit(), visit({ id: 'v2' })]);
      render(<LeadVisitHistory leadId="l1" />);
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });

    it('renders the scheduled time in IST, not raw UTC', () => {
      withVisits([visit()]);
      render(<LeadVisitHistory leadId="l1" />);
      expect(screen.queryByText(/2026-08-20T05:30/)).not.toBeInTheDocument();
    });

    it('labels the status', () => {
      withVisits([visit({ status: 'COMPLETED' })]);
      render(<LeadVisitHistory leadId="l1" />);
      expect(screen.getByText('Completed')).toBeInTheDocument();
    });

    it('labels every status the API can send', () => {
      const statuses = [
        'BOOKED',
        'CONFIRMED',
        'COMPLETED',
        'NO_SHOW',
        'RESCHEDULED',
        'CANCELLED',
      ] as const;
      withVisits(statuses.map((status, i) => visit({ id: `v${i}`, status })));
      render(<LeadVisitHistory leadId="l1" />);
      for (const label of [
        'Booked',
        'Confirmed',
        'Completed',
        'No-show',
        'Rescheduled',
        'Cancelled',
      ]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    });

    describe('the outcome line', () => {
      it('is hidden while the outcome is still pending', () => {
        // "Outcome: Pending" is noise on a visit that has not happened yet.
        withVisits([visit({ outcome: 'PENDING' })]);
        render(<LeadVisitHistory leadId="l1" />);
        expect(screen.queryByText(/Outcome:/)).not.toBeInTheDocument();
      });

      it('appears once the visit has an outcome', () => {
        withVisits([visit({ status: 'COMPLETED', outcome: 'INTERESTED' })]);
        render(<LeadVisitHistory leadId="l1" />);
        expect(screen.getByText('Outcome: Interested')).toBeInTheDocument();
      });

      it('labels every outcome the API can send', () => {
        const outcomes = [
          'INTERESTED',
          'NOT_INTERESTED',
          'WANTS_ALTERNATIVE',
          'NEEDS_FOLLOWUP',
          'TOKEN_BOOKED',
        ] as const;
        withVisits(outcomes.map((outcome, i) => visit({ id: `v${i}`, outcome })));
        render(<LeadVisitHistory leadId="l1" />);
        for (const label of [
          'Interested',
          'Not interested',
          'Wants alternative',
          'Needs follow-up',
          'Token booked',
        ]) {
          expect(screen.getByText(`Outcome: ${label}`)).toBeInTheDocument();
        }
      });
    });

    it('quotes the agent’s feedback when there is any', () => {
      withVisits([visit({ feedback: 'Loved the view, worried about the commute' })]);
      render(<LeadVisitHistory leadId="l1" />);
      expect(
        screen.getByText('“Loved the view, worried about the commute”'),
      ).toBeInTheDocument();
    });

    it('omits the feedback line when there is none', () => {
      withVisits([visit({ feedback: null })]);
      const { container } = render(<LeadVisitHistory leadId="l1" />);
      expect(container.textContent).not.toContain('“');
    });
  });
});
