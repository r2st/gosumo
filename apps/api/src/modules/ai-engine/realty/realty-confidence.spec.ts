import { RealtyIntent } from '@gosumo/shared';
import { computeRealtyConfidence, toMode } from './realty-confidence.util';
import type { RealtyGuardResult } from './realty-guardrails.service';

const cleanGuard: RealtyGuardResult = {
  violations: [],
  blocked: false,
  mustEscalate: false,
  rewriteToConfirming: false,
};
const blockGuard: RealtyGuardResult = {
  violations: [{ code: 'unverified_price', reason: 'x', severity: 'BLOCK' }],
  blocked: true,
  mustEscalate: true,
  rewriteToConfirming: false,
};
const rewriteGuard: RealtyGuardResult = {
  violations: [{ code: 'stale_availability', reason: 'x', severity: 'REWRITE' }],
  blocked: true,
  mustEscalate: false,
  rewriteToConfirming: true,
};

const perfectData = {
  matchedUnitCount: 2,
  verifiedSheetPresent: true,
  bltcSlotsFilled: 4,
  ragChunkCount: 3,
};

describe('computeRealtyConfidence', () => {
  it('maps scores to the four bands', () => {
    expect(toMode(95)).toBe('AUTO');
    expect(toMode(90)).toBe('AUTO');
    expect(toMode(89)).toBe('DRAFT');
    expect(toMode(70)).toBe('DRAFT');
    expect(toMode(69)).toBe('GUIDED');
    expect(toMode(50)).toBe('GUIDED');
    expect(toMode(49)).toBe('ESCALATE');
  });

  it('auto-executes a clean AUTO_ALLOWED intent with strong data', () => {
    const c = computeRealtyConfidence({ intent: RealtyIntent.AVAILABILITY, guard: cleanGuard, ...perfectData });
    expect(c.finalScore).toBe(100);
    expect(c.mode).toBe('AUTO');
    expect(c.overrides).toHaveLength(0);
  });

  it('never auto-sends a DRAFT_ONLY intent even with perfect data', () => {
    const c = computeRealtyConfidence({ intent: RealtyIntent.PRICE_INQUIRY, guard: cleanGuard, ...perfectData });
    expect(c.finalScore).toBeLessThan(90);
    expect(c.mode).toBe('DRAFT');
  });

  it('always escalates an ESCALATE-policy intent', () => {
    const c = computeRealtyConfidence({ intent: RealtyIntent.NEGOTIATION, guard: cleanGuard, ...perfectData });
    expect(c.mode).toBe('ESCALATE');
    expect(c.overrides.map((o) => o.code)).toContain('policy_escalate');
  });

  it('a BLOCK guardrail forces the ESCALATE band', () => {
    const c = computeRealtyConfidence({ intent: RealtyIntent.AVAILABILITY, guard: blockGuard, ...perfectData });
    expect(c.mode).toBe('ESCALATE');
    expect(c.overrides.map((o) => o.code)).toContain('unverified_price');
  });

  it('a REWRITE guardrail caps at the GUIDED band', () => {
    const c = computeRealtyConfidence({ intent: RealtyIntent.AVAILABILITY, guard: rewriteGuard, ...perfectData });
    expect(c.mode).toBe('GUIDED');
  });

  it('weak data alone lowers confidence out of the AUTO band', () => {
    const c = computeRealtyConfidence({
      intent: RealtyIntent.NEW_ENQUIRY,
      guard: cleanGuard,
      matchedUnitCount: 0,
      verifiedSheetPresent: false,
      bltcSlotsFilled: 0,
      ragChunkCount: 0,
    });
    expect(c.finalScore).toBeLessThan(70);
    expect(c.dataAvailability).toBeLessThan(50);
  });

  it('uses the 0.5 / 0.5 data-policy split', () => {
    const c = computeRealtyConfidence({ intent: RealtyIntent.AVAILABILITY, guard: cleanGuard, ...perfectData });
    // dataAvailability and policyClarity both 100 → finalScore 100.
    expect(c.dataAvailability).toBe(100);
    expect(c.policyClarity).toBe(100);
    expect(c.finalScore).toBe(Math.round(c.dataAvailability * 0.5 + c.policyClarity * 0.5));
  });
});
