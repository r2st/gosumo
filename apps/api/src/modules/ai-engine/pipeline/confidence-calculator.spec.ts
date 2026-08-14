import { ConfidenceMode, IntentType } from '@gosumo/shared';
import {
  ConfidenceCalculatorService,
  DEFAULT_BANDS,
  resolveBands,
} from './confidence-calculator.service';
import { CONFIDENCE_DRAFT_REVIEW } from '../ai-engine.constants';
import { SafetySignals } from '../safety/guardrails.service';

const noSafety: SafetySignals = {
  jailbreakDetected: false,
  legalThreatDetected: false,
  humanRequested: false,
  pii: { hasPii: false, detected: [], redactedText: '' },
  loopDetected: false,
};

function safety(overrides: Partial<SafetySignals>): SafetySignals {
  return { ...noSafety, ...overrides };
}

describe('ConfidenceCalculatorService', () => {
  let service: ConfidenceCalculatorService;

  beforeEach(() => {
    service = new ConfidenceCalculatorService();
  });

  describe('base formula', () => {
    it('produces a high score (AUTO_PILOT) with full data and a clear policy', () => {
      const result = service.calculate({
        intent: IntentType.BOOKING,
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: true },
        policy: { policyDefined: true },
      });

      expect(result.dataAvailability).toBe(1);
      expect(result.policyClarity).toBe(1);
      expect(result.finalScore).toBe(1);
      expect(result.mode).toBe(ConfidenceMode.AUTO_PILOT);
      expect(result.requiresEscalation).toBe(false);
      expect(result.overrides).toHaveLength(0);
    });

    it('lands in DRAFT for partial data', () => {
      const result = service.calculate({
        intent: IntentType.PRICING,
        data: { ragChunkCount: 1, clientKnown: true },
        policy: { policyDefined: true },
      });

      // rag 0.6*0.5 + catalog 0.5*0.3 + client 1*0.2 = 0.65 data; policy 1
      // base = 0.65*0.5 + 1*0.5 = 0.825 → DRAFT
      expect(result.mode).toBe(ConfidenceMode.DRAFT);
      expect(result.finalScore).toBeGreaterThanOrEqual(0.7);
      expect(result.finalScore).toBeLessThan(0.9);
    });

    it('escalates when there is no data and no policy', () => {
      const result = service.calculate({
        intent: IntentType.GENERAL_INQUIRY,
        data: { ragChunkCount: 0, catalogMatch: false, clientKnown: false },
        policy: { policyDefined: false },
      });

      expect(result.mode).toBe(ConfidenceMode.ESCALATION);
      expect(result.requiresEscalation).toBe(true);
    });
  });

  describe('hard overrides', () => {
    it('forces a legal threat to CRITICAL escalation regardless of data', () => {
      const result = service.calculate({
        intent: IntentType.COMPLAINT,
        data: { ragChunkCount: 5, catalogMatch: true, clientKnown: true },
        policy: { policyDefined: true },
        safety: safety({ legalThreatDetected: true }),
      });

      expect(result.finalScore).toBeLessThanOrEqual(0.1);
      expect(result.mode).toBe(ConfidenceMode.ESCALATION);
      expect(result.requiresEscalation).toBe(true);
      expect(result.overrides.map((o) => o.code)).toContain('customer_mentions_legal_action');
    });

    it('forces a jailbreak attempt to zero', () => {
      const result = service.calculate({
        intent: IntentType.CHIT_CHAT,
        data: { ragChunkCount: 5, clientKnown: true },
        policy: { policyDefined: true },
        safety: safety({ jailbreakDetected: true }),
      });
      expect(result.finalScore).toBe(0);
      expect(result.requiresEscalation).toBe(true);
    });

    it('escalates a refund above the policy limit', () => {
      const result = service.calculate({
        intent: IntentType.REFUND,
        data: { ragChunkCount: 3, clientKnown: true },
        policy: { policyDefined: true },
        refundAmountPaise: 200_000,
        maxRefundAmountPaise: 50_000,
      });
      expect(result.overrides.map((o) => o.code)).toContain('refund_exceeds_policy_limit');
      expect(result.finalScore).toBeLessThanOrEqual(0.3);
    });

    it('does NOT escalate a refund within the policy limit', () => {
      const result = service.calculate({
        intent: IntentType.REFUND,
        data: { ragChunkCount: 3, clientKnown: true },
        policy: { policyDefined: true },
        refundAmountPaise: 20_000,
        maxRefundAmountPaise: 50_000,
      });
      expect(result.overrides.map((o) => o.code)).not.toContain('refund_exceeds_policy_limit');
    });

    it('escalates on critically negative sentiment', () => {
      const result = service.calculate({
        intent: IntentType.COMPLAINT,
        data: { ragChunkCount: 3, clientKnown: true },
        policy: { policyDefined: true },
        sentimentScore: -0.8,
      });
      expect(result.overrides.map((o) => o.code)).toContain('sentiment_critical');
    });

    it('escalates a loop detected via repeatedIntentCount', () => {
      const result = service.calculate({
        intent: IntentType.FOLLOW_UP,
        data: { ragChunkCount: 3, clientKnown: true },
        policy: { policyDefined: true },
        repeatedIntentCount: 3,
      });
      expect(result.overrides.map((o) => o.code)).toContain('loop_detection');
    });

    it('forceEscalate drives the score to zero', () => {
      const result = service.calculate({
        intent: IntentType.BOOKING,
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: true },
        policy: { policyDefined: true },
        forceEscalate: true,
      });
      expect(result.finalScore).toBe(0);
      expect(result.requiresEscalation).toBe(true);
    });

    /**
     * The two hard overrides nothing was driving.
     *
     * Both gate money and identity. `pii_risk_detected` is one of the three
     * codes `action-router` treats as unconditionally escalating, so a
     * regression here does not merely lower a score — it hands an Aadhaar or a
     * card number to the auto-execute path.
     */
    it('escalates when the customer message carried sensitive PII', () => {
      const result = service.calculate({
        intent: IntentType.BOOKING,
        // Deliberately the best possible base: full RAG, catalog hit, known
        // client, clear policy. The override has to beat all of it.
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: true },
        policy: { policyDefined: true },
        safety: safety({
          pii: {
            hasPii: true,
            detected: [{ type: 'AADHAAR' }, { type: 'CREDIT_CARD' }],
            redactedText: 'my number is [REDACTED_AADHAAR]',
          },
        }),
      });

      expect(result.finalScore).toBeLessThanOrEqual(0.1);
      expect(result.requiresEscalation).toBe(true);
      expect(result.mode).toBe(ConfidenceMode.ESCALATION);

      const override = result.overrides.find((o) => o.code === 'pii_risk_detected');
      expect(override).toBeDefined();
      // Every detected type is named, so an operator reading the decision row
      // knows what was exposed without re-scanning the message.
      expect(override?.reason).toContain('AADHAAR');
      expect(override?.reason).toContain('CREDIT_CARD');
    });

    /**
     * An unknown payment amount caps confidence at 0.45 and escalates.
     *
     * Note the escalation is NOT coming from the override's own flag.
     * `PAYMENT_AMOUNT_UNKNOWN` is the only entry in the table declared
     * `escalate: false` — "stop auto-charging, but do not pull in a human" —
     * and that flag cannot currently take effect: its `forceScore` of 0.45
     * sits below `CONFIDENCE_GUIDED` (0.5), and `calculate` escalates anything
     * under that floor regardless of the flag. Raising the cap to 0.5 would
     * make the flag live and land these in GUIDED instead, which is a payment
     * -routing decision, not a test's to make.
     *
     * This pins what the code actually does today so the discrepancy is
     * visible rather than latent.
     */
    it('caps an unknown payment amount and escalates it via the GUIDED floor', () => {
      const result = service.calculate({
        intent: IntentType.PAYMENT,
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: true },
        policy: { policyDefined: true },
        paymentAmountUnknown: true,
      });

      expect(result.finalScore).toBeLessThanOrEqual(0.45);
      expect(result.overrides.map((o) => o.code)).toContain('payment_amount_unknown');
      expect(result.mode).toBe(ConfidenceMode.ESCALATION);
      expect(result.requiresEscalation).toBe(true);
    });

    it('routes an unknown payment amount at LOW urgency, unlike the safety overrides', () => {
      // It escalates, but it is not a safety event: the action router's
      // urgency ladder leaves it at the bottom, which is the one place the
      // `escalate: false` intent still shows through.
      const result = service.calculate({
        intent: IntentType.PAYMENT,
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: true },
        policy: { policyDefined: true },
        paymentAmountUnknown: true,
      });

      expect(result.overrides).toHaveLength(1);
      expect(result.overrides[0]?.code).toBe('payment_amount_unknown');
    });

    it('takes the lowest ceiling when several overrides fire at once', () => {
      // PII caps at 0.1, unknown-amount at 0.45. The strictest wins, and the
      // escalating one still escalates even though it is not the last applied.
      const result = service.calculate({
        intent: IntentType.PAYMENT,
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: true },
        policy: { policyDefined: true },
        paymentAmountUnknown: true,
        safety: safety({
          pii: { hasPii: true, detected: [{ type: 'PAN' }], redactedText: '' },
        }),
      });

      expect(result.finalScore).toBeLessThanOrEqual(0.1);
      expect(result.requiresEscalation).toBe(true);
      expect(result.overrides.map((o) => o.code).sort()).toEqual([
        'payment_amount_unknown',
        'pii_risk_detected',
      ]);
    });

    it('an override only ever lowers confidence, never raises it', () => {
      // price_not_in_catalog caps at 0.49, but base is already lower here.
      const result = service.calculate({
        intent: IntentType.PRICING,
        data: { ragChunkCount: 0, catalogMatch: false, clientKnown: false },
        policy: { policyDefined: false },
        priceNotInCatalog: true,
      });
      expect(result.finalScore).toBeLessThanOrEqual(0.49);
    });
  });

  describe('component scoring', () => {
    /**
     * "Defined but ambiguous" is its own rung, distinct from "not defined".
     * A policy that exists and contradicts itself is more dangerous than a
     * missing one — the AI has something to cite — so it must not score as a
     * clear policy.
     */
    it('scores an ambiguous policy below a clear one and above a missing one', () => {
      const base = {
        intent: IntentType.PRICING,
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: true },
      } as const;

      const clear = service.calculate({ ...base, policy: { policyDefined: true } });
      const ambiguous = service.calculate({
        ...base,
        policy: { policyDefined: true, policyAmbiguous: true },
      });
      const missing = service.calculate({ ...base, policy: { policyDefined: false } });

      expect(clear.policyClarity).toBe(1);
      expect(ambiguous.policyClarity).toBe(0.6);
      expect(missing.policyClarity).toBe(0.4);
      expect(ambiguous.finalScore).toBeLessThan(clear.finalScore);
      expect(ambiguous.finalScore).toBeGreaterThan(missing.finalScore);
    });

    /**
     * `clientKnown` is tri-state and the middle state is not the average.
     * Unknown (undefined) scores 0.6 — better than a client confirmed absent
     * (0.4), because "we have not looked" is weaker evidence than "we looked
     * and there is no history".
     */
    it('ranks an unchecked client above one confirmed unknown', () => {
      const base = {
        intent: IntentType.GENERAL_INQUIRY,
        policy: { policyDefined: true },
      } as const;

      const known = service.calculate({
        ...base,
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: true },
      });
      const unchecked = service.calculate({
        ...base,
        data: { ragChunkCount: 3, catalogMatch: true },
      });
      const absent = service.calculate({
        ...base,
        data: { ragChunkCount: 3, catalogMatch: true, clientKnown: false },
      });

      expect(known.dataAvailability).toBeGreaterThan(unchecked.dataAvailability);
      expect(unchecked.dataAvailability).toBeGreaterThan(absent.dataAvailability);
    });
  });

  describe('toMode', () => {
    it('maps band boundaries correctly', () => {
      expect(service.toMode(0.9)).toBe(ConfidenceMode.AUTO_PILOT);
      expect(service.toMode(0.89)).toBe(ConfidenceMode.DRAFT);
      expect(service.toMode(0.7)).toBe(ConfidenceMode.DRAFT);
      expect(service.toMode(0.69)).toBe(ConfidenceMode.GUIDED);
      expect(service.toMode(0.5)).toBe(ConfidenceMode.GUIDED);
      expect(service.toMode(0.49)).toBe(ConfidenceMode.ESCALATION);
    });
  });
});

// ─────────────────────────────────────────────
// Tenant-configured routing bands
// ─────────────────────────────────────────────

/**
 * The settings page and the onboarding wizard both collect these two numbers,
 * the tenant module validates them, and `businesses.ai_settings` stores them —
 * but nothing read them back on the routing path, so `toMode` answered with the
 * module defaults no matter what a tenant configured. Raising the auto-execute
 * gate to 95 to keep a human in the loop changed nothing at all.
 *
 * The scales differ on each side of the boundary: settings are percentages,
 * scores are 0–1. That conversion is the part most likely to rot, so it is
 * pinned from both directions.
 */
describe('resolveBands', () => {
  it('converts stored percentages to the 0–1 scale', () => {
    expect(resolveBands({ autoExecute: 95, draftReview: 80 })).toEqual({
      autoExecute: 0.95,
      draftReview: 0.8,
      guided: 0.5,
    });
  });

  it('falls back to the module defaults when nothing is stored', () => {
    expect(resolveBands(undefined)).toEqual(DEFAULT_BANDS);
    expect(resolveBands({})).toEqual(DEFAULT_BANDS);
  });

  it('fills in only the missing half', () => {
    expect(resolveBands({ autoExecute: 95 })).toEqual({
      autoExecute: 0.95,
      draftReview: CONFIDENCE_DRAFT_REVIEW,
      guided: 0.5,
    });
  });

  it('pulls the GUIDED edge down so the bands cannot invert', () => {
    // A tenant may set draftReview below the fixed GUIDED constant. Leaving
    // GUIDED at 0.5 would put it above the draft edge, and `toMode` checks
    // auto → draft → guided in order, so DRAFT would still win — but
    // `requiresEscalation` reads the GUIDED floor directly and would flag a
    // score the tenant explicitly said was good enough to draft.
    expect(resolveBands({ autoExecute: 90, draftReview: 30 }).guided).toBe(0.3);
  });

  it.each([
    ['an inverted pair', { autoExecute: 60, draftReview: 80 }],
    ['a zero gate', { autoExecute: 0, draftReview: 0 }],
    ['a gate below the safety floor', { autoExecute: 40, draftReview: 20 }],
    ['a negative value', { autoExecute: -10, draftReview: 70 }],
    ['a value above 100', { autoExecute: 900, draftReview: 70 }],
    ['a non-finite value', { autoExecute: Number.NaN, draftReview: 70 }],
    ['a value on the 0–1 scale by mistake', { autoExecute: 0.9, draftReview: 0.7 }],
  ])('refuses to widen the gate for %s', (_label, stored) => {
    // Each of these would open the auto-execute band wider than any human
    // asked for — the 0.9 case most quietly of all, since it reads as correct
    // right up until it is divided by 100 and becomes 0.009.
    expect(resolveBands(stored)).toEqual(DEFAULT_BANDS);
  });

  /**
   * `MIN_AUTO_EXECUTE_BAND` guards the top of the scale. The bottom had no
   * guard, and it fails the same way read from the other end: GUIDED is derived
   * as `min(CONFIDENCE_GUIDED, draftReview)`, so a stored 0 drags it to 0 —
   * and because every score is clamped to 0–1, `score >= 0` always holds. The
   * ESCALATION band empties, and the low-confidence decisions meant for a
   * person are filed as drafts instead.
   */
  it('refuses a draft edge of zero, which would empty the escalation band', () => {
    expect(resolveBands({ autoExecute: 90, draftReview: 0 })).toEqual(DEFAULT_BANDS);
  });

  it('keeps the escalation band reachable for every accepted pair', () => {
    for (let draft = 0; draft <= 100; draft += 1) {
      const bands = resolveBands({ autoExecute: 95, draftReview: draft });
      // Whatever the tenant stored, some score must still route to ESCALATION.
      expect(bands.guided).toBeGreaterThan(0);
    }
  });

  it('still honours a narrow escalation band, which is a legitimate choice', () => {
    // The floor rejects an *empty* band, not a small one — a tenant who wants
    // most things drafted rather than escalated is not misconfigured.
    expect(resolveBands({ autoExecute: 90, draftReview: 5 })).toEqual({
      autoExecute: 0.9,
      draftReview: 0.05,
      guided: 0.05,
    });
  });
});

describe('tenant bands drive the routing mode', () => {
  let service: ConfidenceCalculatorService;
  beforeEach(() => {
    service = new ConfidenceCalculatorService();
  });

  const perfect = {
    intent: IntentType.BOOKING,
    data: { ragChunkCount: 1, catalogMatch: true, clientKnown: true },
    policy: { policyDefined: true },
  };

  it('drafts a score that the default bands would have auto-executed', () => {
    // 0.5·0.5 + 1·0.3 + 1·0.2 = 0.75 data, 1 policy → 0.875... check the band
    // move rather than the arithmetic: same input, two tenants, two outcomes.
    const lenient = service.calculate({ ...perfect, thresholds: { autoExecute: 80 } });
    const strict = service.calculate({ ...perfect, thresholds: { autoExecute: 95 } });

    expect(lenient.finalScore).toBe(strict.finalScore);
    expect(lenient.mode).toBe(ConfidenceMode.AUTO_PILOT);
    expect(strict.mode).toBe(ConfidenceMode.DRAFT);
  });

  it('keeps the documented defaults when the tenant has configured nothing', () => {
    expect(service.calculate(perfect).mode).toBe(
      service.calculate({ ...perfect, thresholds: {} }).mode,
    );
  });

  it('honours a tenant band at its exact boundary', () => {
    // `>=` at the edge: a score equal to the configured gate auto-executes.
    expect(service.toMode(0.85, resolveBands({ autoExecute: 85 }))).toBe(
      ConfidenceMode.AUTO_PILOT,
    );
    expect(service.toMode(0.8499, resolveBands({ autoExecute: 85 }))).toBe(
      ConfidenceMode.DRAFT,
    );
  });

  it('escalates below a raised draft edge', () => {
    const bands = resolveBands({ autoExecute: 95, draftReview: 90 });
    expect(service.toMode(0.92, bands)).toBe(ConfidenceMode.DRAFT);
    expect(service.toMode(0.7, bands)).toBe(ConfidenceMode.GUIDED);
  });

  it('still hands a hopeless score to a human when the tenant stored a zero draft edge', () => {
    // The whole point of the floor: a worthless score must not come back as a
    // draft for somebody to approve. Before it, these bands were
    // `{ auto: 0.9, draft: 0, guided: 0 }` and every score below the gate was
    // a DRAFT — the ESCALATION band could not be reached at all.
    const bands = resolveBands({ autoExecute: 90, draftReview: 0 });

    expect(service.toMode(0, bands)).toBe(ConfidenceMode.ESCALATION);
    expect(service.toMode(0.1, bands)).toBe(ConfidenceMode.ESCALATION);
  });

  it('flags a zero-confidence decision as requiring escalation whatever the tenant stored', () => {
    const escalating = service.calculate({
      ...perfect,
      // Caps the score at 0 — there is no reading of this that is safe to
      // auto-execute or to file as a draft.
      forceEscalate: true,
      thresholds: { autoExecute: 90, draftReview: 0 },
    });

    expect(escalating.finalScore).toBe(0);
    expect(escalating.mode).toBe(ConfidenceMode.ESCALATION);
    expect(escalating.requiresEscalation).toBe(true);
  });
});
