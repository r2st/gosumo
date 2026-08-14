import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Lead } from '@/lib/realty-types';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Controllable, because two of the page's branches turn on them: a null
// `useParams` (the route segment not yet resolved) and the router push behind
// the not-found escape hatch.
const useParams = vi.fn<[], { leadId: string } | null>(() => ({ leadId: 'lead-1' }));
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => useParams(),
  useRouter: () => ({ push, replace: vi.fn() }),
}));

const noopMutation = { mutate: vi.fn(), isPending: false, isError: false };

const useLead = vi.fn();
vi.mock('@/hooks/use-realty', () => ({
  useLead: () => useLead(),
  useLeadVisits: () => ({ data: { data: [] }, isLoading: false, isError: false }),
  useMatchForLead: () => ({ ...noopMutation, data: [] }),
  useAssignLead: () => noopMutation,
  useEnrollCadence: () => noopMutation,
  useTransitionStage: () => noopMutation,
  useUpdateLead: () => noopMutation,
}));

vi.mock('@/hooks/use-settings', () => ({
  useTeam: () => ({ data: { data: [] }, isLoading: false }),
}));

vi.mock('@/providers/toast-provider', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

// The page's action bar is role-gated (see @/hooks/use-permissions), so the
// tests need a session. Without a provider the hook correctly reports
// read-only and every write control disappears — which is its own test, in
// src/__tests__/viewer-gating.test.tsx.
const authValue = {
  status: 'authenticated' as const,
  user: {
    id: 'u1',
    email: 'staff@acme.in',
    name: 'Staff',
    role: 'OWNER' as const,
    businessId: 'biz-1',
    twoFactorEnabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  business: null,
};
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => authValue,
  useOptionalAuth: () => authValue,
}));

import LeadDetailPage from './page';

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    businessId: 'biz-1',
    assignedAgentId: null,
    conversationId: null,
    clientId: null,
    whatsappPhone: '+919876543210',
    altPhone: null,
    email: 'rahul@example.com',
    name: 'Rahul M',
    languagePref: 'en',
    source: 'PORTAL',
    subSource: null,
    listingRef: null,
    firstTouchAt: '2026-06-01T10:00:00.000Z',
    bltc: {
      budgetMinPaise: 8_000_000_00,
      budgetMaxPaise: 9_000_000_00,
      localities: ['Baner'],
      timelineMonths: 6,
      config: '2BHK',
      purpose: 'END_USE',
      financing: 'PREAPPROVED',
    },
    qualScore: 62,
    temperature: 'WARM',
    stage: 'QUALIFIED',
    matchedUnitIds: [],
    extractedFacts: [],
    objections: [],
    promises: [],
    optOut: false,
    shareConsent: false,
    exchangeStatus: 'NONE',
    nextFollowupAt: null,
    lastActivityAt: null,
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-04T09:00:00.000Z',
    ...overrides,
  };
}

describe('LeadDetailPage', () => {
  it('renders the lead header, breadcrumb, BLTC, and action buttons', () => {
    useLead.mockReturnValue({
      data: makeLead(),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<LeadDetailPage />);

    // Breadcrumb + name
    expect(screen.getByText('Leads')).toBeInTheDocument();
    expect(screen.getAllByText('Rahul M').length).toBeGreaterThan(0);

    // Contact + stage + score
    expect(screen.getByText('+919876543210')).toBeInTheDocument();
    expect(screen.getByText('rahul@example.com')).toBeInTheDocument();
    expect(screen.getByText('Qualified')).toBeInTheDocument();
    expect(screen.getByText('62')).toBeInTheDocument();

    // BLTC captured value
    expect(screen.getByText('Baner')).toBeInTheDocument();

    // Actions
    expect(screen.getByText('Assign agent')).toBeInTheDocument();
    expect(screen.getByText('Change stage')).toBeInTheDocument();
    expect(screen.getByText('Book visit')).toBeInTheDocument();
    expect(screen.getByText('Start cadence')).toBeInTheDocument();
  });

  it('shows a loading state while the lead is being fetched', () => {
    useLead.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    render(<LeadDetailPage />);
    expect(screen.getByText('Loading lead…')).toBeInTheDocument();
  });

  it('shows a not-found state when the lead does not exist', () => {
    useLead.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<LeadDetailPage />);
    expect(screen.getByText('Lead not found')).toBeInTheDocument();
  });

  it('routes back to the pipeline from the not-found state', () => {
    // The only way out of this state — without it the operator is stranded on
    // a page with no content and no navigation but the breadcrumb.
    useLead.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<LeadDetailPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Back to pipeline' }));
    expect(push).toHaveBeenCalledWith('/leads');
  });

  it('shows an error state, with the error, when the fetch fails', () => {
    useLead.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
      refetch: vi.fn(),
    });
    render(<LeadDetailPage />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // ErrorState prefers the thrown error over the page's fallback copy, so
    // the operator sees the specific cause rather than one generic sentence.
    expect(screen.getByText('boom')).toBeInTheDocument();
    // A failed load must not be mistaken for a deleted lead.
    expect(screen.queryByText('Lead not found')).not.toBeInTheDocument();
  });

  it('refetches when the error state is retried', () => {
    const refetch = vi.fn();
    useLead.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('boom'),
      refetch,
    });
    render(<LeadDetailPage />);

    fireEvent.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('titles the breadcrumb "Loading…" while fetching and "Lead" when there is none', () => {
    useLead.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });
    const { unmount } = render(<LeadDetailPage />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    unmount();

    // Settled with no lead: the breadcrumb still needs a label, and "Loading…"
    // there would claim a fetch that has already finished.
    useLead.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });
    render(<LeadDetailPage />);
    expect(screen.getByText('Lead')).toBeInTheDocument();
  });

  it('asks for no lead at all when the route param is not resolved yet', () => {
    // `useParams()` is null on the first render of a dynamic segment. Passing
    // `undefined` through as an id would fetch `/leads/undefined`.
    useParams.mockReturnValueOnce(null);
    useLead.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: vi.fn() });

    render(<LeadDetailPage />);
    expect(screen.getByText('Loading lead…')).toBeInTheDocument();
  });
});

/**
 * A lead ingested from a missed call or an IVR drop-off has a phone and
 * nothing else — no name at all. The header renders it in three places (the
 * avatar initials, the heading, and the document flow around them), each
 * through the same `?? 'Unknown buyer'`. An opted-out lead is the other shape
 * worth pinning: the badge is the operator's only warning not to message.
 */
describe('LeadDetailPage on a bare lead record', () => {
  it('labels a lead with no name and flags an opt-out', () => {
    useLead.mockReturnValue({
      data: makeLead({ name: null, optOut: true }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<LeadDetailPage />);

    // Heading and avatar both fall back rather than rendering empty.
    expect(screen.getByRole('heading', { name: 'Unknown buyer' })).toBeInTheDocument();
    expect(screen.getAllByText('Unknown buyer').length).toBeGreaterThan(0);
    expect(screen.getByText('Opted out')).toBeInTheDocument();
  });

  it('shows no opt-out badge on a contactable lead', () => {
    useLead.mockReturnValue({
      data: makeLead({ optOut: false }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<LeadDetailPage />);

    expect(screen.queryByText('Opted out')).toBeNull();
  });
});
