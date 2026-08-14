import { render, screen } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { QueryProvider } from './query-provider';

function ClientProbe({ onReady }: { onReady: (client: ReturnType<typeof useQueryClient>) => void }) {
  onReady(useQueryClient());
  return <span data-testid="ready">ok</span>;
}

function renderProvider() {
  let client!: ReturnType<typeof useQueryClient>;
  const view = render(
    <QueryProvider>
      <ClientProbe
        onReady={(c) => {
          client = c;
        }}
      />
    </QueryProvider>,
  );
  return { ...view, client };
}

describe('QueryProvider', () => {
  it('renders children under a query client', () => {
    const { client } = renderProvider();
    expect(screen.getByTestId('ready')).toBeInTheDocument();
    expect(client).toBeDefined();
  });

  it('keeps the same client across re-renders', () => {
    // The client is created in a `useState` initialiser precisely so a parent
    // re-render does not throw away every cached query.
    const clients: unknown[] = [];
    const view = render(
      <QueryProvider>
        <ClientProbe onReady={(c) => clients.push(c)} />
      </QueryProvider>,
    );
    view.rerender(
      <QueryProvider>
        <ClientProbe onReady={(c) => clients.push(c)} />
      </QueryProvider>,
    );
    expect(clients.length).toBeGreaterThan(1);
    expect(new Set(clients).size).toBe(1);
  });

  describe('default query options', () => {
    it('holds data fresh for 30s, so tab-switching does not restorm the API', () => {
      const { client } = renderProvider();
      expect(client.getDefaultOptions().queries?.staleTime).toBe(30_000);
    });

    it('does not refetch on window focus', () => {
      const { client } = renderProvider();
      expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
    });
  });

  describe('retry policy', () => {
    function retryFn() {
      const { client } = renderProvider();
      const retry = client.getDefaultOptions().queries?.retry;
      expect(typeof retry).toBe('function');
      return retry as (failureCount: number, error: unknown) => boolean;
    }

    it('never retries 401, 403 or 404', () => {
      // Retrying an auth or permission failure just burns three round-trips
      // before showing the same error — and can mask an expired session.
      const retry = retryFn();
      for (const status of [401, 403, 404]) {
        expect(retry(0, { status })).toBe(false);
      }
    });

    it('retries a transient failure twice, then gives up', () => {
      const retry = retryFn();
      expect(retry(0, { status: 500 })).toBe(true);
      expect(retry(1, { status: 500 })).toBe(true);
      expect(retry(2, { status: 500 })).toBe(false);
    });

    it('retries an error carrying no status at all, e.g. a dropped connection', () => {
      const retry = retryFn();
      expect(retry(0, new Error('Network request failed'))).toBe(true);
    });

    it('does not throw on a null error', () => {
      const retry = retryFn();
      expect(retry(0, null)).toBe(true);
    });

    it('retries other 4xx statuses, which may be transient at a proxy', () => {
      const retry = retryFn();
      expect(retry(0, { status: 429 })).toBe(true);
    });
  });

  it('does not log a React error while mounting', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderProvider();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
