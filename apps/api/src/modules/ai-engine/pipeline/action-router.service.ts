import { Injectable, Logger } from '@nestjs/common';
import { ConfidenceMode, IntentType } from '@gosumo/shared';
import { ScoredConfidence } from './confidence-calculator.service';
import {
  HOLDING_MESSAGES,
  DEFAULT_HOLDING_MESSAGE,
  ESCALATION_HOLDING_MESSAGE,
  OVERRIDE,
} from '../ai-engine.constants';
import { Urgency } from './response-parser.service';

export type RouteAction = 'AUTO_EXECUTE' | 'DRAFT_REVIEW' | 'GUIDED' | 'ESCALATE';

export interface RoutingDecision {
  mode: ConfidenceMode;
  action: RouteAction;
  /** Message to send to the customer immediately (null for AUTO_EXECUTE). */
  holdingMessage: string | null;
  urgency: Urgency;
  /** True when the system should ask the customer a clarifying question. */
  needsClarification: boolean;
  /** True when a HITL task should be created. */
  createsTask: boolean;
}

/**
 * ActionRouterService — maps a scored confidence into a concrete routing
 * decision following the four bands in AI_ENGINE_DESIGN.md §4:
 *
 *   AUTO_PILOT  → send immediately, no task.
 *   DRAFT       → draft a reply, create a review task, hold the customer.
 *   GUIDED      → ask a clarifying question, create a monitoring task.
 *   ESCALATION  → empathetic holding message, create an escalation task.
 *
 * The band edges default to 0.90 / 0.70 / 0.50 but are per-tenant: the
 * calculator resolves them from `businesses.ai_settings` before assigning
 * `scored.mode`, so this router reads the mode and never the thresholds.
 *
 * Pure and deterministic.
 */
@Injectable()
export class ActionRouterService {
  private readonly logger = new Logger(ActionRouterService.name);

  route(scored: ScoredConfidence, intent: IntentType): RoutingDecision {
    const urgency = this.deriveUrgency(scored);

    // Note: escalation-forcing overrides are handled per-band below — they
    // always divert DRAFT/GUIDED into the ESCALATION path.
    switch (scored.mode) {
      case ConfidenceMode.AUTO_PILOT:
        // An escalation-forcing override outranks the band here too.
        //
        // Today the two cannot co-occur, and only by arithmetic: every
        // escalating override caps the score at 0.49 or below, and
        // `MIN_AUTO_EXECUTE_BAND` refuses to honour a tenant auto-execute gate
        // under 0.50. That is a coincidence of two constants in a different
        // file, not a property of this switch — raise `PRICE_NOT_IN_CATALOG`'s
        // ceiling by a hundredth, or lower the floor, and a legal threat
        // auto-sends with no other line of code changing. DRAFT and GUIDED
        // both consult `requiresEscalation`; the band that actually talks to
        // the customer unreviewed is the one that most needs to.
        if (scored.requiresEscalation) {
          return this.escalation(scored, urgency);
        }
        return {
          mode: scored.mode,
          action: 'AUTO_EXECUTE',
          holdingMessage: null,
          urgency,
          needsClarification: false,
          createsTask: false,
        };

      case ConfidenceMode.DRAFT:
        // An escalation-forcing override (e.g. legal threat) outranks DRAFT.
        if (scored.requiresEscalation) {
          return this.escalation(scored, urgency);
        }
        return {
          mode: scored.mode,
          action: 'DRAFT_REVIEW',
          holdingMessage: this.holdingFor(intent),
          urgency,
          needsClarification: false,
          createsTask: true,
        };

      case ConfidenceMode.GUIDED:
        if (scored.requiresEscalation) {
          return this.escalation(scored, urgency);
        }
        return {
          mode: scored.mode,
          action: 'GUIDED',
          holdingMessage: this.holdingFor(intent),
          urgency,
          needsClarification: true,
          createsTask: true,
        };

      case ConfidenceMode.ESCALATION:
      default:
        return this.escalation(scored, urgency);
    }
  }

  private escalation(scored: ScoredConfidence, urgency: Urgency): RoutingDecision {
    return {
      mode: ConfidenceMode.ESCALATION,
      action: 'ESCALATE',
      holdingMessage: ESCALATION_HOLDING_MESSAGE,
      urgency,
      needsClarification: false,
      createsTask: true,
    };
  }

  private holdingFor(intent: IntentType): string {
    return HOLDING_MESSAGES[intent] ?? DEFAULT_HOLDING_MESSAGE;
  }

  /**
   * Derive urgency from the worst triggered override, falling back to LOW.
   */
  private deriveUrgency(scored: ScoredConfidence): Urgency {
    const codes = new Set(scored.overrides.map((o) => o.code));

    if (codes.has(OVERRIDE.LEGAL_THREAT.code) || codes.has(OVERRIDE.JAILBREAK.code) || codes.has(OVERRIDE.PII_DETECTED.code)) {
      return 'CRITICAL';
    }
    if (
      codes.has(OVERRIDE.SENTIMENT_CRITICAL.code) ||
      codes.has(OVERRIDE.HUMAN_REQUEST.code) ||
      codes.has(OVERRIDE.LOOP.code)
    ) {
      return 'HIGH';
    }
    if (codes.has(OVERRIDE.REFUND_OVER_LIMIT.code) || codes.has(OVERRIDE.PRICE_NOT_IN_CATALOG.code)) {
      return 'MEDIUM';
    }
    return 'LOW';
  }
}
