import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
const mutate = vi.fn();
interface MatchState {
  mutate: typeof mutate;
  data?: Array<Record<string, unknown>>;
  isPending: boolean;
  isError: boolean;
}
let match: MatchState = { mutate, isPending: false, isError: false };
let canWrite = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/hooks/use-realty', () => ({
  useMatchForLead: () => match,
  useLeadVisits: () => ({ data: { data: [] }, isLoading: false, isError: false }),
}));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ canWrite }),
}));

import { LeadDossier } from './lead-dossier';
import { makeLead } from '@/__tests__/lead-fixture';

function unit(overrides: Record<string, unknown> = {}) {
  return {
    unitId: 'u1',
    projectName: 'Lodha Amara',
    config: '2BHK',
    locality: 'Powai',
    allInPricePaise: 8_500_000_00,
    fitScore: 88,
    reasons: ['Within budget'],
    ...overrides,
  };
}

function renderDossier(lead = makeLead(), onClose = vi.fn()) {
  const view = render(<LeadDossier lead={lead} onClose={onClose} />);
  return { ...view, onClose };
}

describe('LeadDossier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    match = { mutate, isPending: false, isError: false };
    canWrite = true;
  });

  describe('when no lead is selected', () => {
    it('renders nothing', () => {
      const { container } = render(<LeadDossier lead={null} onClose={vi.fn()} />);
      expect(container).toBeEmptyDOMElement();
    });

    it('does not run a match', () => {
      render(<LeadDossier lead={null} onClose={vi.fn()} />);
      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('the drawer header', () => {
    it('titles the drawer with the buyer name', () => {
      renderDossier(makeLead({ name: 'Asha Rao' }));
      expect(screen.getByRole('heading', { name: 'Asha Rao' })).toBeInTheDocument();
    });

    it('falls back to "Unknown buyer"', () => {
      renderDossier(makeLead({ name: null }));
      expect(screen.getByRole('heading', { name: 'Unknown buyer' })).toBeInTheDocument();
    });

    it('summarises stage and score in the subtitle', () => {
      renderDossier(makeLead({ stage: 'QUALIFIED', qualScore: 74 }));
      expect(screen.getByText(/Qualification score 74/)).toBeInTheDocument();
    });

    it('closes on the drawer control', () => {
      const { onClose } = renderDossier();
      fireEvent.click(screen.getByLabelText('Close'));
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  describe('the contact panel', () => {
    it('offers a tel: link for the WhatsApp number', () => {
      // A broker on a phone taps this to dial; it must be a real tel: href.
      renderDossier(makeLead({ whatsappPhone: '+919800000001' }));
      const links = screen.getAllByRole('link');
      expect(links.some((l) => l.getAttribute('href') === 'tel:+919800000001')).toBe(true);
    });

    it('shows the email when there is one', () => {
      renderDossier(makeLead({ email: 'asha@example.in' }));
      expect(screen.getByText('asha@example.in')).toBeInTheDocument();
    });

    it('omits the email line when there is none', () => {
      renderDossier(makeLead({ email: null }));
      expect(screen.queryByText(/@/)).not.toBeInTheDocument();
    });

    it('badges the temperature', () => {
      renderDossier(makeLead({ temperature: 'HOT' }));
      expect(screen.getByText('HOT')).toBeInTheDocument();
    });

    it('flags an opted-out buyer', () => {
      // Messaging an opted-out buyer is a DPDPA problem, so it has to be
      // visible before anyone clicks Takeover.
      renderDossier(makeLead({ optOut: true }));
      expect(screen.getByText('Opted out')).toBeInTheDocument();
    });

    it('does not flag a buyer who has not opted out', () => {
      renderDossier(makeLead({ optOut: false }));
      expect(screen.queryByText('Opted out')).not.toBeInTheDocument();
    });
  });

  it('renders the BLTC, AI-memory and site-visit sections', () => {
    renderDossier();
    expect(screen.getByText('Requirement (BLTC)')).toBeInTheDocument();
    expect(screen.getByText('What the AI learned')).toBeInTheDocument();
    expect(screen.getByText('Site visits')).toBeInTheDocument();
  });

  describe('quick actions', () => {
    it('routes to the site-visit surface', () => {
      renderDossier();
      fireEvent.click(screen.getByText('Book visit'));
      expect(push).toHaveBeenCalledWith('/sitevisits');
    });

    it('routes to inventory for a brochure', () => {
      renderDossier();
      fireEvent.click(screen.getByText('Send brochure'));
      expect(push).toHaveBeenCalledWith('/inventory');
    });

    it('routes to conversations for a takeover', () => {
      renderDossier();
      fireEvent.click(screen.getByText('Takeover'));
      expect(push).toHaveBeenCalledWith('/conversations');
    });

    it('hides every write action from a read-only role', () => {
      canWrite = false;
      renderDossier();
      expect(screen.queryByText('Book visit')).not.toBeInTheDocument();
      expect(screen.queryByText('Send brochure')).not.toBeInTheDocument();
      expect(screen.queryByText('Takeover')).not.toBeInTheDocument();
    });

    it('keeps Call available to everyone, since dialling is not a write', () => {
      canWrite = false;
      renderDossier();
      expect(screen.getByText('Call')).toBeInTheDocument();
    });
  });

  describe('matching', () => {
    it('runs on open, capped at six units for the drawer', () => {
      renderDossier(makeLead({ id: 'lead-9' }));
      expect(mutate).toHaveBeenCalledWith({ id: 'lead-9', limit: 6 });
    });

    it('is skipped for a read-only role', () => {
      canWrite = false;
      renderDossier();
      expect(mutate).not.toHaveBeenCalled();
    });

    it('shows a spinner while matching', () => {
      match = { mutate, isPending: true, isError: false };
      renderDossier();
      expect(screen.queryByText(/% match/)).not.toBeInTheDocument();
    });

    it('reports a failure', () => {
      match = { mutate, isPending: false, isError: true };
      renderDossier();
      expect(screen.getByText('Could not compute matches.')).toBeInTheDocument();
    });

    it('explains an empty result', () => {
      match = { mutate, data: [], isPending: false, isError: false };
      renderDossier();
      expect(screen.getByText(/No verified units match/)).toBeInTheDocument();
    });

    it('lists the matched units with fit and price', () => {
      match = { mutate, data: [unit()], isPending: false, isError: false };
      renderDossier();
      expect(screen.getByText('Lodha Amara')).toBeInTheDocument();
      expect(screen.getByText('88% match')).toBeInTheDocument();
      expect(screen.getByText(/₹/)).toBeInTheDocument();
    });

    it('shows the top reason with the rest in a tooltip', () => {
      match = {
        mutate,
        data: [unit({ reasons: ['Within budget', 'Preferred locality'] })],
        isPending: false,
        isError: false,
      };
      renderDossier();
      expect(screen.getByText('Within budget')).toHaveAttribute(
        'title',
        'Within budget · Preferred locality',
      );
    });

    it('omits the reason line when the matcher gave none', () => {
      match = { mutate, data: [unit({ reasons: [] })], isPending: false, isError: false };
      renderDossier();
      expect(screen.queryByText('Within budget')).not.toBeInTheDocument();
    });

    it('re-runs when a different lead is opened', () => {
      const { rerender } = render(<LeadDossier lead={makeLead({ id: 'a' })} onClose={vi.fn()} />);
      rerender(<LeadDossier lead={makeLead({ id: 'b' })} onClose={vi.fn()} />);
      expect(mutate).toHaveBeenCalledTimes(2);
      expect(mutate.mock.calls[1][0].id).toBe('b');
    });
  });

  it('stacks to one column on mobile before splitting', () => {
    // A bare two-column grid here blows past 375px and scrolls the page sideways.
    const { container } = renderDossier();
    const grid = container.querySelector('.grid-cols-1');
    expect(grid?.className).toContain('lg:grid-cols-');
  });
});
