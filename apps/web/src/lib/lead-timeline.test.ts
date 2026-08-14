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

  it('drops an objection or promise whose timestamp is unusable', () => {
    const lead = makeLead({
      objections: [{ text: 'no date', at: 'nonsense' }],
      promises: [{ text: 'no date either', at: '' }],
    });
    const events = buildLeadTimeline(lead);
    expect(events.some((e) => e.kind === 'objection')).toBe(false);
    expect(events.some((e) => e.kind === 'promise')).toBe(false);
  });

  it('omits the capture event when the lead carries no usable createdAt', () => {
    // A lead reconstructed from a partial API payload should still render a
    // timeline rather than an entry stamped "Invalid Date".
    const events = buildLeadTimeline(makeLead({ createdAt: '' }));
    expect(events.some((e) => e.kind === 'captured')).toBe(false);
  });

  it('does not emit a first-contact event when contact happened at capture', () => {
    // Portal leads arrive already "contacted", so both stamps are identical —
    // showing both would read as two separate events for one moment.
    const lead = makeLead({ firstTouchAt: '2026-06-01T09:00:00.000Z' });
    expect(lead.firstTouchAt).toBe(lead.createdAt);
    expect(buildLeadTimeline(lead).some((e) => e.kind === 'contact')).toBe(false);
  });

  it('ignores a first-contact stamp that is not a real date', () => {
    const events = buildLeadTimeline(makeLead({ firstTouchAt: 'whenever' }));
    expect(events.some((e) => e.kind === 'contact')).toBe(false);
  });

  it('skips a site visit with no usable scheduled time', () => {
    const events = buildLeadTimeline(makeLead(), [makeVisit({ scheduledAt: 'tbd' })]);
    expect(events.some((e) => e.kind === 'visit')).toBe(false);
  });

  it('reports the outcome on a visit that has already been settled', () => {
    const events = buildLeadTimeline(makeLead(), [
      makeVisit({ status: 'COMPLETED', outcome: 'INTERESTED' }),
    ]);
    const visit = events.find((e) => e.kind === 'visit');
    expect(visit?.detail).toContain('Outcome:');
  });

  it('leaves the detail blank while a visit outcome is still pending', () => {
    const events = buildLeadTimeline(makeLead(), [makeVisit({ outcome: 'PENDING' })]);
    expect(events.find((e) => e.kind === 'visit')?.detail).toBeUndefined();
  });

  it('emits a last-activity event only when it is a moment of its own', () => {
    const lead = makeLead({
      updatedAt: '2026-06-04T09:00:00.000Z',
      lastActivityAt: '2026-06-07T09:00:00.000Z',
    });
    expect(buildLeadTimeline(lead).some((e) => e.kind === 'activity')).toBe(true);
  });

  it('suppresses last activity that merely repeats capture or the last update', () => {
    // These two stamps are equal on any lead that has not been touched since
    // it was written, so echoing them would pad every timeline with a
    // duplicate row that tells the agent nothing.
    const atCreate = makeLead({ lastActivityAt: '2026-06-01T09:00:00.000Z' });
    expect(buildLeadTimeline(atCreate).some((e) => e.kind === 'activity')).toBe(false);

    const atUpdate = makeLead({
      updatedAt: '2026-06-04T09:00:00.000Z',
      lastActivityAt: '2026-06-04T09:00:00.000Z',
    });
    expect(buildLeadTimeline(atUpdate).some((e) => e.kind === 'activity')).toBe(false);
  });

  it('ignores an unusable last-activity or follow-up stamp', () => {
    const events = buildLeadTimeline(
      makeLead({ lastActivityAt: 'never', nextFollowupAt: 'someday' }),
    );
    expect(events.some((e) => e.kind === 'activity')).toBe(false);
    expect(events.some((e) => e.kind === 'followup')).toBe(false);
  });
});
