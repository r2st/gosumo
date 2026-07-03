import type { ReliabilityScoreBreakdown } from '@gosumo/shared';

/**
 * The raw per-member deal signals a reliability score is computed from. Every
 * field is a plain count / average so the scorer is pure and deterministic.
 * A brand-new member with no history yields all-neutral (≈50) — trusted enough
 * to appear in matches, not so much that it outranks proven counterparties.
 */
export interface ReliabilitySignals {
  /** Average minutes to first response on a syndicated lead (null = no data). */
  avgFirstResponseMinutes: number | null;
  /** Site visits the member committed to host. */
  visitsScheduled: number;
  /** Of those, how many actually happened (buyer + broker both showed). */
  visitsHonored: number;
  /** Deals that reached CLOSED with this member on the other side. */
  syndicationsClosed: number;
  /** Of those, how many settled the agreed split without a dispute. */
  splitsHonored: number;
  /** Disputes raised against this member in the window (heavy penalty). */
  disputes: number;
  /** Syndications that carried complete documentation (agreement, KYC, RERA). */
  syndicationsWithDocs: number;
  /** Total syndications the member was party to in the window. */
  syndicationsTotal: number;
}

/**
 * Composite weights (sum = 100). Split-honoring dominates: a broker who pockets
 * a partner's half is the single behaviour the exchange exists to punish. Show-up
 * integrity and response speed protect the buyer experience; documentation
 * hygiene protects settlement.
 */
export const RELIABILITY_WEIGHTS = {
  responseSpeed: 25,
  showupIntegrity: 25,
  splitHonoring: 30,
  documentationHygiene: 20,
} as const;

/** The neutral score assigned to any dimension with no evidence yet. */
export const NEUTRAL_SCORE = 50;

/**
 * Response-speed scoring band. ≤ 5 min → 100; ≥ 120 min → 0; linear between.
 * These mirror the "answer every lead in under 30 seconds" north-star softened
 * to human-broker realities on the co-broking side.
 */
const RESPONSE_FAST_MINUTES = 5;
const RESPONSE_SLOW_MINUTES = 120;

/**
 * Compute a member's four reliability sub-scores and their weighted composite,
 * each on a 0–100 scale. Pure and deterministic — the persistence/period logic
 * lives in the service; this only turns signals into numbers.
 */
export function computeReliabilityScore(signals: ReliabilitySignals): ReliabilityScoreBreakdown {
  const responseSpeedScore = scoreResponseSpeed(signals.avgFirstResponseMinutes);
  const showupIntegrityScore = ratioScore(signals.visitsHonored, signals.visitsScheduled);
  const splitHonoringScore = scoreSplitHonoring(signals);
  const documentationHygieneScore = ratioScore(
    signals.syndicationsWithDocs,
    signals.syndicationsTotal,
  );

  const compositeRaw =
    (responseSpeedScore * RELIABILITY_WEIGHTS.responseSpeed +
      showupIntegrityScore * RELIABILITY_WEIGHTS.showupIntegrity +
      splitHonoringScore * RELIABILITY_WEIGHTS.splitHonoring +
      documentationHygieneScore * RELIABILITY_WEIGHTS.documentationHygiene) /
    100;

  return {
    responseSpeedScore: round2(responseSpeedScore),
    showupIntegrityScore: round2(showupIntegrityScore),
    splitHonoringScore: round2(splitHonoringScore),
    documentationHygieneScore: round2(documentationHygieneScore),
    compositeScore: round2(compositeRaw),
  };
}

/** Faster is better; no data → neutral. */
function scoreResponseSpeed(avgMinutes: number | null): number {
  if (avgMinutes == null) return NEUTRAL_SCORE;
  if (avgMinutes <= RESPONSE_FAST_MINUTES) return 100;
  if (avgMinutes >= RESPONSE_SLOW_MINUTES) return 0;
  const span = RESPONSE_SLOW_MINUTES - RESPONSE_FAST_MINUTES;
  return clamp(100 * (1 - (avgMinutes - RESPONSE_FAST_MINUTES) / span));
}

/**
 * Split-honoring: the share of closed deals whose split was honoured, with each
 * dispute subtracting a full deal's worth of credit (disputes are the worst
 * signal on the network). No closed deals yet → neutral.
 */
function scoreSplitHonoring(signals: ReliabilitySignals): number {
  const { syndicationsClosed, splitsHonored, disputes } = signals;
  if (syndicationsClosed <= 0) return NEUTRAL_SCORE;
  const honored = Math.max(0, splitsHonored - disputes);
  return clamp((honored / syndicationsClosed) * 100);
}

/** Generic numerator/denominator → 0–100; empty denominator → neutral. */
function ratioScore(numerator: number, denominator: number): number {
  if (denominator <= 0) return NEUTRAL_SCORE;
  return clamp((numerator / denominator) * 100);
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
