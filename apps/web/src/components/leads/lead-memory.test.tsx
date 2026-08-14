import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeadMemory } from './lead-memory';
import { makeLead } from '@/__tests__/lead-fixture';
import type { LeadMemoryEntry } from '@/lib/realty-types';

function entry(text: string): LeadMemoryEntry {
  return { text, at: '2026-07-01T00:00:00.000Z' } as LeadMemoryEntry;
}

describe('LeadMemory', () => {
  it('always renders its heading, so the section does not vanish when empty', () => {
    render(<LeadMemory lead={makeLead()} />);
    expect(screen.getByText('What the AI learned')).toBeInTheDocument();
  });

  it('explains the empty state rather than showing a blank panel', () => {
    render(<LeadMemory lead={makeLead()} />);
    expect(screen.getByText(/hasn't extracted anything/)).toBeInTheDocument();
  });

  it('renders extracted facts', () => {
    render(
      <LeadMemory lead={makeLead({ extractedFacts: [entry('Works at Infosys, Powai')] })} />,
    );
    expect(screen.getByText('Facts learned')).toBeInTheDocument();
    expect(screen.getByText('Works at Infosys, Powai')).toBeInTheDocument();
  });

  it('renders objections', () => {
    render(<LeadMemory lead={makeLead({ objections: [entry('Price is above budget')] })} />);
    expect(screen.getByText('Objections')).toBeInTheDocument();
    expect(screen.getByText('Price is above budget')).toBeInTheDocument();
  });

  it('renders promises', () => {
    render(<LeadMemory lead={makeLead({ promises: [entry('Will visit on Saturday')] })} />);
    expect(screen.getByText('Promises')).toBeInTheDocument();
    expect(screen.getByText('Will visit on Saturday')).toBeInTheDocument();
  });

  it('omits a group with no entries rather than showing an empty heading', () => {
    render(<LeadMemory lead={makeLead({ objections: [entry('Too far from school')] })} />);
    expect(screen.getByText('Objections')).toBeInTheDocument();
    expect(screen.queryByText('Facts learned')).not.toBeInTheDocument();
    expect(screen.queryByText('Promises')).not.toBeInTheDocument();
  });

  it('renders all three groups in a fixed order', () => {
    // Facts → objections → promises reads as a narrative; reordering per lead
    // would make the panel hard to scan across records.
    const { container } = render(
      <LeadMemory
        lead={makeLead({
          extractedFacts: [entry('Fact')],
          objections: [entry('Objection')],
          promises: [entry('Promise')],
        })}
      />,
    );
    const headings = Array.from(container.querySelectorAll('h4')).map((h) => h.textContent);
    expect(headings).toEqual(['Facts learned', 'Objections', 'Promises']);
  });

  it('renders every entry in a group', () => {
    render(
      <LeadMemory
        lead={makeLead({ extractedFacts: [entry('One'), entry('Two'), entry('Three')] })}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('gives each group its own bullet colour', () => {
    const { container } = render(
      <LeadMemory
        lead={makeLead({
          extractedFacts: [entry('Fact')],
          objections: [entry('Objection')],
          promises: [entry('Promise')],
        })}
      />,
    );
    expect(container.querySelector('.bg-sky-400')).toBeTruthy();
    expect(container.querySelector('.bg-amber-400')).toBeTruthy();
    expect(container.querySelector('.bg-emerald-400')).toBeTruthy();
  });

  it('merges a caller className', () => {
    const { container } = render(<LeadMemory lead={makeLead()} className="mt-4" />);
    expect(container.firstElementChild?.className).toContain('mt-4');
  });
});
