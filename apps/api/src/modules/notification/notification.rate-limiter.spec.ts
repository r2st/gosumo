import { NotificationTemplateChannel } from '@prisma/client';
import { NotificationRateLimiter } from './notification.rate-limiter';

const BUSINESS = 'biz-1';

describe('NotificationRateLimiter', () => {
  let limiter: NotificationRateLimiter;

  beforeEach(() => {
    // Tight custom rules for deterministic tests: 2 per 1000ms.
    limiter = new NotificationRateLimiter({
      WHATSAPP: { limit: 2, windowMs: 1000 },
      SMS: { limit: 2, windowMs: 1000 },
      EMAIL: { limit: 2, windowMs: 1000 },
      PUSH: { limit: 2, windowMs: 1000 },
    });
  });

  it('allows up to the limit within a window', () => {
    const t0 = 1_000_000;
    expect(limiter.tryConsume(BUSINESS, NotificationTemplateChannel.SMS, t0).allowed).toBe(true);
    expect(limiter.tryConsume(BUSINESS, NotificationTemplateChannel.SMS, t0 + 1).allowed).toBe(true);
    const third = limiter.tryConsume(BUSINESS, NotificationTemplateChannel.SMS, t0 + 2);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets after the window elapses', () => {
    const t0 = 2_000_000;
    limiter.tryConsume(BUSINESS, NotificationTemplateChannel.EMAIL, t0);
    limiter.tryConsume(BUSINESS, NotificationTemplateChannel.EMAIL, t0 + 1);
    expect(limiter.tryConsume(BUSINESS, NotificationTemplateChannel.EMAIL, t0 + 1).allowed).toBe(false);
    // After the window passes, quota is restored.
    expect(limiter.tryConsume(BUSINESS, NotificationTemplateChannel.EMAIL, t0 + 1001).allowed).toBe(true);
  });

  it('scopes windows per business and per channel', () => {
    const t0 = 3_000_000;
    limiter.tryConsume('biz-a', NotificationTemplateChannel.SMS, t0);
    limiter.tryConsume('biz-a', NotificationTemplateChannel.SMS, t0);
    // Different business is unaffected.
    expect(limiter.tryConsume('biz-b', NotificationTemplateChannel.SMS, t0).allowed).toBe(true);
    // Different channel is unaffected.
    expect(limiter.tryConsume('biz-a', NotificationTemplateChannel.PUSH, t0).allowed).toBe(true);
  });

  it('peek does not consume quota', () => {
    const t0 = 4_000_000;
    limiter.tryConsume(BUSINESS, NotificationTemplateChannel.WHATSAPP, t0);
    const peek = limiter.peek(BUSINESS, NotificationTemplateChannel.WHATSAPP, t0);
    expect(peek.remaining).toBe(1);
    // Still room to consume after peeking twice.
    expect(limiter.peek(BUSINESS, NotificationTemplateChannel.WHATSAPP, t0).remaining).toBe(1);
    expect(limiter.tryConsume(BUSINESS, NotificationTemplateChannel.WHATSAPP, t0).allowed).toBe(true);
  });

  it('reset() clears all windows', () => {
    const t0 = 5_000_000;
    limiter.tryConsume(BUSINESS, NotificationTemplateChannel.SMS, t0);
    limiter.tryConsume(BUSINESS, NotificationTemplateChannel.SMS, t0);
    limiter.reset();
    expect(limiter.tryConsume(BUSINESS, NotificationTemplateChannel.SMS, t0).allowed).toBe(true);
  });
});
