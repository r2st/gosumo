import { IvrDedupTracker, IVR_DEDUP_WINDOW_MS } from './ivr-dedup.util';

const BIZ = 'biz_1';
const PHONE = '+919876543210';

describe('IvrDedupTracker', () => {
  it('triggers on the first call', () => {
    const tracker = new IvrDedupTracker();
    expect(tracker.shouldTrigger(BIZ, PHONE, 0)).toBe(true);
  });

  it('suppresses a repeat inside the window', () => {
    const tracker = new IvrDedupTracker();
    expect(tracker.shouldTrigger(BIZ, PHONE, 0)).toBe(true);
    expect(tracker.shouldTrigger(BIZ, PHONE, 60_000)).toBe(false);
    expect(tracker.shouldTrigger(BIZ, PHONE, IVR_DEDUP_WINDOW_MS - 1)).toBe(false);
  });

  it('triggers again once the window has passed', () => {
    const tracker = new IvrDedupTracker();
    expect(tracker.shouldTrigger(BIZ, PHONE, 0)).toBe(true);
    expect(tracker.shouldTrigger(BIZ, PHONE, IVR_DEDUP_WINDOW_MS)).toBe(true);
  });

  it('measures the window from the first call of a burst, not the last', () => {
    const tracker = new IvrDedupTracker();
    expect(tracker.shouldTrigger(BIZ, PHONE, 0)).toBe(true);
    expect(tracker.shouldTrigger(BIZ, PHONE, 120_000)).toBe(false); // still inside window
    // A persistent redialer cannot hold the window open: the very next call
    // after the window elapses (measured from t=0) triggers again.
    expect(tracker.shouldTrigger(BIZ, PHONE, IVR_DEDUP_WINDOW_MS + 1)).toBe(true);
  });

  it('scopes de-dup per business and per phone', () => {
    const tracker = new IvrDedupTracker();
    expect(tracker.shouldTrigger(BIZ, PHONE, 0)).toBe(true);
    expect(tracker.shouldTrigger('biz_2', PHONE, 1_000)).toBe(true);
    expect(tracker.shouldTrigger(BIZ, '+919000000000', 1_000)).toBe(true);
  });

  it('honours a custom window', () => {
    const tracker = new IvrDedupTracker(1_000);
    expect(tracker.shouldTrigger(BIZ, PHONE, 0)).toBe(true);
    expect(tracker.shouldTrigger(BIZ, PHONE, 500)).toBe(false);
    expect(tracker.shouldTrigger(BIZ, PHONE, 1_000)).toBe(true);
  });
});
