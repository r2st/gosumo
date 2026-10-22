import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GratuityCalculator } from './calculator';

describe('GratuityCalculator', () => {
  it('renders the title and input fields', () => {
    render(<GratuityCalculator />);
    expect(screen.getByText('Gratuity Calculator')).toBeInTheDocument();
    expect(screen.getByDisplayValue('50000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('7')).toBeInTheDocument();
  });

  it('displays calculated gratuity for default inputs', () => {
    render(<GratuityCalculator />);
    // (15 × 50000 × 7) / 26 = 201,923
    expect(screen.getByText('Gratuity Payable')).toBeInTheDocument();
    expect(screen.getAllByText('₹2,01,923').length).toBeGreaterThan(0);
  });

  it('shows the formula explanation', () => {
    render(<GratuityCalculator />);
    expect(screen.getByText(/15 × last drawn salary × years of service/)).toBeInTheDocument();
  });
});
