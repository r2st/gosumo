import {
  WebChatThrottle,
  WEBCHAT_THROTTLE_RULES,
  WEBCHAT_THROTTLE_SWEEP_THRESHOLD,
} from './webchat-throttle';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

describe('WebChatThrottle', () => {
  let throttle: WebChatThrottle;

  beforeEach(() => {
    throttle = new WebChatThrottle();
    jest.spyOn(throttle['logger'], 'warn').mockImplementation();
  });

  describe('consume', () => {
    it('admits requests up to the ceiling and refuses the one after', () => {
      const { limit } = WEBCHAT_THROTTLE_RULES.session;

      for (let i = 0; i < limit; i += 1) {
        expect(throttle.consume('session', '1.2.3.4', NOW)).toBe(true);
      }

      expect(throttle.consume('session', '1.2.3.4', NOW)).toBe(false);
    });

    it('keys windows separately per caller', () => {
      const { limit } = WEBCHAT_THROTTLE_RULES.session;
      for (let i = 0; i < limit; i += 1) throttle.consume('session', '1.2.3.4', NOW);

      // One exhausted caller must not ration everybody else.
      expect(throttle.consume('session', '5.6.7.8', NOW)).toBe(true);
    });

    it('keys windows separately per bucket', () => {
      const { limit } = WEBCHAT_THROTTLE_RULES.session;
      for (let i = 0; i < limit; i += 1) throttle.consume('session', 'k', NOW);

      expect(throttle.consume('message', 'k', NOW)).toBe(true);
    });

    it('resets the window once it elapses', () => {
      const { limit, windowMs } = WEBCHAT_THROTTLE_RULES.session;
      for (let i = 0; i < limit; i += 1) throttle.consume('session', '1.2.3.4', NOW);

      expect(throttle.consume('session', '1.2.3.4', NOW + windowMs - 1)).toBe(false);
      expect(throttle.consume('session', '1.2.3.4', NOW + windowMs)).toBe(true);
    });

    it('does not charge a caller it cannot identify', () => {
      // Grouping every unidentifiable caller into one window would let any one
      // of them lock out the rest.
      for (let i = 0; i < WEBCHAT_THROTTLE_RULES.session.limit * 2; i += 1) {
        expect(throttle.consume('session', null, NOW)).toBe(true);
      }
      expect(throttle.trackedWindows()).toBe(0);
    });

    it('logs the bucket when a ceiling is reached', () => {
      const warnSpy = jest.spyOn(throttle['logger'], 'warn').mockImplementation();
      const { limit } = WEBCHAT_THROTTLE_RULES.message;
      for (let i = 0; i < limit; i += 1) throttle.consume('message', 's1', NOW);

      throttle.consume('message', 's1', NOW);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"message"'));
    });

    it('uses the wall clock when no timestamp is given', () => {
      expect(throttle.consume('session', 'wall-clock')).toBe(true);
      expect(throttle.trackedWindows()).toBe(1);
    });
  });

  describe('sweep', () => {
    it('bounds the map when an attacker cycles source addresses', () => {
      // The key space belongs to the caller, so without a sweep the mitigation
      // for one denial-of-service would be a slower one.
      const { windowMs } = WEBCHAT_THROTTLE_RULES.session;
      for (let i = 0; i < WEBCHAT_THROTTLE_SWEEP_THRESHOLD; i += 1) {
        throttle.consume('session', `ip-${i}`, NOW);
      }
      expect(throttle.trackedWindows()).toBe(WEBCHAT_THROTTLE_SWEEP_THRESHOLD);

      // One more request, once those windows have elapsed, clears them out.
      throttle.consume('session', 'ip-late', NOW + windowMs);

      expect(throttle.trackedWindows()).toBe(1);
    });

    it('keeps live windows when it sweeps', () => {
      const { windowMs } = WEBCHAT_THROTTLE_RULES.session;
      for (let i = 0; i < WEBCHAT_THROTTLE_SWEEP_THRESHOLD; i += 1) {
        throttle.consume('session', `ip-${i}`, NOW);
      }
      // A window opened later is still live when the early ones expire.
      throttle.consume('session', 'still-live', NOW + windowMs - 1);

      throttle.consume('session', 'newcomer', NOW + windowMs);

      expect(throttle.trackedWindows()).toBe(2);
    });

    it('does not sweep below the threshold', () => {
      const { windowMs } = WEBCHAT_THROTTLE_RULES.session;
      throttle.consume('session', 'a', NOW);

      throttle.consume('session', 'b', NOW + windowMs);

      // 'a' has elapsed but is cheaper to leave than to hunt for.
      expect(throttle.trackedWindows()).toBe(2);
    });
  });

  describe('reset', () => {
    it('clears every window', () => {
      throttle.consume('session', 'a', NOW);
      throttle.reset();
      expect(throttle.trackedWindows()).toBe(0);
    });
  });

  describe('rules', () => {
    it('rations new sessions more tightly than messages, since each costs table rows', () => {
      expect(WEBCHAT_THROTTLE_RULES.session.limit).toBeLessThan(
        WEBCHAT_THROTTLE_RULES.message.limit,
      );
    });

    it('bounds a single host above what one session may spend', () => {
      // Otherwise the per-IP ceiling would bind before the per-session one and
      // a single busy visitor would be cut off.
      expect(WEBCHAT_THROTTLE_RULES.messageIp.limit).toBeGreaterThan(
        WEBCHAT_THROTTLE_RULES.message.limit,
      );
    });

    it('gives every bucket a positive limit and window', () => {
      for (const [name, rule] of Object.entries(WEBCHAT_THROTTLE_RULES)) {
        expect({ name, ...rule }).toEqual(
          expect.objectContaining({
            limit: expect.any(Number),
            windowMs: expect.any(Number),
          }),
        );
        expect(rule.limit).toBeGreaterThan(0);
        expect(rule.windowMs).toBeGreaterThan(0);
      }
    });
  });
});
