import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast, type ToastVariant } from './toast-provider';

/** Exposes the dispatcher as buttons so tests drive it the way a component would. */
function ToastProbe({ onReady }: { onReady?: (api: ReturnType<typeof useToast>) => void } = {}) {
  const toast = useToast();
  onReady?.(toast);
  return (
    <div>
      <button onClick={() => toast.success('Saved')}>success</button>
      <button onClick={() => toast.error('Failed')}>error</button>
      <button onClick={() => toast.warning('Careful')}>warning</button>
      <button onClick={() => toast.info('Heads up')}>info</button>
      <button onClick={() => toast.show('info', 'Titled', { title: 'Note' })}>titled</button>
      <button onClick={() => toast.show('info', 'Sticky', { duration: 0 })}>sticky</button>
    </div>
  );
}

function renderProvider(onReady?: (api: ReturnType<typeof useToast>) => void) {
  return render(
    <ToastProvider>
      <ToastProbe onReady={onReady} />
    </ToastProvider>,
  );
}

describe('ToastProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders children', () => {
    renderProvider();
    expect(screen.getByText('success')).toBeInTheDocument();
  });

  it('shows a toast when one is dispatched', () => {
    renderProvider();
    act(() => {
      screen.getByText('success').click();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('renders each variant', () => {
    const variants: Array<[string, string]> = [
      ['success', 'Saved'],
      ['error', 'Failed'],
      ['warning', 'Careful'],
      ['info', 'Heads up'],
    ];
    for (const [button, message] of variants) {
      const { unmount } = renderProvider();
      act(() => {
        screen.getByText(button).click();
      });
      expect(screen.getByRole('status')).toHaveTextContent(message);
      unmount();
    }
  });

  it('renders an optional title above the message', () => {
    renderProvider();
    act(() => {
      screen.getByText('titled').click();
    });
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Note');
    expect(toast).toHaveTextContent('Titled');
  });

  it('stacks multiple toasts', () => {
    renderProvider();
    act(() => {
      screen.getByText('success').click();
      screen.getByText('error').click();
    });
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  it('auto-dismisses after the default 4s', () => {
    renderProvider();
    act(() => {
      screen.getByText('success').click();
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps a zero-duration toast until it is dismissed', () => {
    // Used for errors the operator must acknowledge — a 4s timeout would let a
    // failed save scroll past unnoticed.
    renderProvider();
    act(() => {
      screen.getByText('sticky').click();
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Sticky');
  });

  it('honours a custom duration', () => {
    let api!: ReturnType<typeof useToast>;
    renderProvider((a) => {
      api = a;
    });
    act(() => {
      api.show('info', 'Brief', { duration: 1000 });
    });
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('dismisses on the close button', () => {
    renderProvider();
    act(() => {
      screen.getByText('success').click();
    });
    act(() => {
      screen.getByLabelText('Dismiss notification').click();
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('dismisses only the toast asked for, leaving the others up', () => {
    let api!: ReturnType<typeof useToast>;
    renderProvider((a) => {
      api = a;
    });
    let firstId = 0;
    act(() => {
      firstId = api.show('info', 'First', { duration: 0 });
      api.show('info', 'Second', { duration: 0 });
    });
    act(() => {
      api.dismiss(firstId);
    });
    const remaining = screen.getAllByRole('status');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveTextContent('Second');
  });

  it('ignores a dismiss for an id that is already gone', () => {
    let api!: ReturnType<typeof useToast>;
    renderProvider((a) => {
      api = a;
    });
    expect(() => act(() => api.dismiss(9999))).not.toThrow();
  });

  it('hands back a distinct id per toast, so callers can dismiss their own', () => {
    let api!: ReturnType<typeof useToast>;
    renderProvider((a) => {
      api = a;
    });
    let ids: number[] = [];
    act(() => {
      ids = [api.info('a'), api.info('b'), api.info('c')];
    });
    expect(new Set(ids).size).toBe(3);
  });

  it('does not fire a pending timer after unmount', () => {
    // A timer surviving unmount would call setState on a dead tree and log a
    // React warning on every navigation away from a page that toasted.
    const { unmount } = renderProvider();
    act(() => {
      screen.getByText('success').click();
    });
    unmount();
    expect(() => act(() => vi.advanceTimersByTime(10_000))).not.toThrow();
  });

  it('exposes each variant helper on the context', () => {
    let api!: ReturnType<typeof useToast>;
    renderProvider((a) => {
      api = a;
    });
    const helpers: ToastVariant[] = ['success', 'error', 'warning', 'info'];
    for (const helper of helpers) {
      expect(typeof api[helper]).toBe('function');
    }
    expect(typeof api.show).toBe('function');
    expect(typeof api.dismiss).toBe('function');
  });

  it('announces politely, so a toast does not interrupt a screen reader mid-sentence', () => {
    renderProvider();
    act(() => {
      screen.getByText('success').click();
    });
    const live = document.querySelector('[aria-live]');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('aria-atomic', 'false');
  });
});

describe('useToast outside a provider', () => {
  it('throws rather than silently swallowing every notification', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Orphan() {
      useToast();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/must be used within a ToastProvider/);
    spy.mockRestore();
  });
});
