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

  const { finalScore, overrides } = applyOverrides(base, input);
  return {
    dataAvailability,
    policyClarity,
    finalScore,
    mode: toMode(finalScore),
    overrides,
  };
}

/** Map a 0–100 score to a routing mode. */
export function toMode(score: number): RealtyRouteMode {
  if (score >= REALTY_AUTO) return 'AUTO';
  if (score >= REALTY_DRAFT) return 'DRAFT';
  if (score >= REALTY_GUIDED) return 'GUIDED';
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
): { finalScore: number; overrides: RealtyOverride[] } {
  const overrides: RealtyOverride[] = [];
  let ceiling = base;

  const cap = (code: string, reason: string, max: number): void => {
    if (max < ceiling) ceiling = max;
    overrides.push({ code, reason });
  };

  // Intent autonomy ceiling (blueprint §16.3): the intent's policy caps the band.
  const policy = REALTY_INTENT_POLICY[input.intent];
  if (policy === RealtyRoutePolicy.DRAFT_ONLY && base >= REALTY_AUTO) {
    cap('policy_draft_only', `${input.intent} may never auto-send — draft for review`, REALTY_AUTO - 1);
  }
  if (policy === RealtyRoutePolicy.ESCALATE) {
    cap('policy_escalate', `${input.intent} is always a human hand-off`, REALTY_GUIDED - 1);
  }

  // Guardrail overrides.
  for (const v of input.guard.violations) {
    if (v.severity === 'BLOCK') {
      cap(v.code, v.reason, REALTY_GUIDED - 1); // force ESCALATE band
    } else {
      // REWRITE (stale availability) — cap to GUIDED so a human confirms.
      cap(v.code, v.reason, REALTY_DRAFT - 1);
    }
  }

  return { finalScore: clamp(ceiling), overrides };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
