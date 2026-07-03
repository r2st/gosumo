import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Lead } from '@/lib/realty-types';

// ── Mocks ──────────────────────────────────────────────────────────────────
vi.mock('next/navigation', () => ({
  useParams: () => ({ leadId: 'lead-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
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
}));

vi.mock('@/hooks/use-settings', () => ({
  useTeam: () => ({ data: { data: [] }, isLoading: false }),
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
    useLead.mockReturnValue({ data: makeLead(), isLoading: false, isError: false, refetch: vi.fn() });
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
    useLead.mockReturnValue({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() });
    render(<LeadDetailPage />);
    expect(screen.getByText('Lead not found')).toBeInTheDocument();
  });
});
