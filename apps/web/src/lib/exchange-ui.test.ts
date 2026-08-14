import { describe, expect, it } from 'vitest';
import {
  RESALE_STATUS_TONE,
  SETTLEMENT_TONE,
  SYNDICATION_STATE_TONE,
  scoreTone,
  shortBusinessId,
} from './exchange-ui';
import type { ResaleListingStatus, SettlementState, SyndicationState } from './realty-types';

describe('SYNDICATION_STATE_TONE', () => {
  it('maps every syndication state to a tone', () => {
    const states: SyndicationState[] = [
      'OFFERED',
      'ACCEPTED',
      'VISIT',
      'CLOSED',
      'EXPIRED',
      'DISPUTED',
    ];
    for (const state of states) {
      expect(SYNDICATION_STATE_TONE[state]).toBeTruthy();
    }
  });

  it('reserves the alarming tones for the states a broker must act on', () => {
    expect(SYNDICATION_STATE_TONE.DISPUTED).toBe('danger');
    expect(SYNDICATION_STATE_TONE.CLOSED).toBe('success');
    expect(SYNDICATION_STATE_TONE.EXPIRED).toBe('neutral');
  });
});

describe('SETTLEMENT_TONE', () => {
  it('maps every settlement state to a tone', () => {
    const states: SettlementState[] = ['UNSETTLED', 'PENDING', 'SETTLED', 'REVERSED'];
    for (const state of states) {
      expect(SETTLEMENT_TONE[state]).toBeTruthy();
    }
  });

  it('flags a reversed payout as danger and a settled one as success', () => {
    // Money moving backwards is the one settlement state that needs a broker's
    // attention, so it must not share a tone with the benign ones.
    expect(SETTLEMENT_TONE.REVERSED).toBe('danger');
    expect(SETTLEMENT_TONE.SETTLED).toBe('success');
    expect(SETTLEMENT_TONE.PENDING).toBe('warning');
  });
});

describe('RESALE_STATUS_TONE', () => {
  it('maps every resale listing status to a tone', () => {
    const statuses: ResaleListingStatus[] = ['ACTIVE', 'UNDER_OFFER', 'SOLD', 'WITHDRAWN'];
    for (const status of statuses) {
      expect(RESALE_STATUS_TONE[status]).toBeTruthy();
    }
  });

  it('only highlights a listing that is still winnable', () => {
    expect(RESALE_STATUS_TONE.ACTIVE).toBe('success');
    expect(RESALE_STATUS_TONE.UNDER_OFFER).toBe('warning');
    expect(RESALE_STATUS_TONE.SOLD).toBe('neutral');
    expect(RESALE_STATUS_TONE.WITHDRAWN).toBe('neutral');
  });
});

describe('scoreTone', () => {
  it('greens a strong score', () => {
    expect(scoreTone(100)).toBe('success');
    expect(scoreTone(75)).toBe('success');
  });

  it('ambers a middling score', () => {
    expect(scoreTone(74)).toBe('warning');
    expect(scoreTone(50)).toBe('warning');
  });

  it('reds a weak score', () => {
    expect(scoreTone(49)).toBe('danger');
    expect(scoreTone(0)).toBe('danger');
  });

  it('holds the boundaries exactly at 75 and 50', () => {
    // These two thresholds decide whether a counterparty looks trustworthy, so
    // an off-by-one here changes who a broker is willing to co-broke with.
    expect(scoreTone(74.9)).toBe('warning');
    expect(scoreTone(49.9)).toBe('danger');
  });

  it('does not throw on an out-of-range score', () => {
    expect(scoreTone(150)).toBe('success');
    expect(scoreTone(-10)).toBe('danger');
  });
});

describe('shortBusinessId', () => {
  it('takes the first 8 characters of a UUID', () => {
    expect(shortBusinessId('3f2a9c1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b')).toBe('3f2a9c1e');
  });

  it('returns a shorter id unchanged rather than padding it', () => {
    expect(shortBusinessId('abc')).toBe('abc');
    expect(shortBusinessId('')).toBe('');
  });
});
