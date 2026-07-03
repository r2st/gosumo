import type { ComplianceDecision } from '@gosumo/shared';

/**
 * The WhatsApp compliance gate (blueprint §21 — WhatsApp hygiene), as a pure
 * function so it is exhaustively unit-testable and side-effect free.
 *
 * Rules, in priority order:
 *  1. An opted-out buyer is never messaged — absolute (root rule, blueprint §21).
 *  2. A cadence step must have an APPROVED template — sends are blocked otherwise.
 *  3. Inside the 24-hour customer service window (i.e. the buyer messaged us
 *     within 24h) any category may be sent freely.
 *  4. Outside the window, only a template send is allowed, and a MARKETING
 *     template may NOT be sent — only UTILITY templates go out.
 */

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ComplianceInput {
  /** Whether the buyer has opted out of automated messaging. */
  optOut: boolean;
  /** Timestamp of the buyer's last inbound message (null = never / unknown). */
  lastInboundAt: Date | null;
  /** Evaluation time — injected for deterministic testing. */
  now: Date;
  /** The template the step would send (null = no template resolved). */
  template: { approvalStatus: string; category: string } | null;
}

/** Is the 24-hour WhatsApp customer-service window currently open? */
export function isServiceWindowOpen(lastInboundAt: Date | null, now: Date): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() <= SERVICE_WINDOW_MS;
}

/** Evaluate whether a single templated cadence send is permitted right now. */
export function evaluateCompliance(input: ComplianceInput): ComplianceDecision {
  if (input.optOut) {
    return {
      allowed: false,
      code: 'OPTED_OUT',
      reason: 'Buyer has opted out — no automated sends are permitted.',
      requiresTemplate: false,
    };
  }

  if (!input.template) {
    return {
      allowed: false,
      code: 'NO_TEMPLATE',
      reason: 'Cadence step has no resolvable message template.',
      requiresTemplate: true,
    };
  }

  if (input.template.approvalStatus !== 'APPROVED') {
    return {
      allowed: false,
      code: 'TEMPLATE_NOT_APPROVED',
      reason: `Template is ${input.template.approvalStatus}, not APPROVED.`,
      requiresTemplate: true,
    };
  }

  const windowOpen = isServiceWindowOpen(input.lastInboundAt, input.now);
  if (windowOpen) {
    // Inside the service window any category (utility or marketing) may go out.
    return {
      allowed: true,
      code: 'OK',
      reason: 'Inside the 24h service window.',
      requiresTemplate: false,
    };
  }

  // Window closed — a template is mandatory, and MARKETING is disallowed.
  if (input.template.category === 'MARKETING') {
    return {
      allowed: false,
      code: 'MARKETING_OUTSIDE_WINDOW',
      reason: 'A MARKETING template cannot be sent outside the 24h service window.',
      requiresTemplate: true,
    };
  }

  return {
    allowed: true,
    code: 'OK',
    reason: 'UTILITY template send outside the service window.',
    requiresTemplate: true,
  };
}
