// GoSumo Realty — derive a unified lead activity timeline from the data we have.
// The lead record carries lifecycle timestamps and AI-extracted memory (each
// with an `at`), and the site-visit list carries scheduled visits. We merge them
// into one time-ordered stream for the lead detail page.

import { sourceLabel } from '@/lib/realty-ui';
import {
  SITE_VISIT_STATUS_LABELS,
  SITE_VISIT_OUTCOME_LABELS,
  STAGE_LABELS,
  type Lead,
  type SiteVisit,
} from '@/lib/realty-types';

export type LeadTimelineKind =
  | 'captured'
  | 'contact'
  | 'fact'
  | 'objection'
  | 'promise'
  | 'visit'
  | 'stage'
  | 'activity'
  | 'followup';

export interface LeadTimelineEvent {
  id: string;
  kind: LeadTimelineKind;
  /** ISO timestamp the event occurred (or is scheduled for, when `future`). */
  at: string;
  title: string;
  detail?: string;
  /** True for upcoming (not-yet-happened) events such as a scheduled follow-up. */
  future?: boolean;
}

function validTime(iso: string | null | undefined): boolean {
  if (!iso) return false;
  return !Number.isNaN(new Date(iso).getTime());
}

/**
 * Build a newest-first activity timeline for a lead. Combines lifecycle events
 * (captured, first contact, stage, last activity, upcoming follow-up), the AI's
 * extracted memory (facts / objections / promises), and site visits.
 */
export function buildLeadTimeline(lead: Lead, visits: SiteVisit[] = []): LeadTimelineEvent[] {
  const events: LeadTimelineEvent[] = [];

  if (validTime(lead.createdAt)) {
    events.push({
      id: 'captured',
      kind: 'captured',
      at: lead.createdAt,
      title: 'Lead captured',
      detail: `via ${sourceLabel(lead)}`,
    });
  }

  // Only surface first contact when it is a distinct, later moment than capture.
  if (validTime(lead.firstTouchAt) && lead.firstTouchAt !== lead.createdAt) {
    events.push({
      id: 'contact',
      kind: 'contact',
      at: lead.firstTouchAt,
      title: 'First contact',
    });
  }

  for (const [i, f] of lead.extractedFacts.entries()) {
    if (validTime(f.at)) {
      events.push({ id: `fact-${i}`, kind: 'fact', at: f.at, title: 'Fact learned', detail: f.text });
    }
  }
  for (const [i, o] of lead.objections.entries()) {
    if (validTime(o.at)) {
      events.push({ id: `obj-${i}`, kind: 'objection', at: o.at, title: 'Objection raised', detail: o.text });
    }
  }
  for (const [i, p] of lead.promises.entries()) {
    if (validTime(p.at)) {
      events.push({ id: `promise-${i}`, kind: 'promise', at: p.at, title: 'Promise made', detail: p.text });
    }
  }

  for (const v of visits) {
    if (validTime(v.scheduledAt)) {
      const detail =
        v.outcome !== 'PENDING' ? `Outcome: ${SITE_VISIT_OUTCOME_LABELS[v.outcome]}` : undefined;
      events.push({
        id: `visit-${v.id}`,
        kind: 'visit',
        at: v.scheduledAt,
        title: `Site visit · ${SITE_VISIT_STATUS_LABELS[v.status]}`,
        detail,
      });
    }
  }

  // Current stage, anchored to the last update. Skip for brand-new leads whose
  // stage still reads NEW (the "captured" event already conveys that).
  if (lead.stage !== 'NEW' && validTime(lead.updatedAt)) {
    events.push({
      id: 'stage',
      kind: 'stage',
      at: lead.updatedAt,
      title: `Moved to ${STAGE_LABELS[lead.stage]}`,
    });
  }

  if (
    validTime(lead.lastActivityAt) &&
    lead.lastActivityAt !== lead.createdAt &&
    lead.lastActivityAt !== lead.updatedAt
  ) {
    events.push({
      id: 'activity',
      kind: 'activity',
      at: lead.lastActivityAt as string,
      title: 'Last activity',
    });
  }

  if (validTime(lead.nextFollowupAt)) {
    events.push({
      id: 'followup',
      kind: 'followup',
      at: lead.nextFollowupAt as string,
      title: 'Follow-up scheduled',
      future: true,
    });
  }

  // Newest first. Ties keep insertion order (stable sort in modern engines).
  return events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
