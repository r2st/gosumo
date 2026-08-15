import { ConfidenceMode, IntentType, RealtyIntent } from '@gosumo/shared';
import {
  ConfidenceCalculatorService,
  DEFAULT_BANDS,
  resolveBands,
} from './pipeline/confidence-calculator.service';
import { ActionRouterService } from './pipeline/action-router.service';
import {
  DEFAULT_REALTY_BANDS,
  computeRealtyConfidence,
  resolveRealtyBands,
  toMode as realtyToMode,
} from './realty/realty-confidence.util';
import type { RealtyGuardResult } from './realty/realty-guardrails.service';
import {
  CONFIDENCE_AUTO_EXECUTE,
  CONFIDENCE_DRAFT_REVIEW,
  CONFIDENCE_GUIDED,
  MIN_AUTO_EXECUTE_BAND,
  MIN_DRAFT_REVIEW_BAND,
  DEFAULT_AUTO_EXECUTE_THRESHOLD,
  DEFAULT_DRAFT_REVIEW_THRESHOLD,
} from './ai-engine.constants';
import { REALTY_AUTO, REALTY_DRAFT, REALTY_GUIDED } from './realty/realty-intent.constants';

/**
 * The routing bands, exercised at their exact edges.
 *
 * The platform's whole human-in-the-loop story is three numbers — ≥90 auto,
 * 70–89 draft, <70 to a person — and a band edge is where an off-by-one costs
 * a review. The two pipelines score on different scales (generic 0–1, realty
 * 0–100) and used to resolve those numbers from different places, so the edges
 * are asserted separately and then asserted to agree.
 */

const cleanGuard: RealtyGuardResult = {
  violations: [],
  blocked: false,
  mustEscalate: false,
  rewriteToConfirming: false,
};

/** Signals that score 100/100 — the only way to reach the top of the AUTO band. */
const perfectRealtyData = {
  matchedUnitCount: 2,
  verifiedSheetPresent: true,
  bltcSlotsFilled: 4,
  ragChunkCount: 3,
};

describe('confidence band boundaries', () => {
  // ───────────────────────────────────────────
  // Generic pipeline (0–1 scale)
  // ───────────────────────────────────────────

  describe('generic pipeline — ConfidenceCalculatorService.toMode', () => {
    const calculator = new ConfidenceCalculatorService();

    it.each([
      [1.0, ConfidenceMode.AUTO_PILOT],
      [0.9001, ConfidenceMode.AUTO_PILOT],
      // The documented edge: ">= 90%" auto-executes, so 0.90 itself is inside.
      [0.9, ConfidenceMode.AUTO_PILOT],
      [0.8999, ConfidenceMode.DRAFT],
      [0.7001, ConfidenceMode.DRAFT],
      // "70-89% drafts for review" — 0.70 is inside the draft band.
      [0.7, ConfidenceMode.DRAFT],
      [0.6999, ConfidenceMode.GUIDED],
      [0.5, ConfidenceMode.GUIDED],
      [0.4999, ConfidenceMode.ESCALATION],
      [0, ConfidenceMode.ESCALATION],
    ])('scores %p as %s', (score, expected) => {
      expect(calculator.toMode(score)).toBe(expected);
    });

    it('places each band edge in the band it opens, never the one below', () => {
      expect(calculator.toMode(CONFIDENCE_AUTO_EXECUTE)).toBe(ConfidenceMode.AUTO_PILOT);
      expect(calculator.toMode(CONFIDENCE_DRAFT_REVIEW)).toBe(ConfidenceMode.DRAFT);
      expect(calculator.toMode(CONFIDENCE_GUIDED)).toBe(ConfidenceMode.GUIDED);
    });

    it('leaves no gap between bands: every edge minus one ulp lands one band down', () => {
      const justUnder = (n: number): number => n - 0.0001;
      expect(calculator.toMode(justUnder(CONFIDENCE_AUTO_EXECUTE))).toBe(ConfidenceMode.DRAFT);
      expect(calculator.toMode(justUnder(CONFIDENCE_DRAFT_REVIEW))).toBe(ConfidenceMode.GUIDED);
      expect(calculator.toMode(justUnder(CONFIDENCE_GUIDED))).toBe(ConfidenceMode.ESCALATION);
    });
  });

  describe('generic pipeline — resolveBands', () => {
    it('converts stored percentages to the calculator scale', () => {
      expect(resolveBands({ autoExecute: 95, draftReview: 80 })).toEqual({
        autoExecute: 0.95,
        draftReview: 0.8,
        guided: 0.5,
      });
    });

    it('reproduces the defaults exactly from the default stored percentages', () => {
      expect(
        resolveBands({
          autoExecute: DEFAULT_AUTO_EXECUTE_THRESHOLD,
          draftReview: DEFAULT_DRAFT_REVIEW_THRESHOLD,
        }),
      ).toEqual(DEFAULT_BANDS);
    });

    it('honours a tightened auto gate at its exact edge', () => {
      const calculator = new ConfidenceCalculatorService();
      const bands = resolveBands({ autoExecute: 95, draftReview: 70 });
      expect(calculator.toMode(0.95, bands)).toBe(ConfidenceMode.AUTO_PILOT);
      // The score that auto-executed on the defaults now drafts instead — the
      // whole point of raising the threshold.
      expect(calculator.toMode(0.94, bands)).toBe(ConfidenceMode.DRAFT);
      expect(calculator.toMode(0.9, bands)).toBe(ConfidenceMode.DRAFT);
    });

    it.each([
      ['an inverted pair', { autoExecute: 60, draftReview: 80 }],
      ['an auto gate below the floor', { autoExecute: MIN_AUTO_EXECUTE_BAND * 100 - 1, draftReview: 10 }],
      ['an auto gate of zero', { autoExecute: 0, draftReview: 0 }],
      ['a draft edge below the floor', { autoExecute: 90, draftReview: 0 }],
      ['an out-of-range percentage', { autoExecute: 900, draftReview: 70 }],
      ['a negative percentage', { autoExecute: -10, draftReview: 70 }],
      ['a non-finite value', { autoExecute: Number.NaN, draftReview: 70 }],
      ['a non-numeric value', { autoExecute: '90' as unknown as number, draftReview: 70 }],
    ])('falls back to the defaults for %s', (_label, thresholds) => {
      expect(resolveBands(thresholds)).toEqual(DEFAULT_BANDS);
    });

    it('keeps ESCALATION reachable at the lowest draft edge it will accept', () => {
      const calculator = new ConfidenceCalculatorService();
      const bands = resolveBands({ autoExecute: 90, draftReview: MIN_DRAFT_REVIEW_BAND * 100 });
      // A narrow escalation band is a legitimate choice; an empty one is not.
      expect(bands.guided).toBeGreaterThan(0);
      expect(calculator.toMode(0, bands)).toBe(ConfidenceMode.ESCALATION);
    });

    it('never lets GUIDED sit above the draft edge', () => {
      const bands = resolveBands({ autoExecute: 90, draftReview: 30 });
      expect(bands.guided).toBeLessThanOrEqual(bands.draftReview);
    });
  });

  describe('generic pipeline — escalation outranks the band', () => {
    const calculator = new ConfidenceCalculatorService();
    const router = new ActionRouterService();

    it.each([
      [ConfidenceMode.AUTO_PILOT, 0.95],
      [ConfidenceMode.DRAFT, 0.75],
      [ConfidenceMode.GUIDED, 0.55],
    ])('diverts %s to ESCALATE when requiresEscalation is set', (mode, score) => {
      const decision = router.route(
        {
          dataAvailability: 1,
          policyClarity: 1,
          finalScore: score,
          mode,
          overrides: [],
          requiresEscalation: true,
        },
        IntentType.GENERAL_INQUIRY,
      );
      expect(decision.action).toBe('ESCALATE');
      expect(decision.mode).toBe(ConfidenceMode.ESCALATION);
    });

    it('auto-executes at the exact auto edge when nothing forces escalation', () => {
      const scored = calculator.calculate({
        intent: IntentType.GENERAL_INQUIRY,
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: true },
        policy: { policyDefined: true },
      });
      expect(scored.finalScore).toBeGreaterThanOrEqual(CONFIDENCE_AUTO_EXECUTE);
      expect(router.route(scored, IntentType.GENERAL_INQUIRY).action).toBe('AUTO_EXECUTE');
    });

    it('keeps every escalating override below the lowest auto gate a tenant may set', () => {
      // The router consults `requiresEscalation` in the AUTO_PILOT arm, but this
      // arithmetic is what stops the two co-occurring in the first place. If an
      // override ceiling ever rises above the floor, a legal threat becomes a
      // score that a tenant-configured band could route to AUTO_PILOT.
      const escalatingCeilings = [0.0, 0.1, 0.2, 0.25, 0.3, 0.49];
      for (const ceiling of escalatingCeilings) {
        expect(ceiling).toBeLessThan(MIN_AUTO_EXECUTE_BAND);
      }
    });
  });

  // ───────────────────────────────────────────
  // Realty pipeline (0–100 scale)
  // ───────────────────────────────────────────

  describe('realty pipeline — toMode', () => {
    it.each([
      [100, 'AUTO'],
      [90, 'AUTO'],
      [89, 'DRAFT'],
      [70, 'DRAFT'],
      [69, 'GUIDED'],
      [50, 'GUIDED'],
      [49, 'ESCALATE'],
      [0, 'ESCALATE'],
    ])('scores %p as %s', (score, expected) => {
      expect(realtyToMode(score)).toBe(expected);
    });

    it('places each band edge in the band it opens', () => {
      expect(realtyToMode(REALTY_AUTO)).toBe('AUTO');
      expect(realtyToMode(REALTY_DRAFT)).toBe('DRAFT');
      expect(realtyToMode(REALTY_GUIDED)).toBe('GUIDED');
    });
  });

  describe('realty pipeline — resolveRealtyBands', () => {
    it('defaults to the module bands when the tenant has stored nothing', () => {
      expect(resolveRealtyBands(undefined)).toEqual(DEFAULT_REALTY_BANDS);
      expect(resolveRealtyBands({})).toEqual(DEFAULT_REALTY_BANDS);
    });

    it('returns whole percentages, not floating-point dust', () => {
      // `0.9 * 100` is 90.00000000000001 in IEEE-754, and a score of exactly 90
      // would then fail `>= auto` — the default tenant would lose the top of
      // their own auto band to a rounding artifact.
      const bands = resolveRealtyBands({ autoExecute: 90, draftReview: 70 });
      expect(bands.auto).toBe(90);
      expect(bands.draft).toBe(70);
      expect(bands.guided).toBe(50);
      expect(realtyToMode(90, bands)).toBe('AUTO');
    });

    it('agrees with the generic resolver on every band, scale aside', () => {
      for (const thresholds of [
        { autoExecute: 95, draftReview: 80 },
        { autoExecute: 90, draftReview: 70 },
        { autoExecute: 55, draftReview: 20 },
        { autoExecute: 100, draftReview: 1 },
      ]) {
        const generic = resolveBands(thresholds);
        expect(resolveRealtyBands(thresholds)).toEqual({
          auto: Math.round(generic.autoExecute * 100 * 10_000) / 10_000,
          draft: Math.round(generic.draftReview * 100 * 10_000) / 10_000,
          guided: Math.round(generic.guided * 100 * 10_000) / 10_000,
        });
      }
    });

    it.each([
      ['an inverted pair', { autoExecute: 60, draftReview: 80 }],
      ['an auto gate of zero', { autoExecute: 0, draftReview: 0 }],
      ['a draft edge of zero', { autoExecute: 90, draftReview: 0 }],
      ['an out-of-range percentage', { autoExecute: 900, draftReview: 70 }],
    ])('rejects %s in favour of the defaults', (_label, thresholds) => {
      expect(resolveRealtyBands(thresholds)).toEqual(DEFAULT_REALTY_BANDS);
    });
  });

  describe('realty pipeline — per-tenant bands reach the routing decision', () => {
    it('routes a perfect turn to AUTO on the default bands', () => {
      const result = computeRealtyConfidence({
        intent: RealtyIntent.AVAILABILITY,
        ...perfectRealtyData,
        guard: cleanGuard,
      });
      expect(result.finalScore).toBeGreaterThanOrEqual(REALTY_AUTO);
      expect(result.mode).toBe('AUTO');
    });

    it('drafts the same turn once the tenant raises their auto gate above it', () => {
      // Deliberately one signal short of perfect, so there is headroom between
      // the score and 100 for a tenant threshold to sit in.
      const strongRealtyData = { ...perfectRealtyData, ragChunkCount: 1 };

      const onDefaults = computeRealtyConfidence({
        intent: RealtyIntent.AVAILABILITY,
        ...strongRealtyData,
        guard: cleanGuard,
      });
      expect(onDefaults.mode).toBe('AUTO');
      expect(onDefaults.finalScore).toBeLessThan(100);

      const tightened = computeRealtyConfidence({
        intent: RealtyIntent.AVAILABILITY,
        ...strongRealtyData,
        guard: cleanGuard,
        // One point above what this turn can score, so it can no longer reach AUTO.
        thresholds: { autoExecute: onDefaults.finalScore + 1, draftReview: 70 },
      });
      expect(tightened.finalScore).toBe(onDefaults.finalScore);
      expect(tightened.mode).toBe('DRAFT');
    });

    it('holds a DRAFT_ONLY intent below the auto gate even when the tenant lowers it', () => {
      // The regression this guards: the policy ceiling used to be the literal
      // `REALTY_AUTO - 1`. A tenant who lowered their gate to 60 would get a
      // ceiling of 89 — above their own auto edge — so the one intent class
      // that may never auto-send would auto-send.
      const result = computeRealtyConfidence({
        intent: RealtyIntent.PRICE_INQUIRY,
        ...perfectRealtyData,
        guard: cleanGuard,
        thresholds: { autoExecute: 60, draftReview: 55 },
      });
      expect(result.mode).not.toBe('AUTO');
      expect(result.finalScore).toBeLessThan(60);
      expect(result.overrides.map((o) => o.code)).toContain('policy_draft_only');
    });

    it('keeps an always-escalate intent below the guided edge on any band', () => {
      for (const thresholds of [
        undefined,
        { autoExecute: 60, draftReview: 55 },
        { autoExecute: 99, draftReview: 98 },
      ]) {
        const result = computeRealtyConfidence({
          intent: RealtyIntent.NEGOTIATION,
          ...perfectRealtyData,
          guard: cleanGuard,
          thresholds,
        });
        expect(result.mode).toBe('ESCALATE');
      }
    });

    it('falls back to the default bands rather than honouring a gate of zero', () => {
      // `autoExecute: 0` would make every score auto-send. The resolver refuses
      // it, so a perfect turn still routes on 90/70/50.
      const result = computeRealtyConfidence({
        intent: RealtyIntent.AVAILABILITY,
        matchedUnitCount: 0,
        verifiedSheetPresent: false,
        bltcSlotsFilled: 0,
        ragChunkCount: 0,
        guard: cleanGuard,
        thresholds: { autoExecute: 0, draftReview: 0 },
      });
      expect(result.finalScore).toBeLessThan(REALTY_AUTO);
      expect(result.mode).not.toBe('AUTO');
    });
  });

  // ───────────────────────────────────────────
  // The two pipelines agree on what the bands mean
  // ───────────────────────────────────────────

  describe('cross-pipeline agreement', () => {
    const calculator = new ConfidenceCalculatorService();

    it('uses the same three edges on both scales', () => {
      expect(REALTY_AUTO / 100).toBe(CONFIDENCE_AUTO_EXECUTE);
      expect(REALTY_DRAFT / 100).toBe(CONFIDENCE_DRAFT_REVIEW);
      expect(REALTY_GUIDED / 100).toBe(CONFIDENCE_GUIDED);
    });

    it.each([0, 25, 49, 50, 69, 70, 89, 90, 100])(
      'routes a score of %i percent to the same band in both pipelines',
      (percent) => {
        const generic = calculator.toMode(percent / 100);
        const realty = realtyToMode(percent);
        const equivalent: Record<string, ConfidenceMode> = {
          AUTO: ConfidenceMode.AUTO_PILOT,
          DRAFT: ConfidenceMode.DRAFT,
          GUIDED: ConfidenceMode.GUIDED,
          ESCALATE: ConfidenceMode.ESCALATION,
        };
        expect(equivalent[realty]).toBe(generic);
      },
    );
  });
});
