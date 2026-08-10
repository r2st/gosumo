// GoSumo Realty — frontend types mirroring the API DTOs (apps/api realty modules).

export type LeadStage =
  | 'NEW'
  | 'CONTACTED'
  | 'QUALIFIED'
  | 'VISIT_BOOKED'
  | 'VISITED'
  | 'NEGOTIATING'
  | 'CLOSED_WON'
  | 'CLOSED_LOST'
  | 'DORMANT';

export type LeadTemperature = 'HOT' | 'WARM' | 'COLD' | 'JUNK';

export type LeadSource =
  | 'PORTAL'
  | 'META_LEAD_AD'
  | 'CTWA'
  | 'IVR'
  | 'REFERRAL'
  | 'CSV'
  | 'WALK_IN'
  | 'EXCHANGE_INBOUND'
  | 'MANUAL';

export type LeadPurpose = 'END_USE' | 'INVEST';
export type FinancingStatus = 'CASH' | 'PREAPPROVED' | 'NEEDS_LOAN';

export interface BltcProfile {
  budgetMinPaise: number | null;
  budgetMaxPaise: number | null;
  localities: string[];
  timelineMonths: number | null;
  config: string | null;
  purpose: LeadPurpose | null;
  financing: FinancingStatus | null;
}

export interface LeadMemoryEntry {
  text: string;
  at: string;
  messageId?: string;
}

export interface Lead {
  id: string;
  businessId: string;
  assignedAgentId: string | null;
  conversationId: string | null;
  clientId: string | null;
  whatsappPhone: string;
  altPhone: string | null;
  email: string | null;
  name: string | null;
  languagePref: string;
  source: LeadSource;
  subSource: string | null;
  listingRef: string | null;
  firstTouchAt: string;
  bltc: BltcProfile;
  qualScore: number;
  temperature: LeadTemperature;
  stage: LeadStage;
  matchedUnitIds: string[];
  extractedFacts: LeadMemoryEntry[];
  objections: LeadMemoryEntry[];
  promises: LeadMemoryEntry[];
  optOut: boolean;
  shareConsent: boolean;
  exchangeStatus: string;
  nextFollowupAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadBoardColumn {
  stage: LeadStage;
  count: number;
}

export type ProjectStatus = 'PRELAUNCH' | 'UC' | 'RTM';
export type NetworkVisibility = 'PRIVATE' | 'EXCHANGE';

/**
 * CP commission terms — free-form JSON on the project. PRIVATE: this is broker-only
 * and is never surfaced to buyers or fed to the AI. Common keys are typed for
 * convenient rendering; unknown keys are tolerated and shown generically.
 */
export interface CommissionTerms {
  /** Brokerage as a percentage of deal value, e.g. 2 for 2%. */
  pct?: number;
  /** Flat brokerage in paise (alternative to `pct`). */
  flatPaise?: number;
  /** Payout schedule, e.g. "50% on booking, 50% on registration". */
  payoutTerms?: string;
  /** Free-text notes. */
  notes?: string;
  [key: string]: unknown;
}

export interface RealtyProject {
  id: string;
  businessId: string;
  name: string;
  developer: string | null;
  locality: string;
  reraNumber: string | null;
  possessionDate: string | null;
  status: ProjectStatus;
  amenities: string[];
  priceBandMinPaise: number | null;
  priceBandMaxPaise: number | null;
  factSheetDocId: string | null;
  commissionTerms: CommissionTerms;
  networkVisibility: NetworkVisibility;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RealtyAssetType = 'BROCHURE' | 'FLOORPLAN' | 'PRICESHEET' | 'VIDEO' | 'PIN';

export interface RealtyAsset {
  id: string;
  projectId: string;
  type: RealtyAssetType;
  url: string | null;
  waMediaId: string | null;
  title: string | null;
  version: number;
  isCurrent: boolean;
  createdAt: string;
}

export const ASSET_TYPE_LABELS: Record<RealtyAssetType, string> = {
  BROCHURE: 'Brochure',
  FLOORPLAN: 'Floor plan',
  PRICESHEET: 'Price sheet',
  VIDEO: 'Video',
  PIN: 'Location pin',
};

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  PRELAUNCH: 'Pre-launch',
  UC: 'Under construction',
  RTM: 'Ready to move',
};

export type UnitAvailability = 'AVAILABLE' | 'HELD' | 'SOLD' | 'UNVERIFIED';

export interface RealtyUnit {
  id: string;
  businessId: string;
  projectId: string;
  config: string;
  carpetSqft: number | null;
  builtupSqft: number | null;
  floor: number | null;
  facing: string | null;
  basePricePaise: number | null;
  allInPricePaise: number;
  availability: UnitAvailability;
  verifiedAt: string | null;
  /** Whether availability is within the 24h freshness window (24-hour rule). */
  isFresh: boolean;
  networkVisibility: NetworkVisibility;
  createdAt: string;
  updatedAt: string;
}

export interface UnitMatch {
  unitId: string;
  projectId: string;
  projectName: string;
  config: string;
  allInPricePaise: number;
  locality: string;
  fitScore: number;
  reasons: string[];
}

export const LEAD_STAGES: LeadStage[] = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'VISIT_BOOKED',
  'VISITED',
  'NEGOTIATING',
  'CLOSED_WON',
  'CLOSED_LOST',
  'DORMANT',
];

export const STAGE_LABELS: Record<LeadStage, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  VISIT_BOOKED: 'Visit Booked',
  VISITED: 'Visited',
  NEGOTIATING: 'Negotiating',
  CLOSED_WON: 'Closed Won',
  CLOSED_LOST: 'Closed Lost',
  DORMANT: 'Dormant',
};

/**
 * A lead's follow-up language preference. Drives which cadence templates (English
 * vs. the `_hi` Hindi variants) are sent and the language the AI replies in.
 * `hinglish` keeps replies adaptive to whatever the buyer writes.
 */
export const LEAD_LANGUAGES = ['en', 'hi', 'hinglish'] as const;
export type LeadLanguage = (typeof LEAD_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<LeadLanguage, string> = {
  en: 'English',
  hi: 'Hindi',
  hinglish: 'Hinglish',
};

/** Normalize a stored `languagePref` (which may be legacy/unknown) to a known code. */
export function normalizeLeadLanguage(pref: string | null | undefined): LeadLanguage {
  const v = (pref ?? '').trim().toLowerCase();
  if (v === 'en' || v === 'english') return 'en';
  if (v === 'hi' || v === 'hindi') return 'hi';
  return 'hinglish';
}

// ─────────────────────────────────────────────
// Phase 3 — Site visits
// ─────────────────────────────────────────────

export type SiteVisitStatus =
  | 'BOOKED'
  | 'CONFIRMED'
  | 'COMPLETED'
  | 'NO_SHOW'
  | 'RESCHEDULED'
  | 'CANCELLED';

export type SiteVisitOutcome =
  | 'PENDING'
  | 'INTERESTED'
  | 'NOT_INTERESTED'
  | 'WANTS_ALTERNATIVE'
  | 'NEEDS_FOLLOWUP'
  | 'TOKEN_BOOKED';

export interface SiteVisit {
  id: string;
  businessId: string;
  leadId: string;
  projectId: string;
  unitId: string | null;
  assignedAgentId: string | null;
  scheduledAt: string;
  durationMinutes: number;
  timezone: string;
  status: SiteVisitStatus;
  bookingId: string | null;
  calendarEventId: string | null;
  calendarId: string | null;
  reminderState: Record<string, boolean>;
  remindersSent: number;
  lastReminderAt: string | null;
  feedback: string | null;
  outcome: SiteVisitOutcome;
  rescheduledFrom: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const SITE_VISIT_STATUSES: SiteVisitStatus[] = [
  'BOOKED',
  'CONFIRMED',
  'COMPLETED',
  'NO_SHOW',
  'RESCHEDULED',
  'CANCELLED',
];

export const SITE_VISIT_STATUS_LABELS: Record<SiteVisitStatus, string> = {
  BOOKED: 'Booked',
  CONFIRMED: 'Confirmed',
  COMPLETED: 'Completed',
  NO_SHOW: 'No-show',
  RESCHEDULED: 'Rescheduled',
  CANCELLED: 'Cancelled',
};

export const SITE_VISIT_OUTCOMES: SiteVisitOutcome[] = [
  'PENDING',
  'INTERESTED',
  'NOT_INTERESTED',
  'WANTS_ALTERNATIVE',
  'NEEDS_FOLLOWUP',
  'TOKEN_BOOKED',
];

export const SITE_VISIT_OUTCOME_LABELS: Record<SiteVisitOutcome, string> = {
  PENDING: 'Pending',
  INTERESTED: 'Interested',
  NOT_INTERESTED: 'Not interested',
  WANTS_ALTERNATIVE: 'Wants alternative',
  NEEDS_FOLLOWUP: 'Needs follow-up',
  TOKEN_BOOKED: 'Token booked',
};

export interface BookVisitInput {
  leadId: string;
  projectId: string;
  unitId?: string;
  scheduledAt: string;
  durationMinutes?: number;
  assignedAgentId?: string;
  staffId?: string;
  notes?: string;
}

export interface SiteVisitListResponse {
  data: SiteVisit[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Realty list endpoints return a flat envelope (`{ data, total, page, limit,
 * totalPages }`), NOT the legacy nested `{ data, pagination }` shape. Keep this
 * in sync with the backend realty-leads service response.
 */
export interface LeadListResponse {
  data: Lead[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─────────────────────────────────────────────
// Phase 4 — Ingestion (CSV import)
// ─────────────────────────────────────────────

export interface CsvImportRow {
  phone: string;
  name?: string;
  email?: string;
  source?: string;
  subSource?: string;
  listingRef?: string;
}

export interface CsvImportResult {
  total: number;
  created: number;
  merged: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

// ─────────────────────────────────────────────
// Phase 5 — Cadences & compliance
// ─────────────────────────────────────────────

export type CadenceTrigger = 'NO_RESPONSE' | 'POST_VISIT' | 'DORMANT';
export type CadenceStopOn = 'REPLY' | 'OPTOUT' | 'STAGE_CHANGE';
export type TemplateCategory = 'UTILITY' | 'MARKETING';
export type TemplateApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type CadenceEnrollmentStatus = 'ACTIVE' | 'COMPLETED' | 'STOPPED';

export interface MessageTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  language: string;
  body: string;
  variables: string[];
  approvalStatus: TemplateApprovalStatus;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CadenceStep {
  id: string;
  order: number;
  dayOffset: number;
  templateId: string;
  templateName: string;
  stopOn: CadenceStopOn[];
}

export interface Cadence {
  id: string;
  name: string;
  description: string | null;
  trigger: CadenceTrigger;
  isActive: boolean;
  steps: CadenceStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CadenceEnrollment {
  id: string;
  leadId: string;
  cadenceId: string;
  trigger: CadenceTrigger;
  status: CadenceEnrollmentStatus;
  currentStep: number;
  nextRunAt: string | null;
  stopReason: string | null;
  lastStepSentAt: string | null;
  startedAt: string;
  completedAt: string | null;
}

export const CADENCE_TRIGGER_LABELS: Record<CadenceTrigger, string> = {
  NO_RESPONSE: 'No response',
  POST_VISIT: 'Post-visit',
  DORMANT: 'Dormant reactivation',
};

// ─────────────────────────────────────────────
// Phase 6 — Broker surface
// ─────────────────────────────────────────────

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'EDITED' | 'REJECTED';
export type AutonomyLevel = 'SUGGEST' | 'ASSISTED' | 'AUTONOMOUS';
export type BrokerAlertType =
  | 'HOT_LEAD'
  | 'MORNING_BRIEFING'
  | 'APPROVAL_PENDING'
  | 'TAKEOVER'
  | 'VISIT_REMINDER';

export interface Approval {
  id: string;
  leadId: string;
  conversationId: string | null;
  draftText: string;
  editedText: string | null;
  confidence: number;
  intent: string | null;
  status: ApprovalStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reason: string | null;
  createdAt: string;
}

export interface BrokerSettings {
  autonomyLevel: AutonomyLevel;
  autoApproveThreshold: number;
  killSwitch: boolean;
  briefingEnabled: boolean;
  briefingHour: number;
  briefingMinute: number;
  hotAlertWhatsapp: string | null;
}

export interface BrokerAlert {
  id: string;
  type: BrokerAlertType;
  leadId: string | null;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface AlertsResponse {
  alerts: BrokerAlert[];
  unread: number;
}

export interface BriefingItem {
  leadId: string;
  name: string | null;
  detail: string;
}

export interface MorningBriefing {
  date: string;
  hotLeads: BriefingItem[];
  visitsToday: BriefingItem[];
  followupsDue: BriefingItem[];
  pendingApprovals: number;
  pipeline: { stage: string; count: number }[];
  generatedAt: string;
}

export interface BrokerConsoleMetrics {
  activeLeads: number;
  hotLeads: number;
  pendingApprovals: number;
  followupsDueToday: number;
  activeCadences: number;
  autonomyLevel: string;
  aiHandledPct: number;
}

export const AUTONOMY_LABELS: Record<AutonomyLevel, string> = {
  SUGGEST: 'Suggest (approve every send)',
  ASSISTED: 'Assisted (auto-send high confidence)',
  AUTONOMOUS: 'Autonomous (AI runs the desk)',
};

// ── Exchange (L2 co-broking) ────────────────────────────────────────────────

export type SyndicationState = 'OFFERED' | 'ACCEPTED' | 'VISIT' | 'CLOSED' | 'EXPIRED' | 'DISPUTED';
export type SettlementState = 'UNSETTLED' | 'PENDING' | 'SETTLED' | 'REVERSED';
export type ResaleListingStatus = 'ACTIVE' | 'UNDER_OFFER' | 'SOLD' | 'WITHDRAWN';

export interface SplitTerms {
  originatorPct: number;
  counterpartyPct: number;
  developerPct?: number;
  note?: string;
}

export interface Syndication {
  id: string;
  businessId: string;
  leadId: string;
  fromBusinessId: string;
  toBusinessId: string;
  developerId: string | null;
  splitTerms: SplitTerms;
  buyerConsentAt: string | null;
  state: SyndicationState;
  commissionPoolPaise: number;
  platformFeePaise: number;
  settlementState: SettlementState;
  createdAt: string;
  updatedAt: string;
}

export interface ExchangeMatch {
  listingId: string;
  sourceType: 'RESALE' | 'UNIT';
  ownerBusinessId: string;
  projectName: string | null;
  locality: string;
  config: string;
  askingPricePaise: number;
  fitScore: number;
  reliabilityScore: number;
  blendedScore: number;
  reasons: string[];
}

export interface ExchangeMatchResult {
  leadId: string;
  matches: ExchangeMatch[];
  aiRationale: string | null;
}

export interface ReliabilityScore {
  id: string;
  businessId: string;
  targetBusinessId: string;
  responseSpeedScore: number;
  showupIntegrityScore: number;
  splitHonoringScore: number;
  documentationHygieneScore: number;
  compositeScore: number;
  periodStart: string;
  periodEnd: string;
}

export interface ResaleListing {
  id: string;
  businessId: string;
  projectId: string | null;
  locality: string;
  config: string;
  carpetSqft: number | null;
  askingPricePaise: number;
  sellerPhone: string;
  status: ResaleListingStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSyndicationInput {
  leadId: string;
  toBusinessId: string;
  developerId?: string;
  splitTerms: SplitTerms;
}

export interface RateSyndicationInput {
  responseMinutes?: number;
  showedUp?: boolean;
  splitHonored?: boolean;
  documented?: boolean;
}

export const SYNDICATION_STATE_LABELS: Record<SyndicationState, string> = {
  OFFERED: 'Offered',
  ACCEPTED: 'Accepted',
  VISIT: 'Visited',
  CLOSED: 'Closed',
  EXPIRED: 'Expired',
  DISPUTED: 'Disputed',
};

/** The happy-path lifecycle, in order — drives the state timeline. */
export const SYNDICATION_FLOW: SyndicationState[] = ['OFFERED', 'ACCEPTED', 'VISIT', 'CLOSED'];

export const RESALE_STATUS_LABELS: Record<ResaleListingStatus, string> = {
  ACTIVE: 'Active',
  UNDER_OFFER: 'Under offer',
  SOLD: 'Sold',
  WITHDRAWN: 'Withdrawn',
};
