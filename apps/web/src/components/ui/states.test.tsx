/**
 * The shared Loading/Empty/Error states.
 *
 * ErrorState is the one that carries risk: it is the single place every
 * dashboard surface renders a failure, so the `error` → copy wiring and the
 * suppression of a useless "Try again" button are asserted here once rather
 * than at ~40 call sites.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Users } from 'lucide-react';
import { ApiError } from '@/lib/api-client';
import { LoadingState, EmptyState, ErrorState, Spinner } from './states';

describe('LoadingState', () => {
  it('shows a default label', () => {
    render(<LoadingState />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows a caller-supplied label', () => {
    render(<LoadingState label="Loading approval queue…" />);
    expect(screen.getByText('Loading approval queue…')).toBeInTheDocument();
  });

  it('renders a spinner on its own', () => {
    const { container } = render(<Spinner />);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('shows the title, and the description when given', () => {
    render(<EmptyState title="No clients found" description="Try a different segment." />);

    expect(screen.getByText('No clients found')).toBeInTheDocument();
    expect(screen.getByText('Try a different segment.')).toBeInTheDocument();
  });

  it('omits the description and action when not given', () => {
    const { container } = render(<EmptyState title="No clients found" />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('renders an icon and an action when supplied', () => {
    render(
      <EmptyState title="No clients" icon={Users} action={<button>Add a client</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Add a client' })).toBeInTheDocument();
  });
});

describe('ErrorState — explicit message (legacy call sites)', () => {
  it('shows the message verbatim when no error is passed', () => {
    render(<ErrorState message="Could not load approvals." />);
    expect(screen.getByText('Could not load approvals.')).toBeInTheDocument();
  });

  it('shows only the title when neither message nor error is passed', () => {
    render(<ErrorState />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.queryByRole('paragraph')).not.toBeInTheDocument();
  });

  it('accepts a custom title', () => {
    render(<ErrorState title="Inbox unavailable" />);
    expect(screen.getByText('Inbox unavailable')).toBeInTheDocument();
  });
});

describe('ErrorState — derived from the thrown error', () => {
  it('turns a network failure into connection advice, not transport copy', () => {
    render(
      <ErrorState
        error={new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the GoSumo Realty API. Is it running?')}
      />,
    );

    expect(screen.getByText(/Check your internet connection/)).toBeInTheDocument();
    expect(screen.queryByText(/Is it running/)).not.toBeInTheDocument();
  });

  it('turns a 401 into sign-in advice', () => {
    render(<ErrorState error={new ApiError(401, 'UNAUTHORIZED', 'Unauthorized')} />);
    expect(screen.getByText(/session has expired/)).toBeInTheDocument();
  });

  it('uses the message as the fallback when the error says nothing specific', () => {
    render(
      <ErrorState
        message="Could not load approvals."
        error={new ApiError(500, 'ERROR', 'Internal Server Error')}
      />,
    );
    expect(screen.getByText('Could not load approvals.')).toBeInTheDocument();
  });

  it('prefers the error-derived copy over the generic fallback message', () => {
    render(
      <ErrorState
        message="Could not load approvals."
        error={new ApiError(403, 'FORBIDDEN', 'Forbidden')}
      />,
    );

    expect(screen.getByText(/don’t have permission/)).toBeInTheDocument();
    expect(screen.queryByText('Could not load approvals.')).not.toBeInTheDocument();
  });
});

describe('ErrorState — retry affordance', () => {
  it('calls onRetry when the button is clicked', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="boom" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders no button when no handler is given', () => {
    render(<ErrorState message="boom" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers a retry for transient failures', () => {
    render(<ErrorState error={new ApiError(503, 'UNAVAILABLE', 'x')} onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ])('hides the retry for a %i, which retrying cannot fix', (status, code) => {
    render(<ErrorState error={new ApiError(status, code, 'x')} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('still offers a retry when the caller passed no error to judge', () => {
    render(<ErrorState message="boom" onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
