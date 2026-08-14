import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mutate = vi.fn();
interface MatchState {
  mutate: typeof mutate;
  data?: Array<Record<string, unknown>>;
  isPending: boolean;
  isError: boolean;
}
let match: MatchState = { mutate, isPending: false, isError: false };
let canWrite = true;

vi.mock('@/hooks/use-realty', () => ({
  useMatchForLead: () => match,
}));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ canWrite }),
}));

import { LeadMatchedUnits } from './lead-matched-units';
import { makeLead } from '@/__tests__/lead-fixture';

function unit(overrides: Record<string, unknown> = {}) {
  return {
    unitId: 'u1',
    projectName: 'Lodha Amara',
    config: '2BHK',
    locality: 'Powai',
    allInPricePaise: 8_500_000_00,
    fitScore: 88,
    reasons: ['Within budget', 'Preferred locality'],
    ...overrides,
  };
}

describe('LeadMatchedUnits', () => {
  beforeEach(() => {
    mutate.mockClear();
    match = { mutate, isPending: false, isError: false };
    canWrite = true;
  });

  describe('running the match', () => {
    it('runs on mount for the lead', () => {
      render(<LeadMatchedUnits lead={makeLead({ id: 'lead-9' })} />);
      expect(mutate).toHaveBeenCalledWith({ id: 'lead-9', limit: 8 });
    });

    it('honours a custom limit', () => {
      render(<LeadMatchedUnits lead={makeLead()} limit={3} />);
      expect(mutate).toHaveBeenCalledWith({ id: 'l1', limit: 3 });
    });

    it('re-runs when the lead changes', () => {
      const { rerender } = render(<LeadMatchedUnits lead={makeLead({ id: 'a' })} />);
      rerender(<LeadMatchedUnits lead={makeLead({ id: 'b' })} />);
      expect(mutate).toHaveBeenCalledTimes(2);
      expect(mutate.mock.calls[1][0].id).toBe('b');
    });

    it('does not re-run when an unrelated lead field changes', () => {
      // The match depends on the id and limit only; re-running on every render
      // would fire a POST per keystroke elsewhere in the drawer.
      const { rerender } = render(<LeadMatchedUnits lead={makeLead({ qualScore: 50 })} />);
      rerender(<LeadMatchedUnits lead={makeLead({ qualScore: 51 })} />);
      expect(mutate).toHaveBeenCalledOnce();
    });
  });

  describe('read-only roles', () => {
    it('skips the request entirely for a VIEWER', () => {
      // POST /realty/leads/:id/match only computes, but the verb makes it a
      // write, so the guard's STAFF+ default refuses it. Calling anyway would
      // render a 403 that looks like a bug.
      canWrite = false;
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(mutate).not.toHaveBeenCalled();
    });

    it('explains why matching is unavailable', () => {
      canWrite = false;
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(screen.getByText(/isn't available for read-only roles/)).toBeInTheDocument();
    });

    it('shows the notice even while the mutation reports pending', () => {
      canWrite = false;
      match = { mutate, isPending: true, isError: false };
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(screen.getByText(/read-only roles/)).toBeInTheDocument();
    });
  });

  describe('states', () => {
    it('shows a spinner while matching', () => {
      match = { mutate, isPending: true, isError: false };
      const { container } = render(<LeadMatchedUnits lead={makeLead()} />);
      expect(container.querySelector('svg')).toBeTruthy();
      expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    });

    it('reports a failure', () => {
      match = { mutate, isPending: false, isError: true };
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(screen.getByText('Could not compute matches.')).toBeInTheDocument();
    });

    it('explains an empty result', () => {
      match = { mutate, data: [], isPending: false, isError: false };
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(screen.getByText(/No verified units match/)).toBeInTheDocument();
    });

    it('treats undefined data as empty rather than crashing', () => {
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(screen.getByText(/No verified units match/)).toBeInTheDocument();
    });
  });

  describe('the results list', () => {
    beforeEach(() => {
      match = { mutate, data: [unit()], isPending: false, isError: false };
    });

    it('names the project, config and locality', () => {
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(screen.getByText('Lodha Amara')).toBeInTheDocument();
      expect(screen.getByText(/2BHK · Powai/)).toBeInTheDocument();
    });

    it('shows the fit score as a percentage', () => {
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(screen.getByText('88% match')).toBeInTheDocument();
    });

    it('renders the price in compact rupees, never raw paise', () => {
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(screen.queryByText('850000000')).not.toBeInTheDocument();
      expect(screen.getByText(/₹/)).toBeInTheDocument();
    });

    it('shows the top reason and keeps the rest in the tooltip', () => {
      render(<LeadMatchedUnits lead={makeLead()} />);
      const reason = screen.getByText('Within budget');
      expect(reason).toBeInTheDocument();
      expect(reason).toHaveAttribute('title', 'Within budget · Preferred locality');
    });

    it('omits the reason line when the matcher gave none', () => {
      match = { mutate, data: [unit({ reasons: [] })], isPending: false, isError: false };
      const { container } = render(<LeadMatchedUnits lead={makeLead()} />);
      expect(container.querySelector('[title]')).toBeNull();
    });

    it('renders one row per unit', () => {
      match = {
        mutate,
        data: [unit(), unit({ unitId: 'u2', projectName: 'Runwal Forests' })],
        isPending: false,
        isError: false,
      };
      render(<LeadMatchedUnits lead={makeLead()} />);
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });

    it('varies the border by fit score, so a weak match reads differently', () => {
      match = {
        mutate,
        data: [unit({ fitScore: 95 }), unit({ unitId: 'u2', fitScore: 30 })],
        isPending: false,
        isError: false,
      };
      render(<LeadMatchedUnits lead={makeLead()} />);
      const [strong, weak] = screen.getAllByRole('listitem');
      expect(strong.className).not.toBe(weak.className);
    });
  });
});
