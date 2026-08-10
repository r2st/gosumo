import type { BltcProfile } from '@gosumo/shared';

/**
 * BLTC data-consistency validation (Phase 7 hardening).
 *
 * The lead qualification loop already surfaces *slot-overwrite* contradictions
 * (a new value disagreeing with a filled slot). This module adds *internal*
 * consistency validation over a whole BLTC profile — logically impossible states
 * (budget floor above ceiling) and implausible ones (a 4BHK inside a ₹20L
 * budget) — so bad data is caught before it drives a match or an autonomous
 * reply during the unattended soak.
 *
 * Pure + deterministic (no market lookups) so it is fully unit-testable and safe
 * to run on every BLTC write.
 */

export type ContradictionSeverity = 'ERROR' | 'WARN';

export interface BltcContradiction {
  /** Stable machine code for dashboards/tests. */
  code: string;
  severity: ContradictionSeverity;
  /** BLTC slot(s) involved. */
  slots: string[];
  message: string;
}

export interface BltcContradictionResult {
  consistent: boolean;
  /** True when at least one ERROR-severity contradiction is present. */
  hasErrors: boolean;
  contradictions: BltcContradiction[];
}

const LAKH_PAISE = 1e7;
const CRORE_PAISE = 1e9;
/** Absurd upper bound for a residential purchase horizon (10 years). */
const MAX_TIMELINE_MONTHS = 120;

/**
 * Rough per-config metro price floors (paise) used only to flag a budget that is
 * implausibly low for the requested configuration. Deliberately conservative —
 * these are WARN-level heuristics, never hard blocks. Keyed by normalized config.
 */
const CONFIG_FLOOR_PAISE: Record<string, number> = {
  '1RK': 8 * LAKH_PAISE,
  '1BHK': 15 * LAKH_PAISE,
  '2BHK': 25 * LAKH_PAISE,
  '3BHK': 40 * LAKH_PAISE,
  '4BHK': 60 * LAKH_PAISE,
  '5BHK': 100 * LAKH_PAISE,
};

/** Normalize a free-form config string to a canonical key, e.g. "2 bhk" → "2BHK". */
export function normalizeConfig(config: string | null | undefined): string | null {
  if (!config) return null;
  const compact = config.replace(/\s+/g, '').toUpperCase();
  const m = compact.match(/^(\d+)(BHK|RK)$/);
  return m ? `${m[1]}${m[2]}` : compact;
}

/**
 * Validate a BLTC profile's internal consistency. Returns every contradiction
 * found (ERROR = logically impossible, WARN = implausible-but-possible).
 */
export function validateBltcProfile(profile: BltcProfile): BltcContradictionResult {
  const out: BltcContradiction[] = [];
  const { budgetMinPaise, budgetMaxPaise, localities, timelineMonths, config } = profile;

  // ── Budget ──────────────────────────────────
  if (budgetMinPaise != null && budgetMinPaise < 0) {
    out.push({
      code: 'budget_min_negative',
      severity: 'ERROR',
      slots: ['budgetMinPaise'],
      message: 'Budget floor cannot be negative',
    });
  }
  if (budgetMaxPaise != null && budgetMaxPaise < 0) {
    out.push({
      code: 'budget_max_negative',
      severity: 'ERROR',
      slots: ['budgetMaxPaise'],
      message: 'Budget ceiling cannot be negative',
    });
  }
  if (
    budgetMinPaise != null &&
    budgetMaxPaise != null &&
    budgetMinPaise >= 0 &&
    budgetMaxPaise >= 0 &&
    budgetMinPaise > budgetMaxPaise
  ) {
    out.push({
      code: 'budget_min_gt_max',
      severity: 'ERROR',
      slots: ['budgetMinPaise', 'budgetMaxPaise'],
      message: `Budget floor (₹${paiseToLakh(budgetMinPaise)}L) is above the ceiling (₹${paiseToLakh(
        budgetMaxPaise,
      )}L)`,
    });
  }
  // A ceiling above ~₹100Cr is almost certainly a paise/rupee unit error.
  if (budgetMaxPaise != null && budgetMaxPaise > 100 * CRORE_PAISE) {
    out.push({
      code: 'budget_implausibly_high',
      severity: 'WARN',
      slots: ['budgetMaxPaise'],
      message: 'Budget ceiling exceeds ₹100Cr — check for a paise/rupee unit error',
    });
  }

  // ── Timeline ────────────────────────────────
  if (timelineMonths != null && timelineMonths < 0) {
    out.push({
      code: 'timeline_negative',
      severity: 'ERROR',
      slots: ['timelineMonths'],
      message: 'Purchase timeline cannot be negative',
    });
  }
  if (timelineMonths != null && timelineMonths > MAX_TIMELINE_MONTHS) {
    out.push({
      code: 'timeline_implausible',
      severity: 'WARN',
      slots: ['timelineMonths'],
      message: `Purchase timeline of ${timelineMonths} months is beyond a realistic ${MAX_TIMELINE_MONTHS}-month horizon`,
    });
  }

  // ── Localities ──────────────────────────────
  if (Array.isArray(localities) && localities.length > 0) {
    if (localities.some((l) => typeof l !== 'string' || l.trim() === '')) {
      out.push({
        code: 'locality_blank',
        severity: 'WARN',
        slots: ['localities'],
        message: 'Localities contain a blank entry',
      });
    }
    const seen = new Set<string>();
    const dupes = localities.some((l) => {
      const key = String(l).trim().toLowerCase();
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (dupes) {
      out.push({
        code: 'locality_duplicate',
        severity: 'WARN',
        slots: ['localities'],
        message: 'Localities contain duplicate entries',
      });
    }
  }

  // ── Config vs budget plausibility ───────────
  const normConfig = normalizeConfig(config);
  if (normConfig && CONFIG_FLOOR_PAISE[normConfig] != null && budgetMaxPaise != null) {
    const floor = CONFIG_FLOOR_PAISE[normConfig]!;
    if (budgetMaxPaise > 0 && budgetMaxPaise < floor) {
      out.push({
        code: 'budget_below_config_floor',
        severity: 'WARN',
        slots: ['budgetMaxPaise', 'config'],
        message: `A ${normConfig} is unlikely within a ₹${paiseToLakh(
          budgetMaxPaise,
        )}L ceiling (typical floor ~₹${paiseToLakh(floor)}L)`,
      });
    }
  }

  const hasErrors = out.some((c) => c.severity === 'ERROR');
  return { consistent: out.length === 0, hasErrors, contradictions: out };
}

/**
 * Validate an incoming partial BLTC update against the existing profile:
 * returns the slots where the incoming value conflicts with a filled slot
 * (mirrors the merge-time surfacing, centralized for reuse) PLUS any internal
 * contradiction the *merged* result would introduce.
 */
export function validateBltcMerge(
  existing: BltcProfile,
  incoming: Partial<BltcProfile>,
): BltcContradictionResult {
  const out: BltcContradiction[] = [];

  const conflict = <K extends keyof BltcProfile>(
    slot: K,
    filled: (v: BltcProfile[K]) => boolean,
    differs: (a: BltcProfile[K], b: BltcProfile[K]) => boolean,
  ): void => {
    if (!(slot in incoming) || incoming[slot] === undefined) return;
    const cur = existing[slot];
    const inc = incoming[slot] as BltcProfile[K];
    if (filled(cur) && differs(cur, inc)) {
      out.push({
        code: 'slot_overwrite_conflict',
        severity: 'WARN',
        slots: [String(slot)],
        message: `Incoming ${String(slot)} (${JSON.stringify(inc)}) conflicts with the recorded value (${JSON.stringify(
          cur,
        )})`,
      });
    }
  };

  conflict('budgetMinPaise', (v) => v != null, (a, b) => a !== b);
  conflict('budgetMaxPaise', (v) => v != null, (a, b) => a !== b);
  conflict('timelineMonths', (v) => v != null, (a, b) => a !== b);
  conflict('config', (v) => v != null, (a, b) => a !== b);
  conflict('purpose', (v) => v != null, (a, b) => a !== b);
  conflict('financing', (v) => v != null, (a, b) => a !== b);
  conflict(
    'localities',
    (v) => Array.isArray(v) && v.length > 0,
    (a, b) => JSON.stringify(a) !== JSON.stringify(b),
  );

  // Fold the merged profile through the internal validator too.
  const merged: BltcProfile = { ...existing, ...stripUndefined(incoming) };
  const internal = validateBltcProfile(merged);
  out.push(...internal.contradictions);

  const hasErrors = out.some((c) => c.severity === 'ERROR');
  return { consistent: out.length === 0, hasErrors, contradictions: out };
}

function stripUndefined(obj: Partial<BltcProfile>): Partial<BltcProfile> {
  const out: Partial<BltcProfile> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function paiseToLakh(paise: number): string {
  return (paise / LAKH_PAISE).toFixed(paise % LAKH_PAISE === 0 ? 0 : 1);
}
