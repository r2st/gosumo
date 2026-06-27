import { ConfidenceMode, IntentType } from '@gosumo/shared';
import { ConfidenceCalculatorService } from './confidence-calculator.service';
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
