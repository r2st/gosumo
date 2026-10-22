/**
 * The route-segment error boundary: it must offer a retry that calls Next's
 * reset() (re-rendering the failed segment) and an escape hatch back home,
 * without replacing the document the way global-error does.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RouteError from './error';

const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

describe('RouteError', () => {
  it('shows the recovery UI and retries via reset()', () => {
    const reset = vi.fn();
    render(<RouteError error={new Error('boom')} reset={reset} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('offers a way back home', () => {
    render(<RouteError error={new Error('boom')} reset={() => {}} />);
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
  });

  it('logs the error for diagnostics', () => {
    const err = new Error('boom');
    render(<RouteError error={err} reset={() => {}} />);
    expect(consoleError).toHaveBeenCalledWith(err);
  });
});
