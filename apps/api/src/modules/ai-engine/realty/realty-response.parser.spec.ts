import { RealtyIntent } from '@gosumo/shared';
import { RealtyResponseParserService } from './realty-response.parser';
import { LlmClientService } from '../pipeline/llm-client.service';

describe('RealtyResponseParserService', () => {
  let parser: RealtyResponseParserService;
  const llm = {
    extractJson: <T>(t: string): T | null => {
      try {
        return JSON.parse(t) as T;
      } catch {
        return null;
      }
    },
  } as unknown as LlmClientService;

  beforeEach(() => {
    parser = new RealtyResponseParserService(llm);
  });

  it('parses a well-formed grounded response', () => {
    const raw = JSON.stringify({
      response_text: 'Sure, the 2BHK in Wakad is a great fit.',
      confidence: 82,
      intent: 'AVAILABILITY',
      bltc_updates: { config: '2BHK', budgetMaxPaise: 800000000, purpose: 'END_USE', financing: 'CASH' },
      stage_transition: 'QUALIFIED',
      actions: [{ type: 'send_asset', parameters: { assetType: 'BROCHURE' } }],
      escalation_reason: null,
    });
    const r = parser.parse(raw, RealtyIntent.GENERAL);
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe(82);
    expect(r!.intent).toBe('AVAILABILITY');
    expect(r!.bltcUpdates).toEqual({
      config: '2BHK',
      budgetMaxPaise: 800000000,
      purpose: 'END_USE',
      financing: 'CASH',
    });
    expect(r!.actions).toEqual([{ type: 'send_asset', parameters: { assetType: 'BROCHURE' } }]);
    expect(r!.stageTransition).toBe('QUALIFIED');
  });

  it('returns null when no JSON can be recovered', () => {
    expect(parser.parse('the model rambled with no json', RealtyIntent.GENERAL)).toBeNull();
  });

  it('clamps confidence into 0–100 and falls back on a bad intent', () => {
    const raw = JSON.stringify({ response_text: 'hi', confidence: 250, intent: 'NONSENSE' });
    const r = parser.parse(raw, RealtyIntent.NEW_ENQUIRY)!;
    expect(r.confidence).toBe(100);
    expect(r.intent).toBe('NEW_ENQUIRY');
  });

  it('drops malformed bltc fields and actions without a type', () => {
    const raw = JSON.stringify({
      response_text: 'ok',
      confidence: 50,
      intent: 'GENERAL',
      bltc_updates: { config: 123, financing: 'BITCOIN', localities: ['Wakad', 5] },
      actions: [{ parameters: {} }, { type: 'book_site_visit', parameters: { when: 'tomorrow' } }],
    });
    const r = parser.parse(raw, RealtyIntent.GENERAL)!;
    expect(r.bltcUpdates.config).toBeUndefined();
    expect(r.bltcUpdates.financing).toBeUndefined();
    expect(r.bltcUpdates.localities).toEqual(['Wakad']);
    expect(r.actions).toEqual([{ type: 'book_site_visit', parameters: { when: 'tomorrow' } }]);
  });

  it('defaults optional fields safely', () => {
    const r = parser.parse(JSON.stringify({ intent: 'GENERAL' }), RealtyIntent.GENERAL)!;
    expect(r.responseText).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.bltcUpdates).toEqual({});
    expect(r.actions).toEqual([]);
    expect(r.stageTransition).toBeNull();
  });
});
