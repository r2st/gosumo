/**
 * Shared scaffolding for the React Query hook tests.
 *
 * Every hook file in `src/hooks` is the same shape — a thin wrapper that turns
 * a URL into a `useQuery`, or a request plus a set of cache keys to invalidate
 * into a `useMutation`. Testing them means the same four things every time: a
 * `QueryClientProvider` around `renderHook`, retries off so one assertion is
 * one request, and spies on `invalidateQueries` / `setQueryData` so a mutation's
 * cache effects can be asserted rather than inferred.
 *
 * That boilerplate is identical across fourteen files, so it lives here once.
 * What stays in each test file is the part that is actually about that hook:
 * the endpoint, the method, the body, and the keys it refreshes.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import type { ReactNode } from 'react';

/**
 * The observer-level options a hook declares — polling and freshness.
 *
 * React Query stores these on the cached query but types `query.options` as
 * `QueryOptions`, which does not name them, so reading either off a cached
 * query is a type error. They are genuinely there at runtime; this narrows to
 * the two the hooks in this codebase set, so a test can assert "this view
 * polls" without an inline cast at every call site.
 */
export interface ObserverOptions {
  refetchInterval?: number;
  staleTime?: number;
}

/** A mutation hook, erased to the one method the request assertions call. */
export interface MutationLike {
  mutateAsync: (vars: never) => Promise<unknown>;
}

export interface QueryHarness {
  queryClient: QueryClient;
  wrapper: ({ children }: { children: ReactNode }) => JSX.Element;
  invalidateSpy: ReturnType<typeof vi.spyOn>;
  setQueryDataSpy: ReturnType<typeof vi.spyOn>;
  /** The keys a mutation asked React Query to refetch, in call order. */
  invalidatedKeys: () => unknown[][];
  /** The `[key, value]` pairs a mutation wrote straight into the cache. */
  cacheWrites: () => [unknown, unknown][];
  /** Polling and freshness options of the first cached query under `queryKey`. */
  observerOptions: (queryKey: unknown[]) => ObserverOptions | undefined;
}

/**
 * A fresh client + provider for one test. Call from `beforeEach` — sharing a
 * client between tests leaks cached results, and a hook that never fired would
 * still report `isSuccess` from the previous test's data.
 */
export function createQueryHarness(): QueryHarness {
  const queryClient = new QueryClient({
    defaultOptions: {
      // A retry here would turn one assertion into three requests and make a
      // failing test hang for the backoff instead of failing.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return {
    queryClient,
    wrapper,
    invalidateSpy,
    setQueryDataSpy,
    invalidatedKeys: () =>
      invalidateSpy.mock.calls.map((call) => (call[0] as { queryKey: unknown[] }).queryKey),
    cacheWrites: () =>
      setQueryDataSpy.mock.calls.map((call) => [call[0], call[1]] as [unknown, unknown]),
    observerOptions: (queryKey) => {
      const [query] = queryClient.getQueryCache().findAll({ queryKey });
      return query?.options as ObserverOptions | undefined;
    },
  };
}
