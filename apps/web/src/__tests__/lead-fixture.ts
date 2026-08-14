/**
 * A canonical `Lead` for component tests.
 *
 * `Lead` has ~28 required fields, most of which any given test does not care
 * about, so every lead test file grew its own 40-line `makeLead`. That is four
 * copies to update whenever the type gains a field. This is the one copy;
 * tests override only what they are actually asserting on.
 */
import type { Lead } from '@/lib/realty-types';

export function makeLead(overrides: Partial<Lead> = {}): Lead {
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
