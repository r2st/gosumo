import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEAD_FILTERS,
  filterLeads,
  hasActiveLeadFilters,
  leadMatchesFilters,
  NORTH_STAR_GOAL,
  visitsPer100Leads,
  type LeadFilterState,
} from './realty-ui';
import type { Lead, LeadSource, LeadTemperature } from './realty-types';

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
    source: 'PORTAL' as LeadSource,
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
    temperature: 'WARM' as LeadTemperature,
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

const withFilters = (partial: Partial<LeadFilterState>): LeadFilterState => ({
  ...DEFAULT_LEAD_FILTERS,
  ...partial,
});

describe('leadMatchesFilters', () => {
  it('matches everything with the default (empty) filter state', () => {
    expect(leadMatchesFilters(makeLead(), DEFAULT_LEAD_FILTERS)).toBe(true);
  });

  it('filters by temperature', () => {
    const hot = makeLead({ temperature: 'HOT' });
    expect(leadMatchesFilters(hot, withFilters({ temperature: 'HOT' }))).toBe(true);
    expect(leadMatchesFilters(hot, withFilters({ temperature: 'COLD' }))).toBe(false);
  });

  it('searches by name (case-insensitive)', () => {
    const lead = makeLead({ name: 'Rahul Mehta' });
    expect(leadMatchesFilters(lead, withFilters({ search: 'rahul' }))).toBe(true);
    expect(leadMatchesFilters(lead, withFilters({ search: 'MEHTA' }))).toBe(true);
    expect(leadMatchesFilters(lead, withFilters({ search: 'asha' }))).toBe(false);
  });

  it('searches by phone, ignoring spaces', () => {
    const lead = makeLead({ whatsappPhone: '+91 98000 12345', name: null });
    expect(leadMatchesFilters(lead, withFilters({ search: '9800012345' }))).toBe(true);
    expect(leadMatchesFilters(lead, withFilters({ search: '98000 12345' }))).toBe(true);
    expect(leadMatchesFilters(lead, withFilters({ search: '77777' }))).toBe(false);
  });

  it('maps the Meta source bucket to META_LEAD_AD', () => {
    const meta = makeLead({ source: 'META_LEAD_AD' });
    const portal = makeLead({ source: 'PORTAL' });
    expect(leadMatchesFilters(meta, withFilters({ sourceKey: 'META' }))).toBe(true);
    expect(leadMatchesFilters(portal, withFilters({ sourceKey: 'META' }))).toBe(false);
  });

  it('groups walk-in / manual / CTWA under the Direct bucket', () => {
    for (const source of ['CTWA', 'WALK_IN', 'MANUAL', 'IVR'] as LeadSource[]) {
      expect(leadMatchesFilters(makeLead({ source }), withFilters({ sourceKey: 'DIRECT' }))).toBe(true);
    }
    expect(leadMatchesFilters(makeLead({ source: 'PORTAL' }), withFilters({ sourceKey: 'DIRECT' }))).toBe(false);
  });

  it('filters by assigned agent and by unassigned', () => {
    const assigned = makeLead({ assignedAgentId: 'agent-7' });
    const unassigned = makeLead({ assignedAgentId: null });
    expect(leadMatchesFilters(assigned, withFilters({ agentId: 'agent-7' }))).toBe(true);
    expect(leadMatchesFilters(assigned, withFilters({ agentId: 'agent-9' }))).toBe(false);
    expect(leadMatchesFilters(unassigned, withFilters({ agentId: 'UNASSIGNED' }))).toBe(true);
    expect(leadMatchesFilters(assigned, withFilters({ agentId: 'UNASSIGNED' }))).toBe(false);
  });

  it('combines filters (AND semantics)', () => {
    const lead = makeLead({ name: 'Priya', temperature: 'HOT', source: 'PORTAL' });
    expect(
      leadMatchesFilters(lead, withFilters({ search: 'priya', temperature: 'HOT', sourceKey: 'PORTAL' })),
    ).toBe(true);
    expect(
      leadMatchesFilters(lead, withFilters({ search: 'priya', temperature: 'COLD' })),
    ).toBe(false);
  });
});

describe('filterLeads', () => {
  it('returns only matching leads', () => {
    const leads = [
      makeLead({ id: 'a', temperature: 'HOT' }),
      makeLead({ id: 'b', temperature: 'COLD' }),
      makeLead({ id: 'c', temperature: 'HOT' }),
    ];
    const out = filterLeads(leads, withFilters({ temperature: 'HOT' }));
    expect(out.map((l) => l.id)).toEqual(['a', 'c']);
  });
});

describe('hasActiveLeadFilters', () => {
  it('is false for defaults and true when any filter is set', () => {
    expect(hasActiveLeadFilters(DEFAULT_LEAD_FILTERS)).toBe(false);
    expect(hasActiveLeadFilters(withFilters({ search: 'x' }))).toBe(true);
    expect(hasActiveLeadFilters(withFilters({ temperature: 'HOT' }))).toBe(true);
    expect(hasActiveLeadFilters(withFilters({ sourceKey: 'CSV' }))).toBe(true);
    expect(hasActiveLeadFilters(withFilters({ agentId: 'agent-1' }))).toBe(true);
  });
});

describe('visitsPer100Leads', () => {
  it('computes the ratio', () => {
    expect(visitsPer100Leads(8, 100)).toBe(8);
    expect(visitsPer100Leads(12, 150)).toBe(8);
    expect(visitsPer100Leads(5, 200)).toBe(2.5);
  });

  it('returns 0 when there are no leads (no divide-by-zero)', () => {
    expect(visitsPer100Leads(3, 0)).toBe(0);
  });

  it('has a goal of 8', () => {
    expect(NORTH_STAR_GOAL).toBe(8);
  });
});
