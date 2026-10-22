import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TdsCalculator } from './calculator';

describe('TdsCalculator', () => {
  it('renders the title and input fields', () => {
    render(<TdsCalculator />);
    expect(screen.getByText('TDS on Salary Calculator')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1200000')).toBeInTheDocument();
  });

  it('shows zero tax for ₹12L salary under the new regime (87A rebate)', () => {
    render(<TdsCalculator />);
    // 12,00,000 - 75,000 std deduction = 11,25,000 taxable → within ₹12L rebate limit
    expect(screen.getByText('Monthly TDS')).toBeInTheDocument();
    expect(screen.getAllByText('₹0').length).toBeGreaterThan(0);
  });

  it('switches to old regime and shows deductions input', () => {
    render(<TdsCalculator />);
    fireEvent.click(screen.getByRole('button', { name: 'Old Regime' }));
    expect(screen.getByText(/80C, 80D, HRA/)).toBeInTheDocument();
  });

  it('shows the new regime slab table', () => {
    render(<TdsCalculator />);
    expect(screen.getByText('Up to ₹4,00,000')).toBeInTheDocument();
    expect(screen.getByText('Above ₹24,00,000')).toBeInTheDocument();
  });
});
