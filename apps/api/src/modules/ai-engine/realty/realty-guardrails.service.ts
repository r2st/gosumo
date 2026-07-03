import { Injectable, Logger } from '@nestjs/common';
import { RealtyIntent } from '@gosumo/shared';
import type { RealtyAction } from '@gosumo/shared';

/**
 * The verified grounding facts a proposed response is checked against. Nothing
 * outside this set may be asserted to the buyer.
 */
export interface RealtyGrounding {
  /** All-in prices (paise) of verified, fresh units + project price bands — the only quotable figures. */
  verifiedPricesPaise: number[];
  /** The lead's own stated budget bounds (paise) — echoing these back is allowed. */
  leadBudgetPaise?: number[];
  /** True when at least one AVAILABLE unit is within the 24h freshness window. */
  hasFreshAvailableUnit: boolean;
  /** RERA numbers present verbatim in a verified fact sheet. */
  sheetReraNumbers?: string[];
  /** The lead has opted out — no send of any kind is permitted. */
  leadOptedOut: boolean;
  /** Names/phones of OTHER buyers that must never surface in this response. */
  otherBuyerIdentifiers?: string[];
}

/** A proposed customer-facing turn to be vetted before it can be sent. */
export interface RealtyProposal {
  intent: RealtyIntent;
  responseText: string | null;
  actions?: RealtyAction[];
}

export type RealtyViolationSeverity = 'BLOCK' | 'REWRITE';

export interface RealtyViolation {
  code: string;
  reason: string;
  /** BLOCK ⇒ cannot auto-send (human required); REWRITE ⇒ salvageable. */
  severity: RealtyViolationSeverity;
}

export interface RealtyGuardResult {
  violations: RealtyViolation[];
  /** True when the response may not be sent autonomously as-is. */
  blocked: boolean;
  /** True when a human must take over (money/legal/abuse/opt-out/cross-buyer). */
  mustEscalate: boolean;
  /** True when the only issue is a stale availability claim to be softened. */
  rewriteToConfirming: boolean;
}

const LAKH_PAISE = 1e7;
const CRORE_PAISE = 1e9;
/** A quoted figure is "grounded" if within this fraction of an allowed price. */
const PRICE_TOLERANCE = 0.02;

/** Intents where the AI would be quoting a *property* price (vs echoing budget). */
const PRICE_QUOTING_INTENTS = new Set<RealtyIntent>([
  RealtyIntent.PRICE_INQUIRY,
  RealtyIntent.AVAILABILITY,
  RealtyIntent.NEW_ENQUIRY,
  RealtyIntent.NEGOTIATION,
  RealtyIntent.GENERAL,
]);

/**
 * RealtyGuardrailsService — the realty hard rules (blueprint §16.3, §21).
 *
 * These override any confidence score. A proposed response is refused (or
 * softened) when it would: quote a price absent from a verified sheet;
 * negotiate; assert unverified availability; make RERA/possession claims beyond
 * the sheet; give loan/tax/investment advice; message an opted-out number; or
 * disclose another buyer's information.
 *
 * Pure and synchronous — the orchestrator turns a BLOCK into a HITL escalation
 * and logs every autonomous action separately to `audit_logs`.
 */
@Injectable()
export class RealtyGuardrailsService {
  private readonly logger = new Logger(RealtyGuardrailsService.name);

  evaluate(proposal: RealtyProposal, grounding: RealtyGrounding): RealtyGuardResult {
    const violations: RealtyViolation[] = [];
    const text = proposal.responseText ?? '';

    // 1. Opt-out is absolute — nothing may be sent.
    if (grounding.leadOptedOut) {
      violations.push({
        code: 'opted_out_recipient',
        reason: 'Recipient has opted out — no automated message may be sent',
        severity: 'BLOCK',
      });
    }

    // 2. Never negotiate.
    if (proposal.intent === RealtyIntent.NEGOTIATION || this.offersDiscount(text)) {
      violations.push({
        code: 'no_negotiation',
        reason: 'Price negotiation is never autonomous — hand off to the broker',
        severity: 'BLOCK',
      });
    }

    // 3. No loan / tax / investment advice.
    if (proposal.intent === RealtyIntent.LOAN_QUERY || this.givesFinancialAdvice(text)) {
      violations.push({
        code: 'financial_advice',
        reason: 'Loan / tax / investment advice must come from a licensed human',
        severity: 'BLOCK',
      });
    }

    // 4. No unverified price — every quoted figure must be grounded.
    if (PRICE_QUOTING_INTENTS.has(proposal.intent)) {
      const ungrounded = this.ungroundedPrices(text, grounding);
      if (ungrounded.length > 0) {
        violations.push({
          code: 'unverified_price',
          reason: `Quoted price(s) not in any verified sheet: ${ungrounded
            .map((p) => `₹${Math.round(p / LAKH_PAISE)}L`)
            .join(', ')}`,
          severity: 'BLOCK',
        });
      }
    }

    // 5. No unverified availability (>24h ⇒ must say "confirming").
    if (this.assertsAvailable(text) && !grounding.hasFreshAvailableUnit) {
      violations.push({
        code: 'stale_availability',
        reason: 'Availability not verified within 24h — must answer "confirming" instead',
        severity: 'REWRITE',
      });
    }

    // 6. No RERA / possession claims beyond the sheet verbatim.
    const reraViolation = this.unverifiedReraClaim(text, grounding.sheetReraNumbers ?? []);
    if (reraViolation) {
      violations.push(reraViolation);
    }

    // 7. No cross-buyer disclosure.
    if (this.disclosesOtherBuyer(text, grounding.otherBuyerIdentifiers ?? [])) {
      violations.push({
        code: 'cross_buyer_disclosure',
        reason: "Response references another buyer's information",
        severity: 'BLOCK',
      });
    }

    const blockers = violations.filter((v) => v.severity === 'BLOCK');
    const rewriteToConfirming =
      blockers.length === 0 && violations.some((v) => v.code === 'stale_availability');

    if (violations.length > 0) {
      this.logger.debug(`Realty guardrails fired: ${violations.map((v) => v.code).join(', ')}`);
    }

    return {
      violations,
      blocked: blockers.length > 0 || violations.length > 0,
      mustEscalate: blockers.length > 0,
      rewriteToConfirming,
    };
  }

  // ─────────────────────────────────────────────
  // Individual detectors (pure)
  // ─────────────────────────────────────────────

  offersDiscount(text: string): boolean {
    if (!text) return false;
    return /\b(discount|special price|reduce the price|lower(ed)? price|price drop|kam kar|thoda kam|de dunga|% off|percent off|deal at|best price for you)\b/i.test(
      text,
    );
  }

  givesFinancialAdvice(text: string): boolean {
    if (!text) return false;
    return /\b(you should invest|good investment|guaranteed return|tax benefit|save tax|emi will be|your emi|eligible for a? ?loan|loan of ₹|interest rate (is|will)|80c|capital gain)\b/i.test(
      text,
    );
  }

  assertsAvailable(text: string): boolean {
    if (!text) return false;
    // Affirmative availability, but not when already hedged as "confirming".
    if (/\b(confirming|let me confirm|will confirm|checking availability|check kar)\b/i.test(text)) {
      return false;
    }
    return /\b(is available|are available|units? available|in stock|yes,? we have|available hai|abhi available|ready to move and available)\b/i.test(
      text,
    );
  }

  unverifiedReraClaim(text: string, sheetReraNumbers: string[]): RealtyViolation | null {
    if (!text) return null;

    // Any RERA-number-shaped token in the text must appear in a verified sheet.
    const reraTokens = text.match(/\b[A-Z]\d{5,}[A-Z0-9]*\b|\bP\d{6,}\b/g) ?? [];
    for (const token of reraTokens) {
      if (!sheetReraNumbers.some((n) => n.replace(/\s/g, '') === token.replace(/\s/g, ''))) {
        return {
          code: 'rera_claim_unverified',
          reason: `RERA number "${token}" is not present in a verified sheet`,
          severity: 'BLOCK',
        };
      }
    }

    // Concrete possession/approval assertions require a verbatim sheet source.
    if (
      /\b(possession (in|by|date is|will be)|ready by|handover in|oc received|approved by rera|rera approved)\b/i.test(
        text,
      )
    ) {
      return {
        code: 'possession_claim_unverified',
        reason: 'Possession / approval claims must be quoted verbatim from a verified sheet',
        severity: 'BLOCK',
      };
    }
    return null;
  }

  disclosesOtherBuyer(text: string, identifiers: string[]): boolean {
    if (!text) return false;
    const lower = text.toLowerCase();
    return identifiers.some((id) => id && lower.includes(id.toLowerCase()));
  }

  // ─────────────────────────────────────────────
  // Price grounding
  // ─────────────────────────────────────────────

  /** Return quoted figures (paise) in the text that match no allowed price. */
  private ungroundedPrices(text: string, grounding: RealtyGrounding): number[] {
    const allowed = [...grounding.verifiedPricesPaise, ...(grounding.leadBudgetPaise ?? [])];
    const quoted = this.extractQuotedPaise(text);
    return quoted.filter((q) => !allowed.some((a) => this.near(q, a)));
  }

  private extractQuotedPaise(text: string): number[] {
    const out: number[] = [];
    const unitRe = /₹?\s*(\d+(?:\.\d+)?)\s*(lakh|lac|lacs|lakhs|cr|crore|crores)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = unitRe.exec(text)) !== null) {
      const value = parseFloat(m[1]!);
      const unit = m[2]!.toLowerCase();
      out.push(unit.startsWith('cr') ? Math.round(value * CRORE_PAISE) : Math.round(value * LAKH_PAISE));
    }
    // Grouped rupee figures like ₹85,00,000
    const groupedRe = /₹\s*([\d,]{5,})/g;
    while ((m = groupedRe.exec(text)) !== null) {
      const rupees = parseInt(m[1]!.replace(/,/g, ''), 10);
      if (Number.isFinite(rupees)) out.push(rupees * 100);
    }
    return out;
  }

  private near(a: number, b: number): boolean {
    if (a === b) return true;
    if (b === 0) return a === 0;
    return Math.abs(a - b) / b <= PRICE_TOLERANCE;
  }
}
