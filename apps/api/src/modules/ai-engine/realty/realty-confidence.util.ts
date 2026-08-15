import { RealtyIntent, RealtyRoutePolicy } from '@gosumo/shared';
import type { RealtyConfidence, RealtyRouteMode, RealtyOverride } from '@gosumo/shared';
import {
  REALTY_AUTO,
  REALTY_DRAFT,
  REALTY_GUIDED,
  REALTY_WEIGHT_DATA,
  REALTY_WEIGHT_POLICY,
  REALTY_INTENT_POLICY,
} from './realty-intent.constants';
import type { RealtyGuardResult } from './realty-guardrails.service';
import { resolveBands } from '../pipeline/confidence-calculator.service';

/**
 * The realty routing band edges, on this file's own 0–100 scale.
 *
 * They exist as a value rather than as the three module constants because they
 * are per-tenant: `businesses.ai_settings` holds an `autoExecuteThreshold` /
 * `reviewThreshold` pair that the settings page collects and
 * `AiEngineService.updateConfidenceThresholds` writes.
 */
export interface RealtyBands {
  auto: number;
  draft: number;
  guided: number;
}

export const DEFAULT_REALTY_BANDS: RealtyBands = {
  auto: REALTY_AUTO,
  draft: REALTY_DRAFT,
  guided: REALTY_GUIDED,
};

/**
 * Turn a tenant's stored thresholds into realty band edges.
 *
 * The generic pipeline has honoured `ai_settings` since the bands became
 * configurable; this one did not, and read the three module constants instead.
 * A realty tenant could therefore raise their auto-execute gate to 95 in the
 * settings UI, get a 200 back, see the new number on reload — and still have
 * the AI auto-send at 90, because the only pipeline that ever ran for them
 * never read the field. It fails in the unsafe direction (the gate a tenant
 * tightened stays loose) and it is invisible from outside: the stored value and
 * the displayed value agree, and only the routing disagrees with both.
 *
 * Validation is deliberately not re-implemented here. {@link resolveBands} is
 * the one place that decides which threshold pairs are usable — inverted pairs,
 * out-of-range values, and the two floors that stop a tenant deleting human
 * review or human hand-off entirely all fall back to the defaults there — and
 * a second copy of those rules is a second thing to drift. The only difference
 * is the scale: that function answers in 0–1 because the generic calculator
 * scores in 0–1, and this file scores in 0–100.
 */
export function resolveRealtyBands(thresholds?: {
  autoExecute?: number;
  draftReview?: number;
}): RealtyBands {
  const bands = resolveBands(thresholds);
  return {
    auto: toPercent(bands.autoExecute),
    draft: toPercent(bands.draftReview),
    guided: toPercent(bands.guided),
  };
}

/**
 * 0–1 back to 0–100.
 *
 * Rounded rather than multiplied straight, because `0.9 * 100` is
 * `90.00000000000001` in IEEE-754 and a score of exactly 90 would then fail
 * `>= auto` — the default tenant would silently lose the top of their
 * auto-execute band to a floating-point artifact. Four decimal places is well
 * inside anything a percent threshold can express and recovers whole numbers
 * exactly.
 */
function toPercent(fraction: number): number {
  return Math.round(fraction * 100 * 10_000) / 10_000;
}

/**
 * The highest integer score that still falls *below* `band`.
 *
 * Override ceilings are expressed as "force this into the band below", which
 * was written `REALTY_AUTO - 1` while the bands were constants. With per-tenant
 * bands that subtraction is wrong in the direction that matters: a tenant who
 * lowers their auto gate to 60 would get a `policy_draft_only` ceiling of 89,
 * which is *above* their own auto edge — so the one intent class that may never
 * auto-send would auto-send. Scores are integers (see {@link clamp}), so the
 * band below starts at `ceil(band) - 1` whether or not the edge is whole.
 */
function justBelow(band: number): number {
  return Math.ceil(band) - 1;
}

/**
 * Signals that feed the two confidence components (all 0–100).
 */
export interface RealtyConfidenceInput {
  intent: RealtyIntent;
  /** Number of verified, fresh units matched to the buyer's BLTC. */
  matchedUnitCount: number;
  /** A verified fact sheet / price sheet exists for the matched project(s). */
  verifiedSheetPresent: boolean;
  /** How many of the 4 core BLTC slots are filled (0–4). */
  bltcSlotsFilled: number;
  /** RAG chunks retrieved from the sales playbook. */
  ragChunkCount: number;
  /** The guardrail verdict for the proposed response. */
  guard: RealtyGuardResult;
  /**
   * The tenant's own routing bands, in percent, as stored in
   * `businesses.ai_settings`. Omitted (or unusable) falls back to the module
   * defaults — see {@link resolveRealtyBands}.
   */
  thresholds?: { autoExecute?: number; draftReview?: number };
}

/**
 * Compute realty confidence (blueprint §16.4):
 *
 *   finalScore = dataAvailability × 0.5 + policyClarity × 0.5
 *
 * then apply hard-rule overrides. Overrides can only ever LOWER the score:
 * the final is the minimum of the base and every matched override ceiling.
 * Bands: ≥90 AUTO · 70–89 DRAFT · 50–69 GUIDED · <50 ESCALATE.
 *
 * Pure and deterministic.
 */
export function computeRealtyConfidence(input: RealtyConfidenceInput): RealtyConfidence {
  const dataAvailability = scoreData(input);
  const policyClarity = scorePolicy(input);

  const base = Math.round(
    dataAvailability * REALTY_WEIGHT_DATA + policyClarity * REALTY_WEIGHT_POLICY,
  );

  const bands = resolveRealtyBands(input.thresholds);
  const { finalScore, overrides } = applyOverrides(base, input, bands);
  return {
    dataAvailability,
    policyClarity,
    finalScore,
    mode: toMode(finalScore, bands),
    overrides,
  };
}

/**
 * Map a 0–100 score to a routing mode.
 *
 * `bands` defaults to the module constants, so callers that do not know the
 * tenant keep the documented 90 / 70 / 50 behaviour.
 */
export function toMode(
  score: number,
  bands: RealtyBands = DEFAULT_REALTY_BANDS,
): RealtyRouteMode {
  if (score >= bands.auto) return 'AUTO';
  if (score >= bands.draft) return 'DRAFT';
  if (score >= bands.guided) return 'GUIDED';
  return 'ESCALATE';
}

// ─────────────────────────────────────────────
// Component scoring
// ─────────────────────────────────────────────

function scoreData(input: RealtyConfidenceInput): number {
  // Matched inventory is the strongest data signal.
  const match =
    input.matchedUnitCount >= 2 ? 100 : input.matchedUnitCount === 1 ? 75 : 30;
  const sheet = input.verifiedSheetPresent ? 100 : 30;
  const bltc = (Math.min(input.bltcSlotsFilled, 4) / 4) * 100;
  const rag = input.ragChunkCount >= 3 ? 100 : input.ragChunkCount >= 1 ? 65 : 30;
  return Math.round(match * 0.35 + sheet * 0.3 + bltc * 0.2 + rag * 0.15);
}

function scorePolicy(input: RealtyConfidenceInput): number {
  const policy = REALTY_INTENT_POLICY[input.intent];
  // A clear autonomy policy with no guardrail issues is maximally unambiguous.
  let base: number;
  switch (policy) {
    case RealtyRoutePolicy.AUTO_ALLOWED:
      base = 100;
      break;
    case RealtyRoutePolicy.DRAFT_ONLY:
      base = 75;
      break;
    case RealtyRoutePolicy.ESCALATE:
    default:
      base = 40;
      break;
  }
  // Any guardrail violation muddies policy clarity.
  if (input.guard.violations.length > 0) {
    base = Math.min(base, input.guard.mustEscalate ? 30 : 55);
  }
  return base;
}

// ─────────────────────────────────────────────
// Hard overrides & intent-policy ceilings
// ─────────────────────────────────────────────

function applyOverrides(
  base: number,
  input: RealtyConfidenceInput,
  bands: RealtyBands,
): { finalScore: number; overrides: RealtyOverride[] } {
  const overrides: RealtyOverride[] = [];
  let ceiling = base;

  const cap = (code: string, reason: string, max: number): void => {
    if (max < ceiling) ceiling = max;
    overrides.push({ code, reason });
  };

  // Intent autonomy ceiling (blueprint §16.3): the intent's policy caps the band.
  const policy = REALTY_INTENT_POLICY[input.intent];
  if (policy === RealtyRoutePolicy.DRAFT_ONLY && base >= bands.auto) {
    cap(
      'policy_draft_only',
      `${input.intent} may never auto-send — draft for review`,
      justBelow(bands.auto),
    );
  }
  if (policy === RealtyRoutePolicy.ESCALATE) {
    cap('policy_escalate', `${input.intent} is always a human hand-off`, justBelow(bands.guided));
  }

  // Guardrail overrides.
  for (const v of input.guard.violations) {
    if (v.severity === 'BLOCK') {
      cap(v.code, v.reason, justBelow(bands.guided)); // force ESCALATE band
    } else {
      // REWRITE (stale availability) — cap to GUIDED so a human confirms.
      cap(v.code, v.reason, justBelow(bands.draft));
    }
  }

  return { finalScore: clamp(ceiling), overrides };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
