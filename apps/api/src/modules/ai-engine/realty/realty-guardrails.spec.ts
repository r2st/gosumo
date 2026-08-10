import { RealtyIntent } from '@gosumo/shared';
import {
  RealtyGuardrailsService,
  RealtyGrounding,
  RealtyProposal,
} from './realty-guardrails.service';

const LAKH = 1e7;

function grounding(over: Partial<RealtyGrounding> = {}): RealtyGrounding {
  return {
    verifiedPricesPaise: [],
    leadBudgetPaise: [],
    hasFreshAvailableUnit: false,
    sheetReraNumbers: [],
    leadOptedOut: false,
    otherBuyerIdentifiers: [],
    ...over,
  };
}

function proposal(over: Partial<RealtyProposal>): RealtyProposal {
  return { intent: RealtyIntent.GENERAL, responseText: null, actions: [], ...over };
}

describe('RealtyGuardrailsService (hard rules)', () => {
  const svc = new RealtyGuardrailsService();

  describe('no unverified price', () => {
    it('blocks a price that is not in any verified sheet', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.PRICE_INQUIRY, responseText: 'The 2BHK is ₹95 lakh.' }),
        grounding({ verifiedPricesPaise: [78 * LAKH] }),
      );
      expect(r.violations.map((v) => v.code)).toContain('unverified_price');
      expect(r.mustEscalate).toBe(true);
      expect(r.blocked).toBe(true);
    });

    it('allows a price that matches a verified sheet (within tolerance)', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.PRICE_INQUIRY, responseText: 'The 2BHK is ₹78 lakh all-in.' }),
        grounding({ verifiedPricesPaise: [78 * LAKH] }),
      );
      expect(r.violations).toHaveLength(0);
      expect(r.blocked).toBe(false);
    });

    it("allows echoing the buyer's own stated budget", () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.PRICE_INQUIRY, responseText: 'Understood, your budget of 70 lakh.' }),
        grounding({ leadBudgetPaise: [70 * LAKH] }),
      );
      expect(r.violations).toHaveLength(0);
    });
  });

  describe('no negotiation', () => {
    it('blocks the NEGOTIATION intent outright', () => {
      const r = svc.evaluate(proposal({ intent: RealtyIntent.NEGOTIATION, responseText: 'Sure.' }), grounding());
      expect(r.violations.map((v) => v.code)).toContain('no_negotiation');
      expect(r.mustEscalate).toBe(true);
    });

    it('blocks a discount offer even on a benign intent', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.NEW_ENQUIRY, responseText: 'I can give you a special discount.' }),
        grounding(),
      );
      expect(r.violations.map((v) => v.code)).toContain('no_negotiation');
    });
  });

  describe('availability freshness', () => {
    it('rewrites an availability claim with no fresh unit to "confirming"', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.AVAILABILITY, responseText: 'Yes, the 3BHK is available now.' }),
        grounding({ hasFreshAvailableUnit: false }),
      );
      expect(r.violations.map((v) => v.code)).toContain('stale_availability');
      expect(r.rewriteToConfirming).toBe(true);
      expect(r.mustEscalate).toBe(false);
    });

    it('allows an availability claim backed by a fresh unit', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.AVAILABILITY, responseText: 'Yes, the 3BHK is available.' }),
        grounding({ hasFreshAvailableUnit: true }),
      );
      expect(r.violations).toHaveLength(0);
    });

    it('does not fire when the reply already hedges as "confirming"', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.AVAILABILITY, responseText: 'Let me confirm availability and revert.' }),
        grounding({ hasFreshAvailableUnit: false }),
      );
      expect(r.violations).toHaveLength(0);
    });
  });

  describe('RERA / possession claims', () => {
    it('blocks a RERA number absent from the sheet', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.LEGAL_RERA, responseText: 'RERA is P52100012345.' }),
        grounding({ sheetReraNumbers: [] }),
      );
      expect(r.violations.map((v) => v.code)).toContain('rera_claim_unverified');
    });

    it('allows a RERA number present in the sheet', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.LEGAL_RERA, responseText: 'RERA is P52100012345.' }),
        grounding({ sheetReraNumbers: ['P52100012345'] }),
      );
      expect(r.violations.filter((v) => v.code === 'rera_claim_unverified')).toHaveLength(0);
    });

    it('blocks an unverified possession claim', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.LEGAL_RERA, responseText: 'Possession by Dec 2026, guaranteed.' }),
        grounding(),
      );
      expect(r.violations.map((v) => v.code)).toContain('possession_claim_unverified');
    });
  });

  describe('no financial advice', () => {
    it('blocks the LOAN_QUERY intent', () => {
      const r = svc.evaluate(proposal({ intent: RealtyIntent.LOAN_QUERY, responseText: 'Sure.' }), grounding());
      expect(r.violations.map((v) => v.code)).toContain('financial_advice');
    });

    it('blocks EMI/loan advice in the text', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.NEW_ENQUIRY, responseText: 'Your EMI will be around 45000.' }),
        grounding(),
      );
      expect(r.violations.map((v) => v.code)).toContain('financial_advice');
    });
  });

  describe('opt-out and cross-buyer', () => {
    it('blocks everything when the lead has opted out', () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.GENERAL, responseText: 'Hello!' }),
        grounding({ leadOptedOut: true }),
      );
      expect(r.violations.map((v) => v.code)).toContain('opted_out_recipient');
      expect(r.mustEscalate).toBe(true);
    });

    it("blocks disclosure of another buyer's identity", () => {
      const r = svc.evaluate(
        proposal({ intent: RealtyIntent.GENERAL, responseText: 'Another buyer Ramesh offered more.' }),
        grounding({ otherBuyerIdentifiers: ['Ramesh'] }),
      );
      expect(r.violations.map((v) => v.code)).toContain('cross_buyer_disclosure');
    });
  });

  it('passes a fully grounded, compliant reply', () => {
    const r = svc.evaluate(
      proposal({
        intent: RealtyIntent.LOCATION_AMENITY,
        responseText: 'The project is in Wakad with a clubhouse and gym. Shall I share the brochure?',
      }),
      grounding(),
    );
    expect(r.violations).toHaveLength(0);
    expect(r.blocked).toBe(false);
    expect(r.mustEscalate).toBe(false);
  });
});
