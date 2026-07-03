import { TemplateCategory, CadenceTrigger, CadenceStopOn } from '@gosumo/shared';

/**
 * The pre-built real-estate WhatsApp templates (blueprint §17). These seed a
 * new tenant's registry so cadences work on day one. Bodies use {{n}} Meta
 * placeholders; `variables` names them in order for the broker's UI.
 *
 * Every template type ships in **English + Hindi**. Because the DB enforces
 * `@@unique([business_id, name])`, the two languages cannot share a name — the
 * Hindi variant reuses the English name with a `_hi` suffix and `language: 'hi'`,
 * keeping the same category, placeholders and `variables`. Cadence steps always
 * reference the English (base) names; language selection at send time is the
 * dispatcher's job based on the lead's `language_pref`.
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
  {
    name: 'initial_response_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body:
      'नमस्ते {{1}}, {{2}} में आपकी रुचि के लिए धन्यवाद। मैं आपको कीमत, फ़्लोर प्लान और उपलब्धता की जानकारी भेज सकता हूँ। ' +
      'आप किस कॉन्फ़िगरेशन की तलाश में हैं?',
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
    name: 'followup_no_response_d1_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body:
      'नमस्ते {{1}}, {{2}} के बारे में आपकी पूछताछ पर फ़ॉलो-अप कर रहा हूँ। क्या आप चाहेंगे कि मैं कुछ मिलती-जुलती ऑप्शन भेजूँ?',
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
    name: 'followup_no_response_d3_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body:
      'नमस्ते {{1}}, {{3}} में {{2}} के कुछ अच्छे ऑप्शन अभी भी उपलब्ध हैं। क्या मैं आपको इनकी जानकारी और साइट-विज़िट का समय भेजूँ?',
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
  {
    name: 'followup_no_response_d7_hi',
    category: TemplateCategory.MARKETING,
    language: 'hi',
    body:
      'नमस्ते {{1}}, {{2}} में आपके बजट के अंदर नई प्रॉपर्टी अभी उपलब्ध हुई है। बिकने से पहले क्या मैं आपको ताज़ा लिस्ट भेज दूँ?',
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
    name: 'post_visit_thankyou_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body: '{{2}}, आज {{1}} विज़िट करने के लिए धन्यवाद! आपको प्रोजेक्ट कैसा लगा? किसी भी सवाल का जवाब देने में मुझे खुशी होगी।',
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
    name: 'post_visit_feedback_d1_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body:
      'नमस्ते {{1}}, {{2}} की आपकी विज़िट पर फ़ॉलो-अप कर रहा हूँ। अगर लेआउट आपको पसंद आया, तो मैं एक यूनिट होल्ड करके पेमेंट प्लान भेज सकता हूँ।',
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
  {
    name: 'post_visit_alternative_d3_hi',
    category: TemplateCategory.MARKETING,
    language: 'hi',
    body:
      'नमस्ते {{1}}, अगर {{2}} बिलकुल सही नहीं लगा, तो मेरे पास उसी इलाके में {{3}} मिलती-जुलती ऑप्शन हैं। क्या आप उन्हें देखना चाहेंगे?',
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
    name: 'dormant_reactivation_d30_hi',
    category: TemplateCategory.MARKETING,
    language: 'hi',
    body:
      'नमस्ते {{1}}, क्या आप अब भी {{2}} में घर तलाश रहे हैं? कीमतें और ऑफ़र बदल चुके हैं — क्या आपको अपडेटेड शॉर्टलिस्ट चाहिए?',
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
    name: 'dormant_reactivation_d60_hi',
    category: TemplateCategory.MARKETING,
    language: 'hi',
    body:
      'नमस्ते {{1}}, {{3}} में कुछ रेडी-टू-मूव {{2}} ऑप्शन आए हैं। क्या मैं आपको इनके बारे में बताने के लिए एक छोटी कॉल तय करूँ?',
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
  {
    name: 'dormant_reactivation_d90_hi',
    category: TemplateCategory.MARKETING,
    language: 'hi',
    body:
      'नमस्ते {{1}}, आख़िरी बार पूछ रहा हूँ — क्या मैं आपको {{3}} में चुनिंदा {{2}} ऑप्शन भेजता रहूँ, या फ़िलहाल रोक दूँ?',
    variables: ['buyer_name', 'config', 'locality'],
  },
  // ── Site-visit reminders (T-24h / T-2h) ──────
  {
    name: 'site_visit_reminder_24h',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body: 'Reminder: your site visit to {{1}} is tomorrow, {{2}} at {{3}}. Reply CONFIRM to lock it or RESCHEDULE to change.',
    variables: ['project_name', 'date', 'time'],
  },
  {
    name: 'site_visit_reminder_24h_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body:
      'रिमाइंडर: {{1}} की आपकी साइट विज़िट कल, {{2}} को {{3}} बजे है। इसे पक्का करने के लिए CONFIRM लिखें या बदलने के लिए RESCHEDULE लिखें।',
    variables: ['project_name', 'date', 'time'],
  },
  {
    name: 'site_visit_reminder_2h',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body:
      'Reminder: your site visit to {{1}} is in about 2 hours, at {{2}}. Our team will be ready — reply RESCHEDULE if your plans have changed.',
    variables: ['project_name', 'time'],
  },
  {
    name: 'site_visit_reminder_2h_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body:
      'रिमाइंडर: {{1}} की आपकी साइट विज़िट लगभग 2 घंटे में, {{2}} बजे है। हमारी टीम तैयार रहेगी — अगर आपका प्लान बदल गया हो तो RESCHEDULE लिखें।',
    variables: ['project_name', 'time'],
  },
  // ── New inventory match ──────────────────────
  {
    name: 'new_inventory_match',
    category: TemplateCategory.MARKETING,
    language: 'en',
    body:
      'Hi {{1}}, a new {{2}} in {{3}} just matched your requirement at {{4}}. Want the brochure and a visit slot?',
    variables: ['buyer_name', 'config', 'locality', 'price'],
  },
  {
    name: 'new_inventory_match_hi',
    category: TemplateCategory.MARKETING,
    language: 'hi',
    body:
      'नमस्ते {{1}}, {{3}} में एक नया {{2}} अभी {{4}} में आपकी ज़रूरत से मेल खाता है। क्या आपको ब्रोशर और विज़िट स्लॉट चाहिए?',
    variables: ['buyer_name', 'config', 'locality', 'price'],
  },
  // ── Price update ─────────────────────────────
  {
    name: 'price_update',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body: 'Hi {{1}}, an update on {{2}}: the price is now {{3}}. Let me know if you would like the latest cost sheet.',
    variables: ['buyer_name', 'project_name', 'price'],
  },
  {
    name: 'price_update_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body: 'नमस्ते {{1}}, {{2}} के बारे में एक अपडेट: अब कीमत {{3}} है। अगर आपको ताज़ा कॉस्ट शीट चाहिए तो बताइएगा।',
    variables: ['buyer_name', 'project_name', 'price'],
  },
  // ── Construction milestone update ────────────
  {
    name: 'milestone_update',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body: 'Hi {{1}}, good news on {{2}}: {{3}} is now complete. Want me to share the latest construction photos?',
    variables: ['buyer_name', 'project_name', 'milestone'],
  },
  {
    name: 'milestone_update_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body: 'नमस्ते {{1}}, {{2}} की अच्छी ख़बर: {{3}} अब पूरा हो चुका है। क्या मैं आपको निर्माण की ताज़ा तस्वीरें भेजूँ?',
    variables: ['buyer_name', 'project_name', 'milestone'],
  },
  // ── Opt-out confirmation ─────────────────────
  {
    name: 'opt_out_confirm',
    category: TemplateCategory.UTILITY,
    language: 'en',
    body:
      'Hi {{1}}, you have been unsubscribed and will not receive further messages from us. Reply START anytime to opt back in.',
    variables: ['buyer_name'],
  },
  {
    name: 'opt_out_confirm_hi',
    category: TemplateCategory.UTILITY,
    language: 'hi',
    body:
      'नमस्ते {{1}}, आपको अनसब्सक्राइब कर दिया गया है और अब आपको हमारी ओर से कोई संदेश नहीं मिलेगा। दोबारा शुरू करने के लिए कभी भी START लिखें।',
    variables: ['buyer_name'],
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
