/**
 * GoSumo Realty — Phase 7 (Hardening) shared constants.
 *
 * Central knobs for audit, retries/DLQ, rate limits, and soak readiness so the
 * whole surface can be tuned from one place during the 7-day unattended soak.
 */

// ─────────────────────────────────────────────
// Dead-letter queue
// ─────────────────────────────────────────────

/** BullMQ queue that carries realty DLQ replay jobs. */
export const REALTY_DLQ_QUEUE = 'realty-dlq';

export const REALTY_DLQ_JOBS = {
  REPLAY: 'dlq.replay',
} as const;

/** Retry policy for inline realty operations wrapped by `runWithRetry`. */
export interface RetryPolicy {
  /** Total attempts including the first (>=1). */
  attempts: number;
  /** Base backoff in ms; grows exponentially per attempt. */
  backoffMs: number;
  /** Cap on any single backoff sleep. */
  maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  backoffMs: 200,
  maxBackoffMs: 5_000,
};

/** A replayed DLQ entry is retried at most this many times before giving up. */
export const DLQ_MAX_REPLAYS = 5;

// ─────────────────────────────────────────────
// API rate limits (per business, fixed-window)
// ─────────────────────────────────────────────

export interface RateLimitRule {
  /** Max requests allowed inside the window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Default ceiling applied to every realty route unless a route overrides it via
 * `@RealtyRateLimit()`. Sized for a broker console + AI loop on one tenant:
 * 120 writes/min is generous for humans yet blocks a runaway loop.
 */
export const DEFAULT_REALTY_RATE_LIMIT: RateLimitRule = {
  limit: 120,
  windowMs: 60_000,
};

/**
 * Tighter ceilings for expensive or abuse-prone route groups, keyed by the
 * bucket name passed to `@RealtyRateLimit('<bucket>')`.
 */
export const REALTY_RATE_LIMIT_BUCKETS: Record<string, RateLimitRule> = {
  // AI turn processing is costly (LLM spend) — throttle hard per tenant.
  'ai-turn': { limit: 30, windowMs: 60_000 },
  // DLQ replay can re-trigger outbound sends — keep it deliberate.
  'dlq-replay': { limit: 20, windowMs: 60_000 },
  // Lead ingestion bursts from portal/CSV imports; allow more headroom.
  ingest: { limit: 300, windowMs: 60_000 },
};

// ─────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────

/** HTTP methods that mutate state and must therefore be audited. */
export const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Map a URL path segment under `realty/` to the audit `resource_type` recorded
 * on the append-only `audit_logs` row. Falls back to the raw first segment.
 */
export const REALTY_RESOURCE_TYPES: Record<string, string> = {
  leads: 'realty_lead',
  inventory: 'realty_inventory',
  projects: 'realty_project',
  units: 'realty_unit',
  assets: 'realty_asset',
  sitevisits: 'realty_site_visit',
  visits: 'realty_site_visit',
  cadences: 'realty_cadence',
  cadence: 'realty_cadence',
  templates: 'realty_message_template',
  broker: 'realty_broker',
  approvals: 'realty_approval',
  ai: 'realty_ai',
  ops: 'realty_ops',
};

// ─────────────────────────────────────────────
// Soak readiness thresholds
// ─────────────────────────────────────────────

/** DLQ depth (PENDING entries) at/above which readiness degrades to "warn". */
export const DLQ_DEPTH_WARN = 25;
/** DLQ depth at/above which readiness fails outright. */
export const DLQ_DEPTH_FAIL = 100;

// ─────────────────────────────────────────────
// Domain event names (local — not part of @gosumo/shared)
// ─────────────────────────────────────────────

export const REALTY_HARDENING_EVENTS = {
  DEAD_LETTER_CAPTURED: 'realty.deadletter.captured',
  DEAD_LETTER_REPLAYED: 'realty.deadletter.replayed',
  DEAD_LETTER_RESOLVED: 'realty.deadletter.resolved',
} as const;
