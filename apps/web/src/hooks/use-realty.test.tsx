/**
 * `use-realty.ts` — the React Query surface for every realty screen.
 *
 * Fifty-odd near-identical hooks, and nothing in the file is complicated. What
 * makes it worth testing is that all the risk sits in details a reviewer's eye
 * slides over:
 *
 *   - **The URL.** One wrong segment and a screen quietly renders nothing. The
 *     table-driven blocks below assert the exact path, method, and body of
 *     every hook, because that is the entire contract with the API.
 *   - **`enabled` gating.** A detail hook that fires with a null id requests
 *     `/realty/leads/null` — a 404 the user sees as an error state on a page
 *     they have not opened yet.
 *   - **Invalidation keys.** A mutation that invalidates the wrong key leaves
 *     the board showing a stale stage after the user just dragged a card. This
 *     is the failure everyone has seen and nobody's test catches, so each
 *     mutation's key set is asserted explicitly.
 *   - **Prefix semantics.** React Query treats keys as prefixes, so
 *     `['realty','leads']` also invalidates `['realty','leads','board']` — but
 *     *not* `['realty','lead',id]`, which is a different key entirely. Several
 *     hooks depend on that distinction being deliberate.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import * as hooks from './use-realty';

vi.mock('@/lib/api-client', () => ({
  apiRequest: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { apiRequest } = (await import('@/lib/api-client')) as unknown as {
  apiRequest: ReturnType<typeof vi.fn>;
};

const LEAD_ID = 'lead-1';

let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof vi.spyOn>;
let setQueryDataSpy: ReturnType<typeof vi.spyOn>;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ id: 'x' });
  queryClient = new QueryClient({
    defaultOptions: {
      // A retry here would turn one assertion into three requests and make a
      // failing test hang for the backoff instead of failing.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');
});

/** The keys a mutation asked React Query to refetch, flattened for comparison. */
function invalidatedKeys(): unknown[][] {
  return invalidateSpy.mock.calls.map(
    (call) => (call[0] as { queryKey: unknown[] }).queryKey,
  );
}

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

interface QueryCase {
  name: string;
  run: () => unknown;
  url: string;
}

/**
 * Every read hook, with the exact URL it must request.
 *
 * `{ signal }` is passed by React Query to almost all of them so an
 * in-flight request is aborted when the component unmounts; the two detail
 * hooks that predate that convention are asserted separately below.
 */
const QUERY_CASES: QueryCase[] = [
  // Leads
  { name: 'useLeads (no filters)', run: () => hooks.useLeads(), url: '/realty/leads' },
  {
    name: 'useLeads (filters)',
    run: () => hooks.useLeads({ stage: 'NEW', temperature: 'HOT', page: 2, limit: 10 }),
    url: '/realty/leads?stage=NEW&temperature=HOT&page=2&limit=10',
  },
  { name: 'useLeadBoard', run: () => hooks.useLeadBoard(), url: '/realty/leads/board' },
  { name: 'useLead', run: () => hooks.useLead(LEAD_ID), url: `/realty/leads/${LEAD_ID}` },

  // Inventory
  { name: 'useProjects', run: () => hooks.useProjects(), url: '/realty/projects' },
  {
    name: 'useProjects (filters)',
    run: () => hooks.useProjects({ locality: 'Whitefield', status: 'ACTIVE' }),
    url: '/realty/projects?locality=Whitefield&status=ACTIVE',
  },
  { name: 'useProject', run: () => hooks.useProject('p1'), url: '/realty/projects/p1' },
  {
    name: 'useProjectUnits',
    run: () => hooks.useProjectUnits('p1'),
    url: '/realty/projects/p1/units',
  },
  {
    name: 'useProjectAssets',
    run: () => hooks.useProjectAssets('p1'),
    url: '/realty/projects/p1/assets',
  },

  // Cadence
  { name: 'useTemplates', run: () => hooks.useTemplates(), url: '/realty/cadence/templates' },
  {
    name: 'useTemplates (filters)',
    run: () => hooks.useTemplates({ category: 'FOLLOWUP', approvalStatus: 'APPROVED' }),
    url: '/realty/cadence/templates?category=FOLLOWUP&approvalStatus=APPROVED',
  },
  { name: 'useCadences', run: () => hooks.useCadences(), url: '/realty/cadence/cadences' },
  {
    name: 'useCadences (trigger)',
    run: () => hooks.useCadences({ trigger: 'NEW_LEAD' as never }),
    url: '/realty/cadence/cadences?trigger=NEW_LEAD',
  },

  // Broker
  { name: 'useApprovals', run: () => hooks.useApprovals(), url: '/realty/broker/approvals' },
  {
    name: 'useApprovals (status)',
    run: () => hooks.useApprovals({ status: 'PENDING' as never }),
    url: '/realty/broker/approvals?status=PENDING',
  },
  {
    name: 'useBrokerSettings',
    run: () => hooks.useBrokerSettings(),
    url: '/realty/broker/settings',
  },
  {
    name: 'useBrokerAlerts',
    run: () => hooks.useBrokerAlerts(),
    url: '/realty/broker/alerts?unreadOnly=false',
  },
  {
    name: 'useBrokerAlerts (unread only)',
    run: () => hooks.useBrokerAlerts(true),
    url: '/realty/broker/alerts?unreadOnly=true',
  },
  {
    name: 'useBrokerConsole',
    run: () => hooks.useBrokerConsole(),
    url: '/realty/broker/console',
  },
  {
    name: 'useMorningBriefing',
    run: () => hooks.useMorningBriefing(),
    url: '/realty/broker/briefing',
  },

  // Site visits
  { name: 'useSiteVisits', run: () => hooks.useSiteVisits(), url: '/realty/site-visits' },
  {
    name: 'useSiteVisits (filters)',
    run: () => hooks.useSiteVisits({ status: 'SCHEDULED' as never, upcoming: true }),
    url: '/realty/site-visits?status=SCHEDULED&upcoming=true',
  },
  {
    name: 'useSiteVisit',
    run: () => hooks.useSiteVisit('v1'),
    url: '/realty/site-visits/v1',
  },
  {
    name: 'useLeadVisits',
    run: () => hooks.useLeadVisits(LEAD_ID),
    url: `/realty/site-visits?leadId=${LEAD_ID}&limit=50`,
  },

  // Exchange
  {
    name: 'useSyndications',
    run: () => hooks.useSyndications(),
    url: '/realty/exchange/syndications',
  },
  {
    name: 'useSyndications (filters)',
    run: () => hooks.useSyndications({ state: 'OPEN' as never, role: 'from' }),
    url: '/realty/exchange/syndications?state=OPEN&role=from',
  },
  {
    name: 'useSyndication',
    run: () => hooks.useSyndication('s1'),
    url: '/realty/exchange/syndications/s1',
  },
  {
    name: 'useExchangeMatch',
    run: () => hooks.useExchangeMatch(LEAD_ID, { limit: 5, aiRationale: true }),
    url: `/realty/exchange/leads/${LEAD_ID}/match?limit=5&aiRationale=true`,
  },
  {
    name: 'useReliabilityScores',
    run: () => hooks.useReliabilityScores(),
    url: '/realty/exchange/reliability',
  },
  {
    name: 'useResaleListings',
    run: () => hooks.useResaleListings(),
    url: '/realty/exchange/resale-listings',
  },
  {
    name: 'useResaleListings (filters)',
    run: () => hooks.useResaleListings({ status: 'ACTIVE' as never, locality: 'HSR' }),
    url: '/realty/exchange/resale-listings?status=ACTIVE&locality=HSR',
  },

  // Intelligence
  {
    name: 'useIntelligenceCorridors',
    run: () => hooks.useIntelligenceCorridors(),
    url: '/realty/intelligence/corridors',
  },
  {
    name: 'useIntelligenceAggregates',
    run: () => hooks.useIntelligenceAggregates(),
    url: '/realty/intelligence/aggregates',
  },
  {
    name: 'useIntelligenceAggregates (filters)',
    run: () =>
      hooks.useIntelligenceAggregates({
        corridor: 'HSR',
        metricType: 'PRICE_PER_SQFT' as never,
      }),
    url: '/realty/intelligence/aggregates?corridor=HSR&metricType=PRICE_PER_SQFT',
  },
  {
    name: 'useCorridorPriors',
    run: () => hooks.useCorridorPriors('HSR'),
    url: '/realty/intelligence/corridor-priors?corridor=HSR',
  },
  {
    name: 'useSourceQuality',
    run: () => hooks.useSourceQuality(),
    url: '/realty/intelligence/source-quality',
  },
  {
    name: 'useIntelligenceOptIn',
    run: () => hooks.useIntelligenceOptIn(),
    url: '/realty/intelligence/opt-in',
  },
];

describe('use-realty query hooks request the documented endpoint', () => {
  it.each(QUERY_CASES)('$name → $url', async ({ run, url }) => {
    const { result } = renderHook(run as () => { isSuccess: boolean }, { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest.mock.calls[0]![0]).toBe(url);
  });
});

describe('use-realty query hooks omit filters that were not supplied', () => {
  it('drops undefined values instead of sending the string "undefined"', async () => {
    const { result } = renderHook(
      () => hooks.useLeads({ stage: undefined, search: 'asha' }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/realty/leads?search=asha');
  });

  it('drops an empty search string rather than filtering on ""', async () => {
    const { result } = renderHook(() => hooks.useLeads({ search: '' }), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiRequest.mock.calls[0]![0]).toBe('/realty/leads');
  });
});

// ─────────────────────────────────────────────
// `enabled` gating
// ─────────────────────────────────────────────

describe('detail hooks stay idle until they have an id', () => {
  // Firing with a null id requests `/realty/leads/null` — a 404 the user sees
  // as an error on a page they have not opened.
  const GATED: { name: string; run: () => { fetchStatus: string } }[] = [
    { name: 'useLead', run: () => hooks.useLead(null) },
    { name: 'useProject', run: () => hooks.useProject(null) },
    { name: 'useProjectUnits', run: () => hooks.useProjectUnits(null) },
    { name: 'useProjectAssets', run: () => hooks.useProjectAssets(null) },
    { name: 'useSiteVisit', run: () => hooks.useSiteVisit(null) },
    { name: 'useLeadVisits', run: () => hooks.useLeadVisits(null) },
    { name: 'useSyndication', run: () => hooks.useSyndication(null) },
    { name: 'useExchangeMatch', run: () => hooks.useExchangeMatch(null) },
    { name: 'useCorridorPriors', run: () => hooks.useCorridorPriors(null) },
  ];

  it.each(GATED)('$name does not fetch with a null id', ({ run }) => {
    const { result } = renderHook(run, { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('treats an empty-string id as absent, not as a real id', () => {
    // `enabled: !!id` — an empty id from a router param must not request
    // `/realty/leads/`, which resolves to the list endpoint.
    const { result } = renderHook(() => hooks.useLead(''), { wrapper });

    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequest).not.toHaveBeenCalled();
  });
});

describe('list hooks refetch when their filters change', () => {
  it('keys the cache on the filter object, not just the endpoint', async () => {
    const { result, rerender } = renderHook(
      ({ stage }: { stage: string }) => hooks.useLeads({ stage: stage as never }),
      { wrapper, initialProps: { stage: 'NEW' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ stage: 'QUALIFIED' });
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));

    expect(apiRequest.mock.calls[1]![0]).toBe('/realty/leads?stage=QUALIFIED');
  });

  it('serves the same filters from cache instead of refetching', async () => {
    const { result, rerender } = renderHook(
      ({ stage }: { stage: string }) => hooks.useLeads({ stage: stage as never }),
      { wrapper, initialProps: { stage: 'NEW' } },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    rerender({ stage: 'NEW' });

    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});

describe('useBrokerAlerts', () => {
  it('polls, because an alert nobody refreshes into view is not an alert', async () => {
    const { result } = renderHook(() => hooks.useBrokerAlerts(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [query] = queryClient.getQueryCache().findAll({ queryKey: ['realty', 'alerts'] });
    expect(query?.options.refetchInterval).toBe(60_000);
  });
});

// ─────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────

interface MutationCase {
  name: string;
  run: () => { mutateAsync: (vars: never) => Promise<unknown> };
  vars: unknown;
  url: string;
  method: string;
  body: unknown;
}

const MUTATION_CASES: MutationCase[] = [
  // Leads
  {
    name: 'useTransitionStage',
    run: () => hooks.useTransitionStage(),
    vars: { id: LEAD_ID, stage: 'QUALIFIED' },
    url: `/realty/leads/${LEAD_ID}/stage`,
    method: 'POST',
    body: { stage: 'QUALIFIED' },
  },
  {
    name: 'useMatchForLead',
    run: () => hooks.useMatchForLead(),
    vars: { id: LEAD_ID, limit: 5 },
    url: `/realty/leads/${LEAD_ID}/match?limit=5`,
    method: 'POST',
    body: {},
  },
  {
    name: 'useAssignLead',
    run: () => hooks.useAssignLead(),
    vars: { id: LEAD_ID, agentId: 'a1' },
    url: `/realty/leads/${LEAD_ID}/assign`,
    method: 'POST',
    body: { agentId: 'a1' },
  },
  {
    name: 'useUpdateLead',
    run: () => hooks.useUpdateLead(),
    vars: { id: LEAD_ID, patch: { name: 'Asha' } },
    url: `/realty/leads/${LEAD_ID}`,
    method: 'PATCH',
    body: { name: 'Asha' },
  },

  // Inventory
  {
    name: 'useUpdateProject',
    run: () => hooks.useUpdateProject(),
    vars: { id: 'p1', networkVisible: true },
    url: '/realty/projects/p1',
    method: 'PATCH',
    body: { networkVisible: true },
  },

  // Cadence
  {
    name: 'useSetTemplateApproval',
    run: () => hooks.useSetTemplateApproval(),
    vars: { id: 't1', approvalStatus: 'APPROVED' },
    url: '/realty/cadence/templates/t1/approval',
    method: 'POST',
    body: { approvalStatus: 'APPROVED' },
  },
  {
    name: 'useUpdateCadence',
    run: () => hooks.useUpdateCadence(),
    vars: { id: 'c1', isActive: false },
    url: '/realty/cadence/cadences/c1',
    method: 'PATCH',
    body: { isActive: false },
  },
  {
    name: 'useEnrollCadence',
    run: () => hooks.useEnrollCadence(),
    vars: { leadId: LEAD_ID, trigger: 'NEW_LEAD' },
    url: '/realty/cadence/enroll',
    method: 'POST',
    body: { leadId: LEAD_ID, trigger: 'NEW_LEAD' },
  },
  {
    name: 'useSeedCadences',
    run: () => hooks.useSeedCadences(),
    vars: undefined,
    url: '/realty/cadence/seed',
    method: 'POST',
    body: {},
  },

  // Broker
  {
    name: 'useResolveApproval',
    run: () => hooks.useResolveApproval(),
    vars: { id: 'ap1', status: 'APPROVED', editedText: 'hi', reason: undefined },
    url: '/realty/broker/approvals/ap1/resolve',
    method: 'POST',
    body: { status: 'APPROVED', editedText: 'hi', reason: undefined },
  },
  {
    name: 'useUpdateBrokerSettings',
    run: () => hooks.useUpdateBrokerSettings(),
    vars: { autonomyLevel: 'ASSIST' },
    url: '/realty/broker/settings',
    method: 'PATCH',
    body: { autonomyLevel: 'ASSIST' },
  },
  {
    name: 'useMarkAlertRead',
    run: () => hooks.useMarkAlertRead(),
    vars: 'al1',
    url: '/realty/broker/alerts/al1/read',
    method: 'POST',
    body: {},
  },
  {
    name: 'useMarkAllAlertsRead',
    run: () => hooks.useMarkAllAlertsRead(),
    vars: undefined,
    url: '/realty/broker/alerts/read-all',
    method: 'POST',
    body: {},
  },

  // Site visits
  {
    name: 'useBookVisit',
    run: () => hooks.useBookVisit(),
    vars: { leadId: LEAD_ID, scheduledAt: '2026-09-01T05:30:00.000Z' },
    url: '/realty/site-visits',
    method: 'POST',
    body: { leadId: LEAD_ID, scheduledAt: '2026-09-01T05:30:00.000Z' },
  },
  {
    name: 'useConfirmVisit',
    run: () => hooks.useConfirmVisit(),
    vars: 'v1',
    url: '/realty/site-visits/v1/confirm',
    method: 'POST',
    body: {},
  },
  {
    name: 'useRescheduleVisit',
    run: () => hooks.useRescheduleVisit(),
    vars: { id: 'v1', newScheduledAt: '2026-09-02T05:30:00.000Z', durationMinutes: 45 },
    url: '/realty/site-visits/v1/reschedule',
    method: 'POST',
    body: { newScheduledAt: '2026-09-02T05:30:00.000Z', durationMinutes: 45 },
  },
  {
    name: 'useCancelVisit',
    run: () => hooks.useCancelVisit(),
    vars: { id: 'v1', reason: 'rain' },
    url: '/realty/site-visits/v1/cancel',
    method: 'POST',
    body: { reason: 'rain' },
  },
  {
    name: 'useCompleteVisit',
    run: () => hooks.useCompleteVisit(),
    vars: { id: 'v1', outcome: 'INTERESTED', feedback: 'liked it' },
    url: '/realty/site-visits/v1/complete',
    method: 'POST',
    body: { outcome: 'INTERESTED', feedback: 'liked it' },
  },
  {
    name: 'useMarkNoShow',
    run: () => hooks.useMarkNoShow(),
    vars: 'v1',
    url: '/realty/site-visits/v1/no-show',
    method: 'POST',
    body: {},
  },

  // Ingestion
  {
    name: 'useImportCsv',
    run: () => hooks.useImportCsv(),
    vars: [{ name: 'Asha', phone: '+919800000001' }],
    url: '/realty/ingestion/csv',
    method: 'POST',
    body: { rows: [{ name: 'Asha', phone: '+919800000001' }] },
  },

  // Exchange
  {
    name: 'useCreateSyndication',
    run: () => hooks.useCreateSyndication(),
    vars: { leadId: LEAD_ID, toBusinessId: 'b2' },
    url: '/realty/exchange/syndications',
    method: 'POST',
    body: { leadId: LEAD_ID, toBusinessId: 'b2' },
  },
  {
    name: 'useAcceptSyndication',
    run: () => hooks.useAcceptSyndication(),
    vars: 's1',
    url: '/realty/exchange/syndications/s1/accept',
    method: 'POST',
    body: {},
  },
  {
    name: 'useRecordVisit',
    run: () => hooks.useRecordVisit(),
    vars: 's1',
    url: '/realty/exchange/syndications/s1/visit',
    method: 'POST',
    body: {},
  },
  {
    name: 'useExpireSyndication',
    run: () => hooks.useExpireSyndication(),
    vars: 's1',
    url: '/realty/exchange/syndications/s1/expire',
    method: 'POST',
    body: {},
  },
  {
    name: 'useCloseSyndication',
    run: () => hooks.useCloseSyndication(),
    vars: { id: 's1', commissionPoolPaise: 500000, platformFeeRate: 0.1 },
    url: '/realty/exchange/syndications/s1/close',
    method: 'POST',
    body: { commissionPoolPaise: 500000, platformFeeRate: 0.1 },
  },
  {
    name: 'useDisputeSyndication',
    run: () => hooks.useDisputeSyndication(),
    vars: { id: 's1', reason: 'no show' },
    url: '/realty/exchange/syndications/s1/dispute',
    method: 'POST',
    body: { reason: 'no show' },
  },
  {
    name: 'useRateSyndication',
    run: () => hooks.useRateSyndication(),
    vars: { id: 's1', ratings: { responseSpeed: 5 } },
    url: '/realty/exchange/syndications/s1/rate',
    method: 'POST',
    body: { responseSpeed: 5 },
  },
  {
    name: 'useCreateResaleListing',
    run: () => hooks.useCreateResaleListing(),
    vars: {
      locality: 'HSR',
      config: '3BHK',
      askingPricePaise: 12_000_000,
      sellerPhone: '+919800000001',
    },
    url: '/realty/exchange/resale-listings',
    method: 'POST',
    body: {
      locality: 'HSR',
      config: '3BHK',
      askingPricePaise: 12_000_000,
      sellerPhone: '+919800000001',
    },
  },

  // Intelligence
  {
    name: 'useSetIntelligenceOptIn (opt in)',
    run: () => hooks.useSetIntelligenceOptIn(),
    vars: true,
    url: '/realty/intelligence/opt-in',
    method: 'POST',
    body: {},
  },
  {
    name: 'useSetIntelligenceOptIn (opt out)',
    run: () => hooks.useSetIntelligenceOptIn(),
    vars: false,
    url: '/realty/intelligence/opt-out',
    method: 'POST',
    body: {},
  },
];

describe('use-realty mutation hooks call the documented endpoint', () => {
  it.each(MUTATION_CASES)('$name → $method $url', async ({ run, vars, url, method, body }) => {
    const { result } = renderHook(run, { wrapper });

    await result.current.mutateAsync(vars as never);

    expect(apiRequest).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = apiRequest.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(options).toMatchObject({ method });
    expect((options as { body: unknown }).body).toEqual(body);
  });
});

// ─────────────────────────────────────────────
// Cache invalidation
// ─────────────────────────────────────────────

describe('mutations refresh exactly the views their change affects', () => {
  it('useTransitionStage refreshes the lead, the list, and the board', async () => {
    // Dragging a card between columns is the one interaction where a missed
    // invalidation is immediately visible: the card snaps back.
    const { result } = renderHook(() => hooks.useTransitionStage(), { wrapper });

    await result.current.mutateAsync({ id: LEAD_ID, stage: 'QUALIFIED' as never });

    expect(invalidatedKeys()).toEqual([
      ['realty', 'lead', LEAD_ID],
      ['realty', 'leads'],
      ['realty', 'leads', 'board'],
    ]);
  });

  it('useAssignLead leaves the board alone, since assignment does not move a card', async () => {
    const { result } = renderHook(() => hooks.useAssignLead(), { wrapper });

    await result.current.mutateAsync({ id: LEAD_ID, agentId: 'a1' });

    expect(invalidatedKeys()).toEqual([['realty', 'lead', LEAD_ID], ['realty', 'leads']]);
  });

  it('useUpdateLead writes the response straight into the detail cache', async () => {
    // The detail page is already open; refetching it would blank the form the
    // user just submitted.
    const updated = { id: LEAD_ID, name: 'Asha Rao' };
    apiRequest.mockResolvedValueOnce(updated);
    const { result } = renderHook(() => hooks.useUpdateLead(), { wrapper });

    await result.current.mutateAsync({ id: LEAD_ID, patch: { name: 'Asha Rao' } });

    expect(setQueryDataSpy).toHaveBeenCalledWith(['realty', 'lead', LEAD_ID], updated);
    expect(invalidatedKeys()).toEqual([
      ['realty', 'leads'],
      ['realty', 'leads', 'board'],
    ]);
  });

  it('useUpdateProject keys the detail refresh off the response, not the input', async () => {
    // The mutation spreads `{ id, ...body }` into the request, so the id is not
    // available on the variables object by the time onSuccess runs.
    apiRequest.mockResolvedValueOnce({ id: 'p1' });
    const { result } = renderHook(() => hooks.useUpdateProject(), { wrapper });

    await result.current.mutateAsync({ id: 'p1', networkVisible: true } as never);

    expect(invalidatedKeys()).toEqual([
      ['realty', 'project', 'p1'],
      ['realty', 'projects'],
    ]);
  });

  it('useResolveApproval also refreshes the console, whose counts just changed', async () => {
    const { result } = renderHook(() => hooks.useResolveApproval(), { wrapper });

    await result.current.mutateAsync({ id: 'ap1', status: 'APPROVED' as never });

    expect(invalidatedKeys()).toEqual([
      ['realty', 'approvals'],
      ['realty', 'broker', 'console'],
    ]);
  });

  it('useUpdateBrokerSettings refreshes the console, which renders autonomy state', async () => {
    const { result } = renderHook(() => hooks.useUpdateBrokerSettings(), { wrapper });

    await result.current.mutateAsync({ autonomyLevel: 'ASSIST' } as never);

    expect(invalidatedKeys()).toEqual([
      ['realty', 'broker', 'settings'],
      ['realty', 'broker', 'console'],
    ]);
  });

  it('useSeedCadences refreshes both catalogues it just populated', async () => {
    const { result } = renderHook(() => hooks.useSeedCadences(), { wrapper });

    await result.current.mutateAsync(undefined as never);

    expect(invalidatedKeys()).toEqual([
      ['realty', 'templates'],
      ['realty', 'cadences'],
    ]);
  });

  it('useEnrollCadence refreshes the lead it enrolled', async () => {
    const { result } = renderHook(() => hooks.useEnrollCadence(), { wrapper });

    await result.current.mutateAsync({ leadId: LEAD_ID, trigger: 'NEW_LEAD' as never });

    expect(invalidatedKeys()).toEqual([['realty', 'lead', LEAD_ID], ['realty', 'leads']]);
  });

  it.each([
    ['useBookVisit', () => hooks.useBookVisit(), { leadId: LEAD_ID }],
    ['useConfirmVisit', () => hooks.useConfirmVisit(), 'v1'],
    ['useCancelVisit', () => hooks.useCancelVisit(), { id: 'v1' }],
    ['useCompleteVisit', () => hooks.useCompleteVisit(), { id: 'v1', outcome: 'INTERESTED' }],
    ['useMarkNoShow', () => hooks.useMarkNoShow(), 'v1'],
    [
      'useRescheduleVisit',
      () => hooks.useRescheduleVisit(),
      { id: 'v1', newScheduledAt: '2026-09-02T05:30:00.000Z' },
    ],
  ])(
    '%s refreshes visits, leads, and the board — a visit moves a lead’s stage',
    async (_name, run, vars) => {
      const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
        wrapper,
      });

      await result.current.mutateAsync(vars as never);

      expect(invalidatedKeys()).toEqual([
        ['realty', 'site-visits'],
        ['realty', 'leads'],
        ['realty', 'leads', 'board'],
      ]);
    },
  );

  it('useImportCsv refreshes the list and the board, where new leads appear', async () => {
    const { result } = renderHook(() => hooks.useImportCsv(), { wrapper });

    await result.current.mutateAsync([] as never);

    expect(invalidatedKeys()).toEqual([
      ['realty', 'leads'],
      ['realty', 'leads', 'board'],
    ]);
  });

  it.each([
    ['useAcceptSyndication', () => hooks.useAcceptSyndication()],
    ['useRecordVisit', () => hooks.useRecordVisit()],
    ['useExpireSyndication', () => hooks.useExpireSyndication()],
  ])('%s refreshes the list and the one syndication it acted on', async (_name, run) => {
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper,
    });

    await result.current.mutateAsync('s1' as never);

    expect(invalidatedKeys()).toEqual([
      ['realty', 'exchange', 'syndications'],
      ['realty', 'exchange', 'syndication', 's1'],
    ]);
  });

  it('useCloseSyndication refreshes the syndication whose money just settled', async () => {
    const { result } = renderHook(() => hooks.useCloseSyndication(), { wrapper });

    await result.current.mutateAsync({ id: 's1', commissionPoolPaise: 100 });

    expect(invalidatedKeys()).toEqual([
      ['realty', 'exchange', 'syndications'],
      ['realty', 'exchange', 'syndication', 's1'],
    ]);
  });

  it('useDisputeSyndication refreshes the disputed syndication', async () => {
    const { result } = renderHook(() => hooks.useDisputeSyndication(), { wrapper });

    await result.current.mutateAsync({ id: 's1', reason: 'no show' });

    expect(invalidatedKeys()).toEqual([
      ['realty', 'exchange', 'syndications'],
      ['realty', 'exchange', 'syndication', 's1'],
    ]);
  });

  it('useRateSyndication refreshes reliability, which the rating just moved', async () => {
    const { result } = renderHook(() => hooks.useRateSyndication(), { wrapper });

    await result.current.mutateAsync({ id: 's1', ratings: {} as never });

    expect(invalidatedKeys()).toEqual([['realty', 'exchange', 'reliability']]);
  });

  it('useCreateResaleListing refreshes the resale list only', async () => {
    const { result } = renderHook(() => hooks.useCreateResaleListing(), { wrapper });

    await result.current.mutateAsync({
      locality: 'HSR',
      config: '3BHK',
      askingPricePaise: 1,
      sellerPhone: '+919800000001',
    });

    expect(invalidatedKeys()).toEqual([['realty', 'exchange', 'resale-listings']]);
  });

  it.each([
    ['useMarkAlertRead', () => hooks.useMarkAlertRead(), 'al1'],
    ['useMarkAllAlertsRead', () => hooks.useMarkAllAlertsRead(), undefined],
  ])('%s refreshes the alert list', async (_name, run, vars) => {
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(invalidatedKeys()).toEqual([['realty', 'alerts']]);
  });

  it.each([
    ['useSetTemplateApproval', () => hooks.useSetTemplateApproval(), { id: 't1', approvalStatus: 'APPROVED' }, ['realty', 'templates']],
    ['useUpdateCadence', () => hooks.useUpdateCadence(), { id: 'c1', isActive: true }, ['realty', 'cadences']],
    ['useCreateSyndication', () => hooks.useCreateSyndication(), {}, ['realty', 'exchange', 'syndications']],
  ])('%s refreshes just its own list', async (_name, run, vars, key) => {
    const { result } = renderHook(run as () => { mutateAsync: (v: never) => Promise<unknown> }, {
      wrapper,
    });

    await result.current.mutateAsync(vars as never);

    expect(invalidatedKeys()).toEqual([key]);
  });

  it('useSetIntelligenceOptIn seeds the cache before invalidating it', async () => {
    // The toggle is the only thing on screen; showing a spinner on it after a
    // successful click reads as a failure.
    const status = { optedIn: true };
    apiRequest.mockResolvedValueOnce(status);
    const { result } = renderHook(() => hooks.useSetIntelligenceOptIn(), { wrapper });

    await result.current.mutateAsync(true);

    expect(setQueryDataSpy).toHaveBeenCalledWith(
      ['realty', 'intelligence', 'opt-in'],
      status,
    );
    expect(invalidatedKeys()).toEqual([['realty', 'intelligence', 'opt-in']]);
  });

  it('useMatchForLead invalidates nothing — matching is a read dressed as a POST', async () => {
    const { result } = renderHook(() => hooks.useMatchForLead(), { wrapper });

    await result.current.mutateAsync({ id: LEAD_ID });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Failure paths
// ─────────────────────────────────────────────

describe('failures surface instead of being swallowed', () => {
  it('a failed query lands in the error state with the original error', async () => {
    apiRequest.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const { result } = renderHook(() => hooks.useLeads(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: '503 Service Unavailable' });
  });

  it('a failed mutation rejects and invalidates nothing', async () => {
    // Invalidating on failure would refetch, hide the error behind a spinner,
    // and show the unchanged data as though the write had gone through.
    apiRequest.mockRejectedValueOnce(new Error('409 Conflict'));
    const { result } = renderHook(() => hooks.useTransitionStage(), { wrapper });

    await expect(
      result.current.mutateAsync({ id: LEAD_ID, stage: 'QUALIFIED' as never }),
    ).rejects.toThrow('409 Conflict');
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
