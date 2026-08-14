import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LeadCard } from './lead-card';
import { makeLead } from '@/__tests__/lead-fixture';

describe('LeadCard', () => {
  it('shows the buyer name and phone', () => {
    render(<LeadCard lead={makeLead()} />);
    expect(screen.getByText('Asha Rao')).toBeInTheDocument();
    expect(screen.getByText('+919800000001')).toBeInTheDocument();
  });

  it('falls back to "Unknown buyer" for a nameless lead', () => {
    // Portal and IVR leads routinely arrive with only a phone number.
    render(<LeadCard lead={makeLead({ name: null })} />);
    expect(screen.getByText('Unknown buyer')).toBeInTheDocument();
  });

  it('shows the qualification score', () => {
    render(<LeadCard lead={makeLead({ qualScore: 83 })} />);
    expect(screen.getByText('Score 83')).toBeInTheDocument();
  });

  describe('the requirement summary', () => {
    it('joins config, first locality and budget', () => {
      render(
        <LeadCard
          lead={makeLead({
            bltc: {
              budgetMinPaise: 5_000_000_00,
              budgetMaxPaise: 8_000_000_00,
              localities: ['Powai', 'Andheri'],
              timelineMonths: 3,
              config: '2BHK',
              purpose: 'END_USE',
              financing: null,
            },
          })}
        />,
      );
      expect(screen.getByText(/2BHK · Powai/)).toBeInTheDocument();
    });

    it('drops the empty parts instead of leaving dangling separators', () => {
      render(
        <LeadCard
          lead={makeLead({
            bltc: {
              budgetMinPaise: null,
              budgetMaxPaise: null,
              localities: ['Powai'],
              timelineMonths: null,
              config: null,
              purpose: null,
              financing: null,
            },
          })}
        />,
      );
      expect(screen.getByText('Powai')).toBeInTheDocument();
    });

    it('omits the line entirely when nothing is known yet', () => {
      const { container } = render(<LeadCard lead={makeLead()} />);
      expect(container.textContent).not.toContain(' · ');
    });
  });

  describe('the HOT flag', () => {
    it('flags a hot lead', () => {
      render(<LeadCard lead={makeLead({ temperature: 'HOT' })} />);
      expect(screen.getByText('HOT')).toBeInTheDocument();
    });

    it('is absent for every other temperature', () => {
      for (const temperature of ['WARM', 'COLD', 'JUNK'] as const) {
        const { unmount } = render(<LeadCard lead={makeLead({ temperature })} />);
        expect(screen.queryByText('HOT')).not.toBeInTheDocument();
        unmount();
      }
    });
  });

  describe('as a link', () => {
    it('renders a real anchor, so the card can be opened in a new tab', () => {
      render(<LeadCard lead={makeLead()} href="/leads/l1" />);
      expect(screen.getByRole('link')).toHaveAttribute('href', '/leads/l1');
    });

    it('is not also a button', () => {
      render(<LeadCard lead={makeLead()} href="/leads/l1" />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('prefers the link when both href and onClick are given', () => {
      const onClick = vi.fn();
      render(<LeadCard lead={makeLead()} href="/leads/l1" onClick={onClick} />);
      expect(screen.getByRole('link')).toBeInTheDocument();
    });
  });

  describe('as a button', () => {
    it('reports a click', () => {
      const onClick = vi.fn();
      render(<LeadCard lead={makeLead()} onClick={onClick} />);
      fireEvent.click(screen.getByRole('button'));
      expect(onClick).toHaveBeenCalledOnce();
    });

    it('is reachable by keyboard', () => {
      // Without tabIndex the quick-view dossier is mouse-only.
      const onClick = vi.fn();
      render(<LeadCard lead={makeLead()} onClick={onClick} />);
      expect(screen.getByRole('button')).toHaveAttribute('tabindex', '0');
    });

    it('activates on Enter and Space', () => {
      const onClick = vi.fn();
      render(<LeadCard lead={makeLead()} onClick={onClick} />);
      fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
      fireEvent.keyDown(screen.getByRole('button'), { key: ' ' });
      expect(onClick).toHaveBeenCalledTimes(2);
    });

    it('ignores other keys', () => {
      const onClick = vi.fn();
      render(<LeadCard lead={makeLead()} onClick={onClick} />);
      fireEvent.keyDown(screen.getByRole('button'), { key: 'a' });
      fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' });
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('as a static card', () => {
    it('exposes no interactive role when neither href nor onClick is given', () => {
      render(<LeadCard lead={makeLead()} />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });

    it('is not focusable', () => {
      const { container } = render(<LeadCard lead={makeLead()} />);
      expect(container.firstElementChild).not.toHaveAttribute('tabindex');
    });

    it('does not show a pointer cursor it cannot honour', () => {
      const { container } = render(<LeadCard lead={makeLead()} />);
      expect(container.firstElementChild?.className).not.toContain('cursor-pointer');
    });
  });

  it('colours its left border by temperature', () => {
    const { container: hot } = render(<LeadCard lead={makeLead({ temperature: 'HOT' })} />);
    const { container: cold } = render(<LeadCard lead={makeLead({ temperature: 'COLD' })} />);
    expect(hot.firstElementChild?.className).not.toBe(cold.firstElementChild?.className);
  });
});
