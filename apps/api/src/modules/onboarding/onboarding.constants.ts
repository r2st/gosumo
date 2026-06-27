/**
 * Onboarding module constants — the guided-wizard step catalog and the
 * static knowledge base the AI assistant grounds its answers in.
 *
 * The wizard is a 6-step hybrid flow (guided forms + AI chat help). Unlike the
 * legacy tenant onboarding checklist (PROFILE → … → TEAM, enforced in order),
 * this flow lets operators complete steps in any order and explicitly track
 * which steps were *skipped*, so the dashboard can nudge them later.
 */

/**
 * Canonical wizard steps. The string values are persisted in
 * `businesses.onboarding_progress` and travel to the frontend, so they are
 * stable identifiers — do not rename without a data migration.
 */
export enum OnboardingStepId {
  WELCOME = 'WELCOME',
  CHANNELS = 'CHANNELS',
  CATALOG = 'CATALOG',
  AI_CONFIG = 'AI_CONFIG',
  TEAM = 'TEAM',
  TEST = 'TEST',
}

/** Display/progress order of the wizard steps. */
export const ONBOARDING_STEP_ORDER: readonly OnboardingStepId[] = [
  OnboardingStepId.WELCOME,
  OnboardingStepId.CHANNELS,
  OnboardingStepId.CATALOG,
  OnboardingStepId.AI_CONFIG,
  OnboardingStepId.TEAM,
  OnboardingStepId.TEST,
];

/** Per-step completion state. */
export enum OnboardingStepStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  SKIPPED = 'skipped',
}

export interface OnboardingStepDefinition {
  id: OnboardingStepId;
  title: string;
  description: string;
  /** Whether the step can be skipped. WELCOME (profile) is required. */
  optional: boolean;
}

/**
 * Static metadata for each step. Returned to the frontend so the wizard UI and
 * the AI assistant share a single source of truth for titles/descriptions.
 */
export const ONBOARDING_STEPS: Record<OnboardingStepId, OnboardingStepDefinition> = {
  [OnboardingStepId.WELCOME]: {
    id: OnboardingStepId.WELCOME,
    title: 'Welcome & Business Profile',
    description:
      'Confirm your business name, industry, timezone and business hours so the AI represents you correctly.',
    optional: false,
  },
  [OnboardingStepId.CHANNELS]: {
    id: OnboardingStepId.CHANNELS,
    title: 'Connect Channels',
    description:
      'Connect WebChat, WhatsApp, Email, SMS or Instagram so customer messages flow into GoSumo.',
    optional: true,
  },
  [OnboardingStepId.CATALOG]: {
    id: OnboardingStepId.CATALOG,
    title: 'Add Catalog',
    description:
      'Import or add your products and services so the AI can quote prices and answer questions accurately.',
    optional: true,
  },
  [OnboardingStepId.AI_CONFIG]: {
    id: OnboardingStepId.AI_CONFIG,
    title: 'Configure AI',
    description:
      'Set auto-reply preferences, tone and confidence thresholds that control when the AI acts on its own.',
    optional: true,
  },
  [OnboardingStepId.TEAM]: {
    id: OnboardingStepId.TEAM,
    title: 'Invite Team',
    description: 'Add teammates and assign roles so the right people handle escalations.',
    optional: true,
  },
  [OnboardingStepId.TEST]: {
    id: OnboardingStepId.TEST,
    title: 'Quick Test',
    description:
      'Send a test message through a connected channel to confirm everything works end to end.',
    optional: true,
  },
};

/** Steps that are mandatory before onboarding can be marked complete. */
export const REQUIRED_STEPS: readonly OnboardingStepId[] = ONBOARDING_STEP_ORDER.filter(
  (id) => !ONBOARDING_STEPS[id].optional,
);

// ─────────────────────────────────────────────
// AI assistant knowledge base
// ─────────────────────────────────────────────

/**
 * Per-step grounding knowledge. Injected into the assistant's system prompt and
 * used verbatim as a deterministic fallback when the LLM is unavailable (no API
 * key, timeout, etc.) so the assistant always returns something useful.
 */
export const ONBOARDING_KNOWLEDGE: Record<OnboardingStepId, string> = {
  [OnboardingStepId.WELCOME]: [
    'This step captures the business profile used as AI context: name, industry, timezone and business hours.',
    'Timezone should be the IANA zone where the business operates (India defaults to Asia/Kolkata).',
    'Business hours are set per weekday with a start and end time in 24h HH:MM. Outside these hours the AI sends an away message instead of replying live.',
  ].join(' '),
  [OnboardingStepId.CHANNELS]: [
    'GoSumo supports WebChat, WhatsApp, Email, SMS and Instagram.',
    'WebChat needs no external account — it works immediately via an embeddable widget.',
    'WhatsApp requires a WhatsApp Business Account connected through Meta. You need a phone number that is NOT already registered on the consumer WhatsApp app, a Meta Business Manager account, and business verification. The number format is E.164 (e.g. +919876543210).',
    'Meta Business verification is done in Meta Business Manager → Settings → Business Info → Start Verification; you upload a business document (GST certificate, utility bill or incorporation certificate) and it typically takes 1–3 business days.',
    'Instagram requires a Professional (Business/Creator) account linked to a Facebook Page.',
    'Email connects via your SMTP/IMAP credentials or a forwarding address. SMS connects via an Indian DLT-registered sender ID.',
  ].join(' '),
  [OnboardingStepId.CATALOG]: [
    'The catalog holds your products and services with prices in rupees (stored internally as paise).',
    'You can add items manually one by one, or bulk-import from a CSV with columns: name, type (PRODUCT/SERVICE), price, description, sku.',
    'Accurate catalog data lets the AI quote prices and check availability; if an item is not in the catalog the AI will not invent a price — it escalates instead.',
  ].join(' '),
  [OnboardingStepId.AI_CONFIG]: [
    'AI behaviour is governed by two confidence thresholds. At or above the auto-execute threshold (default 90%) the AI replies on its own. Between the review threshold (default 70%) and 90% it drafts a reply for a human to approve. Below 70% it escalates to a human.',
    'Tone/personality is a short instruction (e.g. "friendly and concise, use simple Hindi-English") that shapes every reply.',
    'You can also set the default response language and an away message for outside business hours.',
  ].join(' '),
  [OnboardingStepId.TEAM]: [
    'Invite teammates by email; they receive an invite link to set a password.',
    'Roles: OWNER (full access, billing), ADMIN (manage settings and team), AGENT (handle conversations and approve AI drafts), VIEWER (read-only).',
    'Plan limits cap how many members you can add — Free/Starter are small, Growth allows 10, Scale is unlimited.',
  ].join(' '),
  [OnboardingStepId.TEST]: [
    'The quick test sends a sample customer message through a connected channel and shows how the AI responds.',
    'WebChat is the fastest channel to test because it needs no external setup.',
    'A successful test confirms the channel is connected, the AI pipeline runs, and replies are delivered.',
  ].join(' '),
};

/** Suggested questions surfaced in the chat UI for each step. */
export const ONBOARDING_SUGGESTED_QUESTIONS: Record<OnboardingStepId, string[]> = {
  [OnboardingStepId.WELCOME]: [
    'What timezone should I pick?',
    'How do business hours affect the AI?',
  ],
  [OnboardingStepId.CHANNELS]: [
    'What WhatsApp number format do I need?',
    'How do I get a Meta Business verification?',
    'Which channel is easiest to start with?',
  ],
  [OnboardingStepId.CATALOG]: [
    'How do I bulk-import my catalog?',
    'What happens if a product is missing?',
  ],
  [OnboardingStepId.AI_CONFIG]: [
    'What do the confidence thresholds mean?',
    'How should I describe my tone?',
  ],
  [OnboardingStepId.TEAM]: ['What can each role do?', 'How many members can I invite?'],
  [OnboardingStepId.TEST]: ['How do I run a test?', 'My test failed — what now?'],
};

/** Model + token budget for the onboarding assistant (kept small/cheap). */
export const ONBOARDING_ASSISTANT_MAX_TOKENS = 600;
export const ONBOARDING_ASSISTANT_TEMPERATURE = 0.3;
