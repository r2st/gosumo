import { RealtyIntent } from '@gosumo/shared';
import type { BltcProfile } from '@gosumo/shared';
import { RealtyAiService } from './realty-ai.service';
import { RealtyIntentClassifierService } from './realty-intent-classifier.service';
import { BltcExtractorService } from './bltc-extractor.service';
import { RealtyGuardrailsService } from './realty-guardrails.service';
import { GuardrailsService } from '../safety/guardrails.service';
import { RealtyResponseParserService } from './realty-response.parser';
import { RealtyAuditService } from './realty-audit.service';
import { LlmClientService } from '../pipeline/llm-client.service';
import { RealtyLeadsService } from '../../realty-leads/realty-leads.service';
import { RealtyInventoryService } from '../../realty-inventory/realty-inventory.service';

const LAKH = 1e7;

function profile(over: Partial<BltcProfile> = {}): BltcProfile {
  return {
    budgetMinPaise: null,
    budgetMaxPaise: null,
    localities: [],
    timelineMonths: null,
    config: null,
    purpose: null,
    financing: null,
    ...over,
  };
}

function leadDto(over: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    businessId: 'biz-1',
    whatsappPhone: '+919876543210',
    optOut: false,
    name: 'Priya',
    conversationId: 'conv-1',
    bltc: profile(),
    ...over,
  } as unknown as Awaited<ReturnType<RealtyLeadsService['getLead']>>;
}

describe('RealtyAiService (grounded loop, zero invented facts)', () => {
  let service: RealtyAiService;
  let classifier: { classify: jest.Mock };
  let llm: { complete: jest.Mock; extractJson: <T>(t: string) => T | null };
  let leads: { getLead: jest.Mock; applyBltcUpdate: jest.Mock };
  let inventory: {
    matchForLead: jest.Mock;
    getProject: jest.Mock;
    listUnits: jest.Mock;
    listAssets: jest.Mock;
  };
  let audit: { record: jest.Mock };
  let emitter: { emit: jest.Mock };

  const completionOf = (obj: unknown) => ({
    text: JSON.stringify(obj),
    modelId: 'openai/gpt-oss-120b:free',
    promptTokens: 100,
    completionTokens: 50,
    latencyMs: 200,
  });

  beforeEach(() => {
    classifier = { classify: jest.fn() };
    llm = {
      complete: jest.fn(),
      extractJson: <T>(t: string): T | null => {
        try {
          return JSON.parse(t) as T;
        } catch {
          return null;
        }
      },
    };
    leads = {
      getLead: jest.fn(),
      applyBltcUpdate: jest.fn().mockResolvedValue({ lead: { bltc: profile() }, contradictions: [] }),
    };
    inventory = {
      matchForLead: jest.fn().mockResolvedValue([]),
      getProject: jest.fn(),
      listUnits: jest.fn(),
      listAssets: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };

    service = new RealtyAiService(
      classifier as unknown as RealtyIntentClassifierService,
      new BltcExtractorService(),
      new RealtyGuardrailsService(),
      new GuardrailsService(),
      new RealtyResponseParserService(llm as unknown as LlmClientService),
      llm as unknown as LlmClientService,
      leads as unknown as RealtyLeadsService,
      inventory as unknown as RealtyInventoryService,
      audit as unknown as RealtyAuditService,
      emitter as unknown as import('@nestjs/event-emitter').EventEmitter2,
    );
  });

  /** Wire the inventory grounding to one fresh, verified 2BHK at ₹78 L. */
  function groundGreenVista() {
    inventory.matchForLead.mockResolvedValue([
      { projectId: 'p1', unitId: 'u1', projectName: 'Green Vista', config: '2BHK', allInPricePaise: 78 * LAKH, locality: 'Wakad', fitScore: 90, reasons: [] },
    ]);
    inventory.getProject.mockResolvedValue({
      name: 'Green Vista',
      developer: 'Acme',
      locality: 'Wakad',
      reraNumber: 'P52100012345',
      possessionDate: null,
      status: 'RTM',
      amenities: ['Gym'],
      priceBandMinPaise: null,
      priceBandMaxPaise: null,
    });
    inventory.listUnits.mockResolvedValue([
      { id: 'u1', config: '2BHK', allInPricePaise: 78 * LAKH, isFresh: true, availability: 'AVAILABLE', carpetSqft: 650 },
    ]);
  }

  it('qualifies conversationally without inventory and drafts a compliant reply', async () => {
    classifier.classify.mockResolvedValue({ intent: RealtyIntent.NEW_ENQUIRY, secondaryIntent: null, confidence: 0.8, tier: 1, policy: 'AUTO_ALLOWED', entities: {}, reasoning: '' });
    leads.getLead.mockResolvedValue(leadDto());
    leads.applyBltcUpdate.mockResolvedValue({
      lead: { bltc: profile({ budgetMaxPaise: 70 * LAKH, localities: ['Wakad'], timelineMonths: 4 }) },
      contradictions: [],
    });
    llm.complete.mockResolvedValue(
      completionOf({ response_text: 'Great! What configuration are you after — 2BHK or 3BHK?', confidence: 62, intent: 'NEW_ENQUIRY', bltc_updates: {}, stage_transition: null, actions: [], escalation_reason: null }),
    );

    const d = await service.processTurn('biz-1', { leadId: 'lead-1', messageText: 'interested, budget 70 lakh in Wakad, buying in 4 months' });

    expect(d.guardViolations).toHaveLength(0);
    expect(d.responseText).toContain('configuration');
    expect(d.routeMode).not.toBe('AUTO');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('BLOCKS a hallucinated price and escalates (never sends the invented figure)', async () => {
    classifier.classify.mockResolvedValue({ intent: RealtyIntent.PRICE_INQUIRY, secondaryIntent: null, confidence: 0.9, tier: 1, policy: 'DRAFT_ONLY', entities: {}, reasoning: '' });
    leads.getLead.mockResolvedValue(leadDto({ bltc: profile({ config: '2BHK', budgetMaxPaise: 80 * LAKH }) }));
    leads.applyBltcUpdate.mockResolvedValue({ lead: { bltc: profile({ config: '2BHK', budgetMaxPaise: 80 * LAKH }) }, contradictions: [] });
    groundGreenVista();
    // The model INVENTS ₹95 L — the verified price is ₹78 L.
    llm.complete.mockResolvedValue(
      completionOf({ response_text: 'The 2BHK is priced at ₹95 lakh.', confidence: 88, intent: 'PRICE_INQUIRY', bltc_updates: {}, stage_transition: null, actions: [], escalation_reason: null }),
    );

    const d = await service.processTurn('biz-1', { leadId: 'lead-1', messageText: 'what is the price of the 2bhk' });

    expect(d.routeMode).toBe('ESCALATE');
    expect(d.guardViolations).toContain('unverified_price');
    expect(d.responseText ?? '').not.toContain('95');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ violations: expect.arrayContaining(['unverified_price']) }),
    );
  });

  it('allows a price that matches the verified sheet (drafts it for review)', async () => {
    classifier.classify.mockResolvedValue({ intent: RealtyIntent.PRICE_INQUIRY, secondaryIntent: null, confidence: 0.9, tier: 1, policy: 'DRAFT_ONLY', entities: {}, reasoning: '' });
    leads.getLead.mockResolvedValue(leadDto({ bltc: profile({ config: '2BHK', budgetMaxPaise: 80 * LAKH }) }));
    leads.applyBltcUpdate.mockResolvedValue({ lead: { bltc: profile({ config: '2BHK', budgetMaxPaise: 80 * LAKH }) }, contradictions: [] });
    groundGreenVista();
    llm.complete.mockResolvedValue(
      completionOf({ response_text: 'The 2BHK is ₹78 lakh all-in.', confidence: 85, intent: 'PRICE_INQUIRY', bltc_updates: {}, stage_transition: null, actions: [], escalation_reason: null }),
    );

    const d = await service.processTurn('biz-1', { leadId: 'lead-1', messageText: 'price of the 2bhk?' });

    expect(d.guardViolations).toHaveLength(0);
    expect(d.responseText).toContain('78');
    expect(d.routeMode).toBe('DRAFT'); // DRAFT_ONLY policy — never auto-sent
  });

  it('escalates a negotiation without ever generating a discount', async () => {
    classifier.classify.mockResolvedValue({ intent: RealtyIntent.NEGOTIATION, secondaryIntent: null, confidence: 0.9, tier: 1, policy: 'ESCALATE', entities: {}, reasoning: '' });
    leads.getLead.mockResolvedValue(leadDto());
    groundGreenVista();
    llm.complete.mockResolvedValue(
      completionOf({ response_text: 'Let me check with the team on pricing.', confidence: 70, intent: 'NEGOTIATION', bltc_updates: {}, stage_transition: null, actions: [], escalation_reason: null }),
    );

    const d = await service.processTurn('biz-1', { leadId: 'lead-1', messageText: 'can you reduce the price a bit' });

    expect(d.routeMode).toBe('ESCALATE');
    expect(d.guardViolations).toContain('no_negotiation');
  });

  it('never sends to an opted-out lead and skips generation entirely', async () => {
    classifier.classify.mockResolvedValue({ intent: RealtyIntent.GENERAL, secondaryIntent: null, confidence: 0.8, tier: 1, policy: 'AUTO_ALLOWED', entities: {}, reasoning: '' });
    leads.getLead.mockResolvedValue(leadDto({ optOut: true }));

    const d = await service.processTurn('biz-1', { leadId: 'lead-1', messageText: 'hi' });

    expect(d.routeMode).toBe('ESCALATE');
    expect(d.responseText).toBeNull();
    expect(llm.complete).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('softens a stale availability claim to "confirming" and records the decision', async () => {
    classifier.classify.mockResolvedValue({ intent: RealtyIntent.AVAILABILITY, secondaryIntent: null, confidence: 0.85, tier: 1, policy: 'AUTO_ALLOWED', entities: {}, reasoning: '' });
    leads.getLead.mockResolvedValue(leadDto({ bltc: profile({ config: '2BHK' }) }));
    leads.applyBltcUpdate.mockResolvedValue({ lead: { bltc: profile({ config: '2BHK' }) }, contradictions: [] });
    // Matched unit is NOT fresh → availability may not be asserted.
    inventory.matchForLead.mockResolvedValue([
      { projectId: 'p1', unitId: 'u1', projectName: 'Green Vista', config: '2BHK', allInPricePaise: 78 * LAKH, locality: 'Wakad', fitScore: 90, reasons: [] },
    ]);
    inventory.getProject.mockResolvedValue({ name: 'Green Vista', developer: null, locality: 'Wakad', reraNumber: null, possessionDate: null, status: 'UC', amenities: [], priceBandMinPaise: null, priceBandMaxPaise: null });
    inventory.listUnits.mockResolvedValue([{ id: 'u1', config: '2BHK', allInPricePaise: 78 * LAKH, isFresh: false, availability: 'AVAILABLE', carpetSqft: 650 }]);
    llm.complete.mockResolvedValue(
      completionOf({ response_text: 'Yes, the 2BHK is available right now.', confidence: 80, intent: 'AVAILABILITY', bltc_updates: {}, stage_transition: null, actions: [], escalation_reason: null }),
    );

    const d = await service.processTurn('biz-1', { leadId: 'lead-1', messageText: 'is the 2bhk available' });

    expect(d.guardViolations).toContain('stale_availability');
    expect(d.responseText ?? '').toMatch(/confirm/i);
    expect(d.responseText ?? '').not.toMatch(/is available right now/i);
    expect(audit.record).toHaveBeenCalled();
  });
});
