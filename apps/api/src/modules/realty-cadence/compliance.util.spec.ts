/**
 * WhatsApp compliance gate unit tests (blueprint §21).
 *
 * The gate is a pure function, so every branch is covered deterministically:
 *  1. Opt-out is absolute — blocked regardless of template/window.
 *  2. A missing or unapproved template blocks the send.
 *  3. Inside the 24h service window any category may go out.
 *  4. Outside the window only UTILITY templates go out; MARKETING is blocked.
 */

import { evaluateCompliance, isServiceWindowOpen, SERVICE_WINDOW_MS } from './compliance.util';

const NOW = new Date('2026-07-03T12:00:00Z');
const APPROVED_UTILITY = { approvalStatus: 'APPROVED', category: 'UTILITY' };
const APPROVED_MARKETING = { approvalStatus: 'APPROVED', category: 'MARKETING' };

describe('isServiceWindowOpen', () => {
  it('is false when there is no inbound message', () => {
    expect(isServiceWindowOpen(null, NOW)).toBe(false);
  });

  it('is true within 24h of the last inbound', () => {
    const lastInbound = new Date(NOW.getTime() - 1000);
    expect(isServiceWindowOpen(lastInbound, NOW)).toBe(true);
  });

  it('is true exactly at the 24h boundary', () => {
    const lastInbound = new Date(NOW.getTime() - SERVICE_WINDOW_MS);
    expect(isServiceWindowOpen(lastInbound, NOW)).toBe(true);
  });

  it('is false past the 24h boundary', () => {
    const lastInbound = new Date(NOW.getTime() - SERVICE_WINDOW_MS - 1000);
    expect(isServiceWindowOpen(lastInbound, NOW)).toBe(false);
  });
});

describe('evaluateCompliance', () => {
  it('blocks an opted-out buyer no matter what (absolute)', () => {
    const decision = evaluateCompliance({
      optOut: true,
      lastInboundAt: new Date(NOW.getTime() - 1000), // window open
      now: NOW,
      template: APPROVED_UTILITY,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('OPTED_OUT');
  });

  it('blocks when no template is resolved', () => {
    const decision = evaluateCompliance({
      optOut: false,
      lastInboundAt: new Date(NOW.getTime() - 1000),
      now: NOW,
      template: null,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('NO_TEMPLATE');
  });

  it('blocks an unapproved template', () => {
    const decision = evaluateCompliance({
      optOut: false,
      lastInboundAt: new Date(NOW.getTime() - 1000),
      now: NOW,
      template: { approvalStatus: 'PENDING', category: 'UTILITY' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('TEMPLATE_NOT_APPROVED');
  });

  it('allows any category inside the service window', () => {
    const decision = evaluateCompliance({
      optOut: false,
      lastInboundAt: new Date(NOW.getTime() - 60_000), // 1 min ago — open
      now: NOW,
      template: APPROVED_MARKETING,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('OK');
    expect(decision.requiresTemplate).toBe(false);
  });

  it('allows a UTILITY template outside the window (requires template)', () => {
    const decision = evaluateCompliance({
      optOut: false,
      lastInboundAt: new Date(NOW.getTime() - SERVICE_WINDOW_MS - 60_000), // closed
      now: NOW,
      template: APPROVED_UTILITY,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('OK');
    expect(decision.requiresTemplate).toBe(true);
  });

  it('blocks a MARKETING template outside the window', () => {
    const decision = evaluateCompliance({
      optOut: false,
      lastInboundAt: new Date(NOW.getTime() - SERVICE_WINDOW_MS - 60_000), // closed
      now: NOW,
      template: APPROVED_MARKETING,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('MARKETING_OUTSIDE_WINDOW');
  });

  it('blocks a MARKETING template when there is no inbound at all (closed window)', () => {
    const decision = evaluateCompliance({
      optOut: false,
      lastInboundAt: null,
      now: NOW,
      template: APPROVED_MARKETING,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('MARKETING_OUTSIDE_WINDOW');
  });
});
