import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DashboardError from './error';

describe('DashboardError', () => {
  it('renders an actionable error message', () => {
    render(<DashboardError error={new Error('test')} reset={() => {}} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('calls reset when "Try again" is clicked', () => {
    const reset = vi.fn();
    render(<DashboardError error={new Error('test')} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('does not show raw error messages to the user', () => {
    const error = new Error('PrismaClientKnownRequestError: Invalid `prisma.query`');
    render(<DashboardError error={error} reset={() => {}} />);
    expect(screen.queryByText(/PrismaClient/)).not.toBeInTheDocument();
  });
});
