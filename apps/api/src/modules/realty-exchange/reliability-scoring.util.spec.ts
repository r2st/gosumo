import {
  computeReliabilityScore,
  RELIABILITY_WEIGHTS,
  NEUTRAL_SCORE,
  type ReliabilitySignals,
} from './reliability-scoring.util';

const EMPTY: ReliabilitySignals = {
  avgFirstResponseMinutes: null,
  visitsScheduled: 0,
  visitsHonored: 0,
  syndicationsClosed: 0,
  splitsHonored: 0,
  disputes: 0,
  syndicationsWithDocs: 0,
  syndicationsTotal: 0,
};

describe('computeReliabilityScore', () => {
  it('gives a brand-new member all-neutral (~50) sub-scores and composite', () => {
    const r = computeReliabilityScore(EMPTY);
    expect(r.responseSpeedScore).toBe(NEUTRAL_SCORE);
    expect(r.showupIntegrityScore).toBe(NEUTRAL_SCORE);
    expect(r.splitHonoringScore).toBe(NEUTRAL_SCORE);
    expect(r.documentationHygieneScore).toBe(NEUTRAL_SCORE);
    expect(r.compositeScore).toBe(NEUTRAL_SCORE);
  });

  it('scores a fast, honest, well-documented member near 100', () => {
    const r = computeReliabilityScore({
      avgFirstResponseMinutes: 3,
      visitsScheduled: 10,
      visitsHonored: 10,
      syndicationsClosed: 8,
      splitsHonored: 8,
      disputes: 0,
      syndicationsWithDocs: 12,
      syndicationsTotal: 12,
    });
    expect(r.responseSpeedScore).toBe(100);
    expect(r.showupIntegrityScore).toBe(100);
    expect(r.splitHonoringScore).toBe(100);
    expect(r.documentationHygieneScore).toBe(100);
    expect(r.compositeScore).toBe(100);
  });

  it('maps response speed linearly between the fast (5m) and slow (120m) bands', () => {
    expect(computeReliabilityScore({ ...EMPTY, avgFirstResponseMinutes: 5 }).responseSpeedScore).toBe(100);
    expect(computeReliabilityScore({ ...EMPTY, avgFirstResponseMinutes: 120 }).responseSpeedScore).toBe(0);
    // Midpoint ~62.5m → ~50
    const mid = computeReliabilityScore({ ...EMPTY, avgFirstResponseMinutes: 62.5 }).responseSpeedScore;
    expect(mid).toBeGreaterThan(48);
    expect(mid).toBeLessThan(52);
  });

  it('treats each dispute as a full closed-deal penalty on split honoring', () => {
    const r = computeReliabilityScore({
      ...EMPTY,
      syndicationsClosed: 4,
      splitsHonored: 4,
      disputes: 1,
    });
    // (4 honored - 1 dispute) / 4 = 75
    expect(r.splitHonoringScore).toBe(75);
  });

  it('never drops split honoring below 0 even with more disputes than honored', () => {
    const r = computeReliabilityScore({
      ...EMPTY,
      syndicationsClosed: 2,
      splitsHonored: 1,
      disputes: 5,
    });
    expect(r.splitHonoringScore).toBe(0);
  });

  it('weights split honoring most heavily in the composite', () => {
    const onlySplitBad = computeReliabilityScore({
      avgFirstResponseMinutes: 3,
      visitsScheduled: 4,
      visitsHonored: 4,
      syndicationsClosed: 4,
      splitsHonored: 0,
      disputes: 0,
      syndicationsWithDocs: 4,
      syndicationsTotal: 4,
    });
    const onlyDocsBad = computeReliabilityScore({
      avgFirstResponseMinutes: 3,
      visitsScheduled: 4,
      visitsHonored: 4,
      syndicationsClosed: 4,
      splitsHonored: 4,
      disputes: 0,
      syndicationsWithDocs: 0,
      syndicationsTotal: 4,
    });
    // Losing the 30-weight split dimension hurts more than losing the 20-weight docs one.
    expect(onlySplitBad.compositeScore).toBeLessThan(onlyDocsBad.compositeScore);
    expect(RELIABILITY_WEIGHTS.splitHonoring).toBeGreaterThan(RELIABILITY_WEIGHTS.documentationHygiene);
  });

  it('sums its weights to 100', () => {
    const total =
      RELIABILITY_WEIGHTS.responseSpeed +
      RELIABILITY_WEIGHTS.showupIntegrity +
      RELIABILITY_WEIGHTS.splitHonoring +
      RELIABILITY_WEIGHTS.documentationHygiene;
    expect(total).toBe(100);
  });
});
