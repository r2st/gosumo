/**
 * The evidence-driven autonomy ladder (Phase 8, blueprint §22 / §24).
 *
 * The pilot autonomy dial "opens gradually based on evidence": it starts fully
 * supervised (SUGGEST, every draft approved by a human) and only widens one rung
 * at a time as the desk accumulates evidence — enough resolved drafts, a high
 * enough verbatim-approval accuracy, and enough days live. A single no-ship
 * incident slams the dial shut back to the safe floor.
 *
 * Pure + fully unit-tested; the service layer applies the recommendation.
 */

import { AutonomyLevel, AutonomyDirection } from '@gosumo/shared';
import type {
  AutonomyRung,
  AutonomyEvidence,
  AutonomyRecommendation,
} from '@gosumo/shared';

/**
 * The ordered ladder, from most-supervised (index 0) to most-autonomous. Each
 * rung's evidence gates must ALL be met to advance onto it. Lowering the
 * `threshold` means the AI auto-sends at a lower confidence — i.e. more often.
 */
export const AUTONOMY_LADDER: AutonomyRung[] = [
  { level: AutonomyLevel.SUGGEST, threshold: 90, minDecisions: 0, minAccuracy: 0, minDays: 0 },
  { level: AutonomyLevel.ASSISTED, threshold: 90, minDecisions: 20, minAccuracy: 0.7, minDays: 3 },
  { level: AutonomyLevel.ASSISTED, threshold: 85, minDecisions: 50, minAccuracy: 0.8, minDays: 7 },
  { level: AutonomyLevel.ASSISTED, threshold: 80, minDecisions: 100, minAccuracy: 0.85, minDays: 14 },
  { level: AutonomyLevel.AUTONOMOUS, threshold: 80, minDecisions: 200, minAccuracy: 0.9, minDays: 21 },
];

const LEVEL_RANK: Record<string, number> = {
  [AutonomyLevel.SUGGEST]: 0,
  [AutonomyLevel.ASSISTED]: 1,
  [AutonomyLevel.AUTONOMOUS]: 2,
};

/** The safe floor the dial resets to on any no-ship incident. */
export const AUTONOMY_FLOOR: AutonomyRung = AUTONOMY_LADDER[0]!;

/** A rung is "already achieved" by `current` if current is at least as open. */
function isAtLeastAsOpen(
  current: { level: string; threshold: number },
  rung: AutonomyRung,
): boolean {
  const cRank = LEVEL_RANK[current.level] ?? 0;
  const rRank = LEVEL_RANK[rung.level] ?? 0;
  if (cRank !== rRank) return cRank > rRank;
  // Same level ⇒ a lower/equal threshold is at least as open.
  return current.threshold <= rung.threshold;
}

/** Map arbitrary current settings onto the highest ladder rung already reached. */
export function currentRungIndex(current: { level: string; threshold: number }): number {
  let idx = 0;
  for (let i = 0; i < AUTONOMY_LADDER.length; i++) {
    if (isAtLeastAsOpen(current, AUTONOMY_LADDER[i]!)) idx = i;
  }
  return idx;
}

/**
 * Decide how the dial should move given the current setting + gathered evidence.
 * Never opens more than one rung; any no-ship incident forces a CLOSE.
 */
export function evaluateAutonomyLadder(
  current: { level: string; threshold: number },
  evidence: AutonomyEvidence,
): AutonomyRecommendation {
  const from = { level: current.level, threshold: current.threshold };

  // A no-ship incident is disqualifying — pull the dial back to the floor.
  if (evidence.noShipIncidents > 0) {
    const to = { level: AUTONOMY_FLOOR.level, threshold: AUTONOMY_FLOOR.threshold };
    const changed = to.level !== from.level || to.threshold !== from.threshold;
    return {
      direction: changed ? AutonomyDirection.CLOSE : AutonomyDirection.HOLD,
      from,
      to,
      gatesFailed: ['no_ship_incident'],
      reason: changed
        ? `${evidence.noShipIncidents} no-ship incident(s) — dial reset to the supervised floor`
        : `${evidence.noShipIncidents} no-ship incident(s) — already at the supervised floor`,
      evidence,
    };
  }

  const idx = currentRungIndex(current);
  const lastIndex = AUTONOMY_LADDER.length - 1;

  if (idx >= lastIndex) {
    return {
      direction: AutonomyDirection.HOLD,
      from,
      to: from,
      gatesFailed: [],
      reason: 'Already at maximum autonomy',
      evidence,
    };
  }

  const next = AUTONOMY_LADDER[idx + 1]!;
  const gatesFailed: string[] = [];
  if (evidence.decisionsObserved < next.minDecisions) gatesFailed.push('decisions');
  if (evidence.approvalAccuracy < next.minAccuracy) gatesFailed.push('accuracy');
  if (evidence.daysActive < next.minDays) gatesFailed.push('days');
  // Opening the dial to full autonomy additionally requires responsive hot-alert handling.
  if (next.level === AutonomyLevel.AUTONOMOUS && evidence.hotAlertActionRate < 0.7) {
    gatesFailed.push('hot_alert_action');
  }

  if (gatesFailed.length === 0) {
    return {
      direction: AutonomyDirection.OPEN,
      from,
      to: { level: next.level, threshold: next.threshold },
      gatesFailed: [],
      reason: `Evidence met — opening to ${next.level} @ ${next.threshold}`,
      evidence,
    };
  }

  return {
    direction: AutonomyDirection.HOLD,
    from,
    to: from,
    gatesFailed,
    reason: `Holding — gates not yet met: ${gatesFailed.join(', ')}`,
    evidence,
  };
}
