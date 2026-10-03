import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SlaCalculator } from './calculator';

describe('SlaCalculator', () => {
  it('renders the title and input fields', () => {
    render(<SlaCalculator />);
    expect(screen.getByText('SLA Calculator')).toBeInTheDocument();
    expect(screen.getByDisplayValue('99.9')).toBeInTheDocument();
    expect(screen.getByDisplayValue('500')).toBeInTheDocument();
  });

  it('displays calculated results', () => {
    render(<SlaCalculator />);
    expect(screen.getByText('Downtime / Month')).toBeInTheDocument();
    expect(screen.getByText('Agents Needed')).toBeInTheDocument();
  });

  it('shows common SLA tiers reference', () => {
    render(<SlaCalculator />);
    expect(screen.getByText('Three nines')).toBeInTheDocument();
    expect(screen.getByText('Five nines')).toBeInTheDocument();
  });
});
