import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Lead } from '@/lib/realty-types';

// The page pulls leads through these hooks; mock them so we can drive the
// client-side filtering and mobile list view deterministically.
function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'l1',
    businessId: 'b1',
    assignedAgentId: null,
    conversationId: null,
    clientId: null,
    whatsappPhone: '+919800000001',
    altPhone: null,
    email: null,
    name: 'Asha Rao',
    languagePref: 'en',
    source: 'PORTAL',
    subSource: null,
    listingRef: null,
    firstTouchAt: '2026-07-01T00:00:00.000Z',
    bltc: {
      budgetMinPaise: null,
      budgetMaxPaise: null,
      localities: [],
      timelineMonths: null,
      config: null,
      purpose: null,
      financing: null,
    },
    qualScore: 50,
    temperature: 'WARM',
    stage: 'NEW',
    matchedUnitIds: [],
    extractedFacts: [],
    objections: [],
    promises: [],
    optOut: false,
    shareConsent: false,
    exchangeStatus: 'NONE',
    nextFollowupAt: null,
    lastActivityAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const LEADS = [
  makeLead({ id: 'a', name: 'Asha Rao', whatsappPhone: '+919800000001', temperature: 'HOT', stage: 'NEW' }),
  makeLead({ id: 'b', name: 'Rahul Mehta', whatsappPhone: '+919811122233', temperature: 'COLD', stage: 'QUALIFIED' }),
];

vi.mock('@/hooks/use-realty', () => ({
  useLeads: () => ({
    data: { data: LEADS, pagination: { total: LEADS.length } },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useLeadBoard: () => ({ data: [], isLoading: false, isError: false, refetch: vi.fn() }),
}));

vi.mock('@/hooks/use-settings', () => ({
  useTeam: () => ({ data: { data: [] }, isLoading: false, isError: false }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The dossier drawer is not under test.
vi.mock('@/components/leads/lead-dossier', () => ({ LeadDossier: () => null }));

import LeadsPage from './page';

describe('LeadsPage filtering', () => {
  it('shows all leads by default', () => {
    render(<LeadsPage />);
    expect(screen.getAllByText('Asha Rao').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Rahul Mehta').length).toBeGreaterThan(0);
  });

  it('filters by search on name', () => {
    render(<LeadsPage />);
    fireEvent.change(screen.getByLabelText('Search leads'), { target: { value: 'asha' } });
    expect(screen.getAllByText('Asha Rao').length).toBeGreaterThan(0);
    expect(screen.queryByText('Rahul Mehta')).toBeNull();
  });

  it('filters by phone number', () => {
    render(<LeadsPage />);
    fireEvent.change(screen.getByLabelText('Search leads'), { target: { value: '9811122233' } });
    expect(screen.getAllByText('Rahul Mehta').length).toBeGreaterThan(0);
    expect(screen.queryByText('Asha Rao')).toBeNull();
  });

  it('filters by temperature pill', () => {
    render(<LeadsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Hot' }));
    expect(screen.getAllByText('Asha Rao').length).toBeGreaterThan(0);
    expect(screen.queryByText('Rahul Mehta')).toBeNull();
  });

  it('shows an empty state when no leads match', () => {
    render(<LeadsPage />);
    fireEvent.change(screen.getByLabelText('Search leads'), { target: { value: 'nobody' } });
    expect(screen.getByText('No matching leads')).toBeInTheDocument();
  });

  it('renders the mobile stage tab bar', () => {
    render(<LeadsPage />);
    expect(screen.getByRole('tablist', { name: 'Pipeline stages' })).toBeInTheDocument();
  });
});
