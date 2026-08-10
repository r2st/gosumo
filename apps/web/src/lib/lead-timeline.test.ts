import { describe, expect, it } from 'vitest';
import { buildLeadTimeline } from './lead-timeline';
import type { Lead, SiteVisit } from '@/lib/realty-types';

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: 'lead-1',
    businessId: 'biz-1',
    assignedAgentId: null,
    conversationId: null,
    clientId: null,
    whatsappPhone: '+919876543210',
    altPhone: null,
    email: null,
    name: 'Rahul M',
    languagePref: 'en',
    source: 'PORTAL',
    subSource: null,
    listingRef: null,
    firstTouchAt: '2026-06-01T10:00:00.000Z',
    bltc: {
      budgetMinPaise: null,
      budgetMaxPaise: null,
      localities: [],
      timelineMonths: null,
      config: null,
      purpose: null,
      financing: null,
    },
    qualScore: 62,
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
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  };
}

function makeVisit(overrides: Partial<SiteVisit> = {}): SiteVisit {
  return {
    id: 'visit-1',
    businessId: 'biz-1',
    leadId: 'lead-1',
    projectId: 'proj-1',
    unitId: null,
    assignedAgentId: null,
    scheduledAt: '2026-06-05T06:30:00.000Z',
    durationMinutes: 45,
    timezone: 'Asia/Kolkata',
    status: 'CONFIRMED',
    bookingId: null,
    calendarEventId: null,
    calendarId: null,
    reminderState: {},
    remindersSent: 0,
    lastReminderAt: null,
    feedback: null,
    outcome: 'PENDING',
    rescheduledFrom: null,
    cancellationReason: null,
    createdAt: '2026-06-02T09:00:00.000Z',
    updatedAt: '2026-06-02T09:00:00.000Z',
    ...overrides,
  };
}

describe('buildLeadTimeline', () => {
  it('always emits a capture event sourced from the lead', () => {
    const events = buildLeadTimeline(makeLead());
    const captured = events.find((e) => e.kind === 'captured');
    expect(captured).toBeDefined();
    expect(captured?.detail).toContain('Portal');
  });

  it('includes extracted facts, objections, and promises as events', () => {
    const lead = makeLead({
      extractedFacts: [{ text: 'Wants east-facing', at: '2026-06-03T10:00:00.000Z' }],
      objections: [{ text: 'Price too high', at: '2026-06-03T11:00:00.000Z' }],
      promises: [{ text: 'Will visit Sunday', at: '2026-06-03T12:00:00.000Z' }],
    });
    const events = buildLeadTimeline(lead);
    expect(events.filter((e) => e.kind === 'fact')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'objection')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'promise')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'objection')?.detail).toBe('Price too high');
  });

  it('folds site visits into the timeline with status in the title', () => {
    const events = buildLeadTimeline(makeLead(), [makeVisit({ status: 'CONFIRMED' })]);
    const visit = events.find((e) => e.kind === 'visit');
    expect(visit).toBeDefined();
    expect(visit?.title).toContain('Confirmed');
  });

  it('emits a stage event only once the lead has advanced past NEW', () => {
    expect(buildLeadTimeline(makeLead({ stage: 'NEW' })).some((e) => e.kind === 'stage')).toBe(false);
    const advanced = buildLeadTimeline(
      makeLead({ stage: 'QUALIFIED', updatedAt: '2026-06-04T09:00:00.000Z' }),
    );
    const stage = advanced.find((e) => e.kind === 'stage');
    expect(stage?.title).toContain('Qualified');
  });

  it('marks an upcoming follow-up as a future event and sorts it first', () => {
    const lead = makeLead({ nextFollowupAt: '2026-07-01T09:00:00.000Z' });
    const events = buildLeadTimeline(lead);
    expect(events[0].kind).toBe('followup');
    expect(events[0].future).toBe(true);
  });

  it('orders events newest first', () => {
    const lead = makeLead({
      extractedFacts: [
        { text: 'earlier', at: '2026-06-02T10:00:00.000Z' },
        { text: 'later', at: '2026-06-06T10:00:00.000Z' },
      ],
    });
    const times = buildLeadTimeline(lead).map((e) => new Date(e.at).getTime());
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });

  it('skips events with invalid timestamps', () => {
    const lead = makeLead({ extractedFacts: [{ text: 'bad', at: 'not-a-date' }] });
    expect(buildLeadTimeline(lead).some((e) => e.kind === 'fact')).toBe(false);
  });
});
