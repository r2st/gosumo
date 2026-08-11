import {
  ChannelType,
  MessageDirection,
  MessageContentType,
  MessageStatus,
  ConversationStatus,
  IntentType,
  ConfidenceMode,
} from '../enums';

// ─────────────────────────────────────────────
// MESSAGE CONTENT (discriminated union)
// ─────────────────────────────────────────────

export type MessageContent =
  | {
      type: MessageContentType.TEXT;
      text: string;
    }
  | {
      type: MessageContentType.IMAGE;
      url: string;
      caption?: string;
      mimeType: string;
      width?: number;
      height?: number;
      fileSizeBytes?: number;
    }
  | {
      type: MessageContentType.DOCUMENT;
      url: string;
      filename: string;
      mimeType: string;
      fileSizeBytes?: number;
    }
  | {
      type: MessageContentType.LOCATION;
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    }
  | {
      type: MessageContentType.INTERACTIVE;
      interactiveType: string;
      payload: Record<string, unknown>;
    }
  | {
      type: MessageContentType.PAYMENT_LINK;
      url: string;
      /** Amount in paise */
      amount: number;
      currency: string;
      expiresAt?: Date;
    }
  | {
      type: MessageContentType.TEMPLATE;
      templateName: string;
      /** ISO 639-1 language code, e.g. "en", "hi" */
      language: string;
      parameters: Record<string, string>;
    };

// ─────────────────────────────────────────────
// NORMALIZED MESSAGE
// ─────────────────────────────────────────────

/**
 * Channel-agnostic internal message format.
 * Every channel adapter translates its raw payload into this shape
 * before emitting a `message.received` event.
 */
export interface NormalizedMessage {
  /** GoSumo internal ID (UUID v4) */
  id: string;
  /** Channel-assigned message ID (for deduplication and status callbacks) */
  externalId: string;
  channel: ChannelType;
  /** ID of the business's account on this channel (FK to channel_accounts) */
  channelAccountId: string;
  direction: MessageDirection;
  sender: {
    /** Phone number, IG user ID, email address, etc. */
    externalId: string;
    displayName?: string;
  };
  content: MessageContent;
  timestamp: Date;
  /** Raw channel-specific extras (signature headers, story context, etc.) */
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────
// CHANNEL CAPABILITIES
// ─────────────────────────────────────────────

/**
 * Declares what a channel supports so the AI engine can choose
 * the most appropriate response type.
 */
export interface ChannelCapabilities {
  channelType: ChannelType;
  supportsTemplates: boolean;
  supportsInteractiveMessages: boolean;
  supportsMedia: boolean;
  supportsVoice: boolean;
  supportsReactions: boolean;
  supportsReadReceipts: boolean;
  supportsPaymentLinks: boolean;
  maxMessageLength: number;
}

// ─────────────────────────────────────────────
// OUTBOUND MESSAGE
// ─────────────────────────────────────────────

/**
 * Payload the action executor sends to a channel adapter when
 * it wants to deliver a message to a client.
 */
export interface OutboundMessage {
  /** ID of the business's channel account to send from */
  channelAccountId: string;
  /** Channel-specific recipient identifier (phone number, IG user ID, etc.) */
  recipientExternalId: string;
  content: MessageContent;
  /** Set when this outbound message is in reply to an inbound one */
  replyToExternalId?: string;
  /** BullMQ job correlation for tracing */
  correlationId?: string;
}

// ─────────────────────────────────────────────
// CONFIDENCE SCORE
// ─────────────────────────────────────────────

/**
 * Breakdown of how the AI calculated its confidence score.
 * Formula: (dataAvailability × 0.5) + (policyClarity × 0.5)
 */
export interface ConfidenceScore {
  /** 0.0–1.0: how complete is the data needed to respond (catalog, client history, etc.) */
  dataAvailability: number;
  /** 0.0–1.0: how unambiguous are the business rules for this situation */
  policyClarity: number;
  /** Composite score after applying overrides */
  finalScore: number;
  /** Mode determined by the final score */
  mode: ConfidenceMode;
  /** Any hard overrides that forced the score down */
  overrides: ConfidenceOverride[];
}

export interface ConfidenceOverride {
  /** Machine-readable override key */
  code: string;
  /** Human-readable reason */
  reason: string;
  /** Score penalty applied (0.0–1.0, subtracted from composite) */
  penalty: number;
}

// ─────────────────────────────────────────────
// AI RESPONSE
// ─────────────────────────────────────────────

export interface SuggestedAction {
  /** Unique action type understood by the action executor */
  type: string;
  /** Action-specific parameters */
  parameters: Record<string, unknown>;
  /** Relative confidence in this specific action (0.0–1.0) */
  confidence: number;
}

// ─────────────────────────────────────────────
// API PRIMITIVES
// ─────────────────────────────────────────────

/**
 * Cursor-based paginated response for any list endpoint.
 */
export interface PaginatedResponse<T> {
  items: T[];
  /** Opaque cursor to pass as `after` in the next request */
  cursor: string | null;
  hasMore: boolean;
  /** Total count of records matching the filter (omitted when expensive) */
  total?: number;
}

/**
 * Standardised error shape returned by all API endpoints.
 * Mirrors the NestJS exception filter output.
 */
export interface ApiError {
  /** HTTP status code */
  statusCode: number;
  /** Human-readable error message */
  message: string;
  /** Machine-readable error code for client-side handling */
  code: string;
  /** Correlation ID for log tracing */
  traceId: string;
  /** ISO-8601 timestamp of when the error occurred */
  timestamp: string;
  /** Validation error details (present on 422 responses) */
  errors?: Record<string, string[]>;
}

// ─────────────────────────────────────────────
// CHANNEL ADAPTER CONTRACT
// ─────────────────────────────────────────────

export interface RawRequest {
  headers: Record<string, string>;
  body: unknown;
  rawBody?: Buffer;
  query?: Record<string, string>;
}

export interface SendResult {
  success: boolean;
  externalMessageId?: string;
  error?: string;
  sentAt?: Date;
  /** Number of send attempts made (including the initial try), for audit/observability. */
  attempts?: number;
}

export interface TemplateMessage {
  channelAccountId: string;
  recipientExternalId: string;
  templateName: string;
  language: string;
  parameters: Record<string, string>;
  correlationId?: string;
}

export interface InteractiveMessage {
  channelAccountId: string;
  recipientExternalId: string;
  interactiveType: string;
  header?: Record<string, unknown>;
  body: string;
  footer?: string;
  action: Record<string, unknown>;
  correlationId?: string;
}

export interface ChannelAdapter {
  readonly channelType: ChannelType;

  validateWebhook(req: RawRequest): boolean;
  parseInbound(req: RawRequest): NormalizedMessage;

  sendMessage(message: OutboundMessage): Promise<SendResult>;
  sendTemplate(template: TemplateMessage): Promise<SendResult>;
  sendInteractive(interactive: InteractiveMessage): Promise<SendResult>;

  getCapabilities(): ChannelCapabilities;

  downloadMedia(mediaId: string): Promise<Buffer>;
  uploadMedia(buffer: Buffer, mimeType: string): Promise<string>;
}

// ─────────────────────────────────────────────
// REALTY — BLTC REQUIREMENT PROFILE
// ─────────────────────────────────────────────

/**
 * The structured buyer requirement the AI extracts conversationally
 * (blueprint §16.2). Everything downstream — matching, cadences, the
 * exchange — keys off this object. Amounts are integer paise.
 *
 * A slot is "known" when its value is non-null; the BLTC state machine
 * asks for at most one unknown slot per turn and never re-asks a known one.
 */
export interface BltcProfile {
  /** Budget floor in paise (null = unknown). */
  budgetMinPaise: number | null;
  /** Budget ceiling in paise (null = unknown). */
  budgetMaxPaise: number | null;
  /** Preferred localities/corridors (empty = unknown). */
  localities: string[];
  /** Purchase horizon in months (null = unknown). */
  timelineMonths: number | null;
  /** Unit configuration, e.g. "2BHK" (null = unknown). */
  config: string | null;
  /** End-use vs investment (null = unknown). */
  purpose: LeadPurposeValue | null;
  /** Financing posture (null = unknown). */
  financing: FinancingStatusValue | null;
}

/** String-literal mirror of the LeadPurpose enum (shared has no runtime dep). */
export type LeadPurposeValue = 'END_USE' | 'INVEST';

/** String-literal mirror of the FinancingStatus enum. */
export type FinancingStatusValue = 'CASH' | 'PREAPPROVED' | 'NEEDS_LOAN';

/**
 * A single memory fact the AI must never lose (blueprint §5.1):
 * an extracted fact ("wife wants east-facing"), an objection, or a promise.
 */
export interface LeadMemoryEntry {
  text: string;
  /** ISO-8601 capture time. */
  at: string;
  /** Optional source message id for provenance. */
  messageId?: string;
}

/** Result of scoring a lead (blueprint §16.2 weights). */
export interface LeadScoreResult {
  /** 0–100 composite qualification score. */
  score: number;
  temperature: 'HOT' | 'WARM' | 'COLD' | 'JUNK';
  /** Per-factor contribution for explainability. */
  breakdown: {
    budgetFit: number;
    timeline: number;
    engagement: number;
    financing: number;
    purpose: number;
  };
}

/** A matched unit returned by the inventory matching service, ranked by fit. */
export interface UnitMatch {
  unitId: string;
  projectId: string;
  projectName: string;
  config: string;
  allInPricePaise: number;
  locality: string;
  /** 0–100 fit score. */
  fitScore: number;
  /** Why it matched — human-readable reasons for the broker/AI. */
  reasons: string[];
}

// ─────────────────────────────────────────────
// REALTY — EXCHANGE CONTRACTS (L2 co-broking, blueprint §19)
// ─────────────────────────────────────────────

/**
 * How the commission on a syndicated deal is split. Percentages are integer
 * basis-of-100 shares that MUST sum to 100 (e.g. the canonical 50:50 → 50/50).
 * The originator is the broker who owns the lead; the counterparty is the
 * inventory/closing side. An optional developer cut is carved out first.
 */
export interface SplitTerms {
  /** Originating broker's share of the commission pool, in percent (0–100). */
  originatorPct: number;
  /** Counterparty (inventory side) share, in percent (0–100). */
  counterpartyPct: number;
  /** Optional developer/channel-partner cut taken off the top, in percent. */
  developerPct?: number;
  /** Free-form note captured at offer time (e.g. "post-visit only"). */
  note?: string;
}

/**
 * A network-supply candidate surfaced by the exchange matcher — a unit or
 * resale listing from ANOTHER business, ranked by BLTC fit blended with the
 * counterparty's reliability score. This is the cross-tenant read that makes
 * the co-broking network liquid; only EXCHANGE-visible supply is ever exposed
 * and no private commission terms are carried.
 */
export interface ExchangeMatch {
  /** Source row id (a resale listing id or an EXCHANGE-visible unit id). */
  listingId: string;
  /** Which supply pool the candidate came from. */
  sourceType: 'RESALE' | 'UNIT';
  /** The counterparty business that owns the supply. */
  ownerBusinessId: string;
  projectName: string | null;
  locality: string;
  config: string;
  askingPricePaise: number;
  /** 0–100 BLTC fit score (config, price band, locality). */
  fitScore: number;
  /** 0–100 composite reliability of the counterparty at match time. */
  reliabilityScore: number;
  /** Ranking key: fit blended with counterparty reliability (0–100). */
  blendedScore: number;
  /** Human-readable reasons for the broker. */
  reasons: string[];
}

/** The four reliability sub-scores plus their weighted composite (all 0–100). */
export interface ReliabilityScoreBreakdown {
  responseSpeedScore: number;
  showupIntegrityScore: number;
  splitHonoringScore: number;
  documentationHygieneScore: number;
  compositeScore: number;
}

// ─────────────────────────────────────────────
// REALTY — INGESTION CONTRACTS (Phase 4, blueprint §15)
// ─────────────────────────────────────────────

/**
 * A normalized lead candidate produced by any ingestion path (Meta Leadgen,
 * portal-email parser, CSV import, CTWA context) and handed to
 * `RealtyLeadsService.ingestLead`, which owns the E.164 identity-merge.
 *
 * `whatsappPhone` is the join key — it MUST be normalized to E.164 by the
 * caller (`normalizeIndianPhone`). Fields left undefined are not written on a
 * merge (existing values are never clobbered by ingestion).
 */
export interface LeadIngestCandidate {
  /** E.164 phone — the cross-source identity key. */
  whatsappPhone: string;
  /** Attribution at birth — one of the LeadSource values. */
  source: string;
  /** Fine-grained source, e.g. "99acres", the ad/campaign, or portal name. */
  subSource?: string;
  /** The specific listing/ad/project the buyer enquired about (CTWA context). */
  listingRef?: string;
  name?: string;
  email?: string;
  altPhone?: string;
  languagePref?: string;
  /** Bridge to an existing conversation when the ingest arrived over a channel. */
  conversationId?: string;
  /** Bridge to an existing client record. */
  clientId?: string;
  /** Free-form provenance retained on lead metadata (raw form fields, headers). */
  raw?: Record<string, unknown>;
}

/** The outcome of an ingest: the resolved lead id and whether it merged. */
export interface LeadIngestResult {
  leadId: string;
  /** True when folded into an existing lead (same phone); false when created. */
  merged: boolean;
}

// ─────────────────────────────────────────────
// REALTY — AI LOOP CONTRACTS (blueprint §16)
// ─────────────────────────────────────────────

/** String-literal mirror of the RealtyIntent enum (shared has no runtime dep). */
export type RealtyIntentValue =
  | 'NEW_ENQUIRY'
  | 'PRICE_INQUIRY'
  | 'AVAILABILITY'
  | 'SITE_VISIT'
  | 'DOC_REQUEST'
  | 'LOCATION_AMENITY'
  | 'LOAN_QUERY'
  | 'NEGOTIATION'
  | 'LEGAL_RERA'
  | 'SELLER_LEAD'
  | 'RENTAL'
  | 'REACTIVATION_REPLY'
  | 'COMPLAINT_ABUSE'
  | 'GENERAL';

/** The four core BLTC slots the qualifier drives to completion. */
export type BltcSlot = 'budget' | 'location' | 'timeline' | 'config';

/**
 * The candidate BLTC values the extractor lifted from a single turn. Only the
 * slots the buyer actually mentioned are present; everything else is absent.
 */
export interface BltcExtraction {
  budgetMinPaise?: number | null;
  budgetMaxPaise?: number | null;
  localities?: string[];
  timelineMonths?: number | null;
  config?: string | null;
  purpose?: LeadPurposeValue | null;
  financing?: FinancingStatusValue | null;
}

/** A slot whose incoming value conflicts with a value already on file. */
export interface BltcContradiction {
  slot: string;
  existing: unknown;
  incoming: unknown;
}

/**
 * The BLTC state-machine's decision for one conversational turn: what it merged,
 * what conflicted, and the single question it should ask next (blueprint §16.2).
 */
export interface BltcTurnResult {
  /** Profile after merging non-conflicting extractions. */
  profile: BltcProfile;
  /** Names of slots newly filled this turn. */
  filledThisTurn: string[];
  /** Conflicts surfaced for a human — never silently overwritten. */
  contradictions: BltcContradiction[];
  /** The single slot to ask about next, or null when nothing remains. */
  nextSlotToAsk: BltcSlot | null;
  /** A ready-to-send question for `nextSlotToAsk`, or null. */
  nextQuestion: string | null;
  /** True when all 4 core BLTC slots are filled. */
  bltcComplete: boolean;
  /** True when complete AND the contact is reachable ⇒ QUALIFIED. */
  qualified: boolean;
}

/** A concrete side-effect the grounded turn wants the system to perform. */
export interface RealtyAction {
  type: string;
  parameters: Record<string, unknown>;
}

/**
 * The strict JSON contract the grounded realty turn returns (blueprint §16.3).
 * `confidence` is on a 0–100 scale to match the realty routing bands.
 */
export interface RealtyGroundedResponse {
  responseText: string | null;
  confidence: number;
  intent: RealtyIntentValue;
  bltcUpdates: BltcExtraction;
  stageTransition: string | null;
  actions: RealtyAction[];
  escalationReason?: string | null;
}

/** Routing mode chosen from a realty confidence score. */
export type RealtyRouteMode = 'AUTO' | 'DRAFT' | 'GUIDED' | 'ESCALATE';

/** A hard rule that fired and (usually) capped confidence downward. */
export interface RealtyOverride {
  code: string;
  reason: string;
}

/**
 * Realty confidence breakdown (blueprint §16.4):
 * finalScore = dataAvailability × 0.5 + policyClarity × 0.5, then hard-rule
 * overrides cap it. All components are on a 0–100 scale.
 */
export interface RealtyConfidence {
  dataAvailability: number;
  policyClarity: number;
  finalScore: number;
  mode: RealtyRouteMode;
  overrides: RealtyOverride[];
}

// ─────────────────────────────────────────────
// REALTY — CADENCES & COMPLIANCE (Phase 5)
// ─────────────────────────────────────────────

/**
 * An optional guard on a cadence step — the step only fires when the lead still
 * matches. Any field left undefined is not checked.
 */
export interface CadenceStepCondition {
  /** Only fire if the lead is still in one of these stages. */
  stageIn?: string[];
  /** Only fire if the lead's temperature is one of these. */
  temperatureIn?: string[];
  /** Only fire above this qualification score. */
  minQualScore?: number;
  /** Only fire at/below this qualification score. */
  maxQualScore?: number;
}

/**
 * The verdict of the WhatsApp compliance gate for a single outbound send
 * (blueprint §21). A send proceeds only when `allowed` is true.
 */
export interface ComplianceDecision {
  allowed: boolean;
  /** Machine-readable reason a send was blocked (`OK` when allowed). */
  code:
    | 'OK'
    | 'OPTED_OUT'
    | 'TEMPLATE_NOT_APPROVED'
    | 'MARKETING_OUTSIDE_WINDOW'
    | 'CATEGORY_MISMATCH'
    | 'NO_TEMPLATE';
  /** Human-readable explanation for the audit log / broker. */
  reason: string;
  /** Whether the send must go out as an approved template (window closed). */
  requiresTemplate: boolean;
}

// ─────────────────────────────────────────────
// REALTY — BROKER SURFACE (Phase 6)
// ─────────────────────────────────────────────

/**
 * The hot-lead dossier pushed to the broker the instant a lead turns HOT
 * (blueprint §16): who, what they want, where they came from, best-fit units,
 * and a one-tap takeover handle.
 */
export interface HotLeadDossier {
  leadId: string;
  name: string | null;
  whatsappPhone: string;
  qualScore: number;
  temperature: string;
  stage: string;
  source: string;
  bltcSummary: string;
  matchedUnitIds: string[];
  conversationId: string | null;
  assignedAgentId: string | null;
}

/** One line-item in the morning briefing. */
export interface BriefingItem {
  leadId: string;
  name: string | null;
  detail: string;
}

/**
 * The 7:30 AM broker digest (blueprint §16): today's visits, hot leads,
 * pending follow-ups due today, and a pipeline snapshot.
 */
export interface MorningBriefing {
  date: string; // ISO date (IST day)
  hotLeads: BriefingItem[];
  visitsToday: BriefingItem[];
  followupsDue: BriefingItem[];
  pendingApprovals: number;
  pipeline: Array<{ stage: string; count: number }>;
  generatedAt: string;
}

/** Aggregate metrics for the broker console header. */
export interface BrokerConsoleMetrics {
  activeLeads: number;
  hotLeads: number;
  pendingApprovals: number;
  followupsDueToday: number;
  activeCadences: number;
  autonomyLevel: string;
  aiHandledPct: number;
}

// ─────────────────────────────────────────────
// REALTY — PILOT MIGRATION (Phase 8, blueprint §22 / §24)
// ─────────────────────────────────────────────

/** One error against a specific 1-based row of a migration file. */
export interface MigrationRowError {
  row: number;
  reason: string;
}

/**
 * The outcome of a pilot-migration run — how many rows became new records, how
 * many folded into existing ones (E.164 identity merge for leads), and the
 * per-row errors. `dryRun` runs validate only and never persist.
 */
export interface MigrationSummary {
  kind: string; // MigrationKind
  status: string; // MigrationStatus
  dryRun: boolean;
  total: number;
  created: number;
  merged: number;
  skipped: number;
  errors: MigrationRowError[];
}

/**
 * A raw inventory-import row: one project and, optionally, one of its units in
 * the same line (the common "one row per unit" broker spreadsheet). Rows sharing
 * a project name+locality collapse into a single project with many units.
 */
export interface InventoryImportRow {
  projectName?: string;
  developer?: string;
  locality?: string;
  reraNumber?: string;
  possessionDate?: string; // ISO date
  projectStatus?: string; // ProjectStatus
  priceBandMin?: string | number; // rupees (converted to paise on commit)
  priceBandMax?: string | number;
  config?: string; // unit config e.g. 2BHK
  carpetSqft?: string | number;
  floor?: string | number;
  facing?: string;
  allInPrice?: string | number; // rupees
  availability?: string; // UnitAvailability
}

/** A validated project (with its units) ready to be committed to inventory. */
export interface NormalizedInventoryProject {
  name: string;
  developer?: string;
  locality: string;
  reraNumber?: string;
  possessionDate?: string;
  status?: string;
  priceBandMinPaise?: number;
  priceBandMaxPaise?: number;
  units: NormalizedInventoryUnit[];
}

export interface NormalizedInventoryUnit {
  config: string;
  carpetSqft?: number;
  floor?: number;
  facing?: string;
  allInPricePaise: number;
  availability?: string;
}

// ─────────────────────────────────────────────
// REALTY — AUTONOMY DIAL (evidence-driven, Phase 8)
// ─────────────────────────────────────────────

/** A rung on the autonomy ladder — a level+threshold with its evidence gates. */
export interface AutonomyRung {
  level: string; // AutonomyLevel
  threshold: number; // auto_approve_threshold (0–100)
  minDecisions: number; // resolved approvals observed
  minAccuracy: number; // fraction approved verbatim (0–1)
  minDays: number; // days the desk has been live
}

/** The evidence gathered for one autonomy-dial evaluation. */
export interface AutonomyEvidence {
  daysActive: number;
  decisionsObserved: number; // resolved approvals (approved+edited+rejected)
  approvedVerbatim: number;
  approvalAccuracy: number; // approvedVerbatim / decisionsObserved (0–1)
  noShipIncidents: number; // in the window — any > 0 forces CLOSE
  hotAlertActionRate: number; // 0–1, share of hot alerts acted on <30 min
}

/** The recommendation a dial evaluation produces (pure, from the ladder util). */
export interface AutonomyRecommendation {
  direction: string; // AutonomyDirection
  from: { level: string; threshold: number };
  to: { level: string; threshold: number };
  gatesFailed: string[]; // which evidence gates blocked an OPEN (empty on OPEN/CLOSE)
  reason: string;
  evidence: AutonomyEvidence;
}

// ─────────────────────────────────────────────
// REALTY — LAUNCH-READINESS GATE (Phase 8, blueprint §24)
// ─────────────────────────────────────────────

/**
 * The measured KPIs the launch gate evaluates. A null value means the metric
 * could not be measured for this business/window (→ INSUFFICIENT_DATA), which
 * blocks GO without hard-failing.
 */
export interface LaunchMetrics {
  responseP95Seconds: number | null; // < 60
  engagementRatePct: number | null; // ≥ 40
  qualificationRatePct: number | null; // ≥ 60
  visitsPer100Leads: number | null; // ≥ 8 (North Star)
  showUpRatePct: number | null; // ≥ 60
  aiAutonomyPct: number | null; // ≥ 70 (target 85)
  hotAlertActionRatePct: number | null; // ≥ 70 (<30 min)
  noShipIncidents: number; // must be 0 (aggregate)
  /** Per-kind no-ship counts (NoShipKind → count); powers the itemized checks. */
  noShipByKind?: Record<string, number>;
  totalLeads: number; // context for the report
}

/** One line of the launch-gate report. */
export interface LaunchGateCheck {
  key: string;
  label: string;
  status: string; // LaunchCheckStatus
  actual: number | null;
  threshold: number;
  comparator: 'gte' | 'lte' | 'eq';
  detail: string;
}

/** The full GO / NO-GO launch-readiness report (blueprint §24). */
export interface LaunchGateReport {
  status: string; // LaunchGateStatus
  kpiChecks: LaunchGateCheck[];
  noShipChecks: LaunchGateCheck[];
  passed: number;
  failed: number;
  insufficient: number;
  windowDays: number | null;
  generatedAt: string;
}
