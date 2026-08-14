/**
 * `use-analytics.ts` — the reports screens.
 *
 * Every hook here is read-only and takes a date range, so the risk is
 * concentrated in two places.
 *
 * **The `-full` cache keys.** `useConversationReportFull` and
 * `useRevenueReportFull` hit the *same* endpoints as `useConversationReport` and
 * `useRevenueReport` in `use-queries.ts`, but expect richer payloads — the agent
 * leaderboard and the fulfillment mix. They avoid a collision by keying on
 * `'conversations-full'` rather than `'conversations'`. Drop the suffix and the
 * reports page renders whichever version the dashboard happened to fetch first,
 * with the leaderboard silently missing.
 *
 * **The range in the URL.** A report is only ever as right as its date range,
 * and a dropped `from` quietly widens a "this week" chart to all time.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryHarness, type QueryHarness } from '@/__tests__/query-harness';
import * as hooks from './use-analytics';

vi.mock('@/lib/api-client', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const RANGE = { from: '2026-08-01', to: '2026-08-14' };

let h: QueryHarness;

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ series: [] });
  h = createQueryHarness();
});

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

describe('report hooks request the documented endpoint with the chosen range', () => {
  it.each([
    {
      name: 'useAutonomyReport',
      run: () => hooks.useAutonomyReport(RANGE),
      url: '/analytics/autonomy?from=2026-08-01&to=2026-08-14',
    },
    {
      name: 'useClientReport',
      run: () => hooks.useClientReport(RANGE),
      url: '/analytics/clients?from=2026-08-01&to=2026-08-14',
    },
    {
      name: 'useConversationReportFull',
      run: () => hooks.useConversationReportFull(RANGE),
      url: '/analytics/conversations?from=2026-08-01&to=2026-08-14',
    },
    {
      name: 'useRevenueReportFull',
      run: () => hooks.useRevenueReportFull(RANGE),
      url: '/analytics/revenue?from=2026-08-01&to=2026-08-14',
    },
  ])('$name → $url', async ({ run, url }) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
  });

  it('renders before a range is picked without sending "undefined"', async () => {
    // The reports page mounts with an empty range while the picker initialises.
    // `from=undefined` would be parsed as a literal and reject or return
    // nothing; an omitted `from` is a valid "all time".
    const { result } = renderHook(() => hooks.useAutonomyReport({} as never), {
      wrapper: h.wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/analytics/autonomy');
  });

  it('keeps a half-filled range rather than dropping the whole thing', async () => {
    const { result } = renderHook(
      () => hooks.useClientReport({ from: '2026-08-01' } as never),
      { wrapper: h.wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/analytics/clients?from=2026-08-01');
  });
});

describe('the reports cache is keyed on the range', () => {
  it('refetches when the operator changes the period', async () => {
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) => hooks.useRevenueReportFull({ from, to: '2026-08-14' }),
      { wrapper: h.wrapper, initialProps: { from: '2026-08-01' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ from: '2026-07-01' });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));

    expect(apiRequest.mock.calls[1]![0]).toBe(
      '/analytics/revenue?from=2026-07-01&to=2026-08-14',
    );
  });

  it('serves a period already viewed from cache', async () => {
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) => hooks.useRevenueReportFull({ from, to: '2026-08-14' }),
      { wrapper: h.wrapper, initialProps: { from: '2026-08-01' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ from: '2026-08-01' });

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});

describe('the `-full` reports do not collide with the dashboard’s lighter ones', () => {
  it.each([
    ['conversations', () => hooks.useConversationReportFull(RANGE), 'conversations-full'],
    ['revenue', () => hooks.useRevenueReportFull(RANGE), 'revenue-full'],
  ])(
    'the %s report caches under `%s`, not the shared name',
    async (_endpoint, run, expectedSegment) => {
      // `use-queries.ts` caches the same endpoint under
      // ['analytics','conversations',params] for the dashboard tiles, which do
      // not request the agent leaderboard. Sharing the key would serve the
      // reports page whichever payload arrived first — most visibly as a
      // leaderboard that renders empty for no apparent reason.
      const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper: h.wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      const keys = h.queryClient
        .getQueryCache()
        .findAll({ queryKey: ['analytics'] })
        .map((q) => q.queryKey);
      expect(keys).toEqual([['analytics', expectedSegment, RANGE]]);
    },
  );

  it('keeps the extra fields the fuller report asked for', async () => {
    apiRequest.mockResolvedValueOnce({
      totalConversations: 42,
      agentPerformance: [{ userId: 'u1', resolved: 12 }],
    });
    const { result } = renderHook(() => hooks.useConversationReportFull(RANGE), {
      wrapper: h.wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({
      agentPerformance: [{ userId: 'u1', resolved: 12 }],
    });
  });
});

// ─────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────

describe('useExportReport', () => {
  it('posts the export request whole', async () => {
    const body: hooks.ExportReportRequest = {
      reportType: 'REVENUE',
      format: 'CSV',
      from: RANGE.from,
      to: RANGE.to,
    };
    const { result } = renderHook(() => hooks.useExportReport(), { wrapper: h.wrapper });

    await result.current.mutateAsync(body as never);

    expect(apiRequest).toHaveBeenCalledWith('/analytics/reports/export', { method: 'POST', body });
  });

  it('returns the job handle the caller polls on', async () => {
    // Exports run async; the response is a job id, not a file. Losing it means
    // the download never appears and the operator has no way to ask again.
    apiRequest.mockResolvedValueOnce({ jobId: 'job-1', estimatedSeconds: 12 });
    const { result } = renderHook(() => hooks.useExportReport(), { wrapper: h.wrapper });

    const res = await result.current.mutateAsync({
      reportType: 'CLIENTS',
      format: 'PDF',
      from: RANGE.from,
      to: RANGE.to,
    } as never);

    expect(res).toEqual({ jobId: 'job-1', estimatedSeconds: 12 });
  });

  it('touches no cache, because queueing an export changes no report', async () => {
    const { result } = renderHook(() => hooks.useExportReport(), { wrapper: h.wrapper });

    await result.current.mutateAsync({
      reportType: 'CONVERSATIONS',
      format: 'CSV',
      from: RANGE.from,
      to: RANGE.to,
    } as never);

    expect(h.invalidateSpy).not.toHaveBeenCalled();
    expect(h.setQueryDataSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed report lands in the error state with the original error', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useAutonomyReport(RANGE), { wrapper: h.wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('one failed report leaves the others on the page intact', async () => {
    // The reports page mounts several at once. A shared error state would blank
    // charts that loaded fine.
    apiRequest.mockRejectedValueOnce(new Error('500 Report timed out'));
    const failing = renderHook(() => hooks.useAutonomyReport(RANGE), { wrapper: h.wrapper });
    const healthy = renderHook(() => hooks.useClientReport(RANGE), { wrapper: h.wrapper });

    await waitFor(() => expect(failing.result.current.isError).toBe(true));
    await waitFor(() => expect(healthy.result.current.isSuccess).toBe(true));
  });

  it('a rejected export rejects to the caller', async () => {
    apiRequest.mockRejectedValueOnce(new Error('429 Too many exports'));
    const { result } = renderHook(() => hooks.useExportReport(), { wrapper: h.wrapper });

    await expect(
      result.current.mutateAsync({
        reportType: 'REVENUE',
        format: 'CSV',
        from: RANGE.from,
        to: RANGE.to,
      } as never),
    ).rejects.toThrow('429 Too many exports');
  });
});
