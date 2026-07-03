import { TemplateCategory, CadenceTrigger, CadenceStopOn } from '@gosumo/shared';

/**
 * The 12 pre-built real-estate WhatsApp templates (blueprint §17). These seed a
 * new tenant's registry so cadences work on day one. Bodies use {{n}} Meta
 * placeholders; `variables` names them in order for the broker's UI.
 *
 * Categories follow WhatsApp policy: an informational/transactional message is
 * UTILITY; anything promotional (re-engagement, new inventory) is MARKETING and
 * is only ever sent inside the 24h service window (see compliance.util.ts).
 */

export interface DefaultTemplate {
  name: string;
  category: TemplateCategory;
  language: string;
  body: string;
  variables: string[];
}

export const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  // ── Initial response ─────────────────────────
  {
    name: 'initial_response',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body:
      'Hi {{1}}, thanks for your interest in {{2}}. I can share pricing, floor plans and availability. ' +
      'What configuration are you looking for?',
    variables: ['buyer_name', 'project_or_locality'],
  },
  // ── No-response follow-ups (D1 / D3 / D7) ────
  {
    name: 'followup_no_response_d1',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body: 'Hi {{1}}, just following up on your enquiry about {{2}}. Would you like me to share a few matching options?',
    variables: ['buyer_name', 'project_or_locality'],
  },
  {
    name: 'followup_no_response_d3',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body:
      'Hi {{1}}, a couple of good {{2}} options in {{3}} are still available. Shall I send the details and a site-visit slot?',
    variables: ['buyer_name', 'config', 'locality'],
  },
  {
    name: 'followup_no_response_d7',
    category: TemplateCategory.MARKETING,
    language: 'en',
    body:
      'Hi {{1}}, new inventory has just opened up in {{2}} within your budget. Want me to share the fresh list before it sells out?',
    variables: ['buyer_name', 'locality'],
  },
  // ── Post-visit nurture ───────────────────────
  {
    name: 'post_visit_thankyou',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body: 'Thanks for visiting {{1}} today, {{2}}! How did you find the project? Happy to answer any questions.',
    variables: ['project_name', 'buyer_name'],
  },
  {
    name: 'post_visit_feedback_d1',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body:
      'Hi {{1}}, following up on your visit to {{2}}. If the layout worked for you, I can hold a unit and share the payment plan.',
    variables: ['buyer_name', 'project_name'],
  },
  {
    name: 'post_visit_alternative_d3',
    category: TemplateCategory.MARKETING,
    language: 'en',
    body:
      'Hi {{1}}, if {{2}} was not quite right, I have {{3}} similar options in the same corridor. Want to see them?',
    variables: ['buyer_name', 'project_name', 'count'],
  },
  // ── Dormant reactivation (D30 / D60 / D90) ───
  {
    name: 'dormant_reactivation_d30',
    category: TemplateCategory.MARKETING,
    language: 'en',
    body: 'Hi {{1}}, are you still exploring a home in {{2}}? Prices and offers have moved — want an updated shortlist?',
    variables: ['buyer_name', 'locality'],
  },
  {
    name: 'dormant_reactivation_d60',
    category: TemplateCategory.MARKETING,
    language: 'en',
    body:
      'Hi {{1}}, a few ready-to-move {{2}} options have come up in {{3}}. Shall I reserve a quick call to walk you through them?',
    variables: ['buyer_name', 'config', 'locality'],
  },
  {
    name: 'dormant_reactivation_d90',
    category: TemplateCategory.MARKETING,
    language: 'en',
    body:
      'Hi {{1}}, checking in one last time — should I keep sending you handpicked {{2}} options in {{3}}, or pause for now?',
    variables: ['buyer_name', 'config', 'locality'],
  },
  // ── Utility / operational ────────────────────
  {
    name: 'site_visit_reminder',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body: 'Reminder: your site visit to {{1}} is on {{2}} at {{3}}. Reply CONFIRM to lock it or RESCHEDULE to change.',
    variables: ['project_name', 'date', 'time'],
  },
  {
    name: 'new_inventory_match',
    category: TemplateCategory.MARKETING,
    language: 'en',
    body:
      'Hi {{1}}, a new {{2}} in {{3}} just matched your requirement at {{4}}. Want the brochure and a visit slot?',
    variables: ['buyer_name', 'config', 'locality', 'price'],
  },
];

/** A step in a seeded default cadence, referencing a template by name. */
export interface DefaultCadenceStep {
  order: number;
  dayOffset: number;
  templateName: string;
  stopOn: CadenceStopOn[];
}

export interface DefaultCadence {
  name: string;
  description: string;
  trigger: CadenceTrigger;
  steps: DefaultCadenceStep[];
}

const STOP_REPLY_OPTOUT_STAGE = [CadenceStopOn.REPLY, CadenceStopOn.OPTOUT, CadenceStopOn.STAGE_CHANGE];

/**
 * The three default cadences (blueprint §17): a no-response D1/D3/D7 sequence,
 * a post-visit nurture, and a dormant D30/D60/D90 reactivation. Installed with
 * the templates when a tenant is seeded.
 */
export const DEFAULT_CADENCES: DefaultCadence[] = [
  {
    name: 'No-response follow-up (D1 / D3 / D7)',
    description: 'Re-engages a fresh lead that has gone quiet. Stops the instant they reply.',
    trigger: CadenceTrigger.NO_RESPONSE,
    steps: [
      { order: 0, dayOffset: 1, templateName: 'followup_no_response_d1', stopOn: STOP_REPLY_OPTOUT_STAGE },
      { order: 1, dayOffset: 3, templateName: 'followup_no_response_d3', stopOn: STOP_REPLY_OPTOUT_STAGE },
      { order: 2, dayOffset: 7, templateName: 'followup_no_response_d7', stopOn: STOP_REPLY_OPTOUT_STAGE },
    ],
  },
  {
    name: 'Post-visit nurture',
    description: 'Thanks the buyer, gathers feedback, and offers alternatives after a completed site visit.',
    trigger: CadenceTrigger.POST_VISIT,
    steps: [
      { order: 0, dayOffset: 0, templateName: 'post_visit_thankyou', stopOn: [CadenceStopOn.OPTOUT] },
      { order: 1, dayOffset: 1, templateName: 'post_visit_feedback_d1', stopOn: [CadenceStopOn.OPTOUT, CadenceStopOn.STAGE_CHANGE] },
      { order: 2, dayOffset: 3, templateName: 'post_visit_alternative_d3', stopOn: [CadenceStopOn.REPLY, CadenceStopOn.OPTOUT] },
    ],
  },
  {
    name: 'Dormant reactivation (D30 / D60 / D90)',
    description: 'Wins back a long-cold lead with periodic, opt-out-respecting nudges.',
    trigger: CadenceTrigger.DORMANT,
    steps: [
      { order: 0, dayOffset: 0, templateName: 'dormant_reactivation_d30', stopOn: [CadenceStopOn.REPLY, CadenceStopOn.OPTOUT] },
      { order: 1, dayOffset: 30, templateName: 'dormant_reactivation_d60', stopOn: [CadenceStopOn.REPLY, CadenceStopOn.OPTOUT] },
      { order: 2, dayOffset: 60, templateName: 'dormant_reactivation_d90', stopOn: [CadenceStopOn.REPLY, CadenceStopOn.OPTOUT] },
    ],
  },
];
