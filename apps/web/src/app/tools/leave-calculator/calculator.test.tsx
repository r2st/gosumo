import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeaveCalculator } from './calculator';

describe('LeaveCalculator', () => {
  it('renders the title and input fields', () => {
    render(<LeaveCalculator />);
    expect(screen.getByText('Leave Encashment Calculator')).toBeInTheDocument();
    expect(screen.getByDisplayValue('40000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('18')).toBeInTheDocument();
  });

  it('displays encashment value for default inputs', () => {
    render(<LeaveCalculator />);
    // (40000 / 30) × 18 = 24,000
    expect(screen.getByText('Encashment Value')).toBeInTheDocument();
    expect(screen.getAllByText('₹24,000').length).toBeGreaterThan(0);
  });

  it('displays accrued leave for default inputs', () => {
    render(<LeaveCalculator />);
    // (24 / 12) × 12 = 24 days
    expect(screen.getByText('24.0 days')).toBeInTheDocument();
  });
});
