/**
 * Pure autonomy-ladder tests (Phase 8). Verifies one-rung-at-a-time opening,
 * evidence gating, and the no-ship CLOSE-to-floor rule.
 */

import { AutonomyLevel, AutonomyDirection } from '@gosumo/shared';
import type { AutonomyEvidence } from '@gosumo/shared';
import {
  evaluateAutonomyLadder,
  currentRungIndex,
  AUTONOMY_LADDER,
} from './autonomy-ladder.util';

const strongEvidence: AutonomyEvidence = {
  daysActive: 30,
  decisionsObserved: 500,
  approvedVerbatim: 480,
  approvalAccuracy: 0.96,
  noShipIncidents: 0,
  hotAlertActionRate: 0.9,
};

const noEvidence: AutonomyEvidence = {
  daysActive: 0,
  decisionsObserved: 0,
  approvedVerbatim: 0,
  approvalAccuracy: 0,
  noShipIncidents: 0,
  hotAlertActionRate: 0,
};

describe('autonomy-ladder', () => {
  describe('currentRungIndex', () => {
    it('maps the default SUGGEST@90 to rung 0', () => {
      expect(currentRungIndex({ level: AutonomyLevel.SUGGEST, threshold: 90 })).toBe(0);
    });

    it('maps a fully-open AUTONOMOUS@80 to the last rung', () => {
      expect(currentRungIndex({ level: AutonomyLevel.AUTONOMOUS, threshold: 80 })).toBe(
        AUTONOMY_LADDER.length - 1,
      );
    });

    it('treats a lower threshold at the same level as more open', () => {
      // ASSISTED@85 is rung 2; ASSISTED@88 has not yet reached it → rung 1.
      expect(currentRungIndex({ level: AutonomyLevel.ASSISTED, threshold: 85 })).toBe(2);
      expect(currentRungIndex({ level: AutonomyLevel.ASSISTED, threshold: 88 })).toBe(1);
    });
  });

  describe('evaluateAutonomyLadder', () => {
    it('opens exactly one rung when the next gates are met', () => {
      const rec = evaluateAutonomyLadder(
        { level: AutonomyLevel.SUGGEST, threshold: 90 },
        strongEvidence,
      );
      expect(rec.direction).toBe(AutonomyDirection.OPEN);
      expect(rec.to).toEqual({ level: AutonomyLevel.ASSISTED, threshold: 90 }); // rung 1, not the top
    });

    it('holds when evidence is insufficient, reporting the failed gates', () => {
      const rec = evaluateAutonomyLadder(
        { level: AutonomyLevel.SUGGEST, threshold: 90 },
        noEvidence,
      );
      expect(rec.direction).toBe(AutonomyDirection.HOLD);
      expect(rec.to).toEqual(rec.from);
      expect(rec.gatesFailed).toEqual(expect.arrayContaining(['decisions', 'accuracy', 'days']));
    });

    it('requires responsive hot-alert handling to reach full autonomy', () => {
      const rec = evaluateAutonomyLadder(
        { level: AutonomyLevel.ASSISTED, threshold: 80 }, // rung 3 → next is AUTONOMOUS
        { ...strongEvidence, hotAlertActionRate: 0.5 },
      );
      expect(rec.direction).toBe(AutonomyDirection.HOLD);
      expect(rec.gatesFailed).toContain('hot_alert_action');
    });

    it('CLOSES to the supervised floor on any no-ship incident', () => {
      const rec = evaluateAutonomyLadder(
        { level: AutonomyLevel.AUTONOMOUS, threshold: 80 },
        { ...strongEvidence, noShipIncidents: 1 },
      );
      expect(rec.direction).toBe(AutonomyDirection.CLOSE);
      expect(rec.to).toEqual({ level: AutonomyLevel.SUGGEST, threshold: 90 });
      expect(rec.gatesFailed).toEqual(['no_ship_incident']);
    });

    it('HOLDs (not CLOSE) on a no-ship incident when already at the floor', () => {
      const rec = evaluateAutonomyLadder(
        { level: AutonomyLevel.SUGGEST, threshold: 90 },
        { ...noEvidence, noShipIncidents: 2 },
      );
      expect(rec.direction).toBe(AutonomyDirection.HOLD);
      expect(rec.to).toEqual(rec.from);
    });

    it('HOLDs at maximum autonomy with no further rung', () => {
      const rec = evaluateAutonomyLadder(
        { level: AutonomyLevel.AUTONOMOUS, threshold: 80 },
        strongEvidence,
      );
      expect(rec.direction).toBe(AutonomyDirection.HOLD);
      expect(rec.reason).toMatch(/maximum/i);
    });
  });
});
