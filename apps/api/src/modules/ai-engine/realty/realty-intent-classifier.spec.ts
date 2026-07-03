import { RealtyIntent, RealtyRoutePolicy } from '@gosumo/shared';
import { RealtyIntentClassifierService } from './realty-intent-classifier.service';
import { LlmClientService } from '../pipeline/llm-client.service';

describe('RealtyIntentClassifierService', () => {
  let service: RealtyIntentClassifierService;
  let llm: jest.Mocked<Pick<LlmClientService, 'complete' | 'extractJson'>>;

  beforeEach(() => {
    llm = {
      complete: jest.fn(),
      extractJson: jest.fn(),
    } as unknown as jest.Mocked<Pick<LlmClientService, 'complete' | 'extractJson'>>;
    service = new RealtyIntentClassifierService(llm as unknown as LlmClientService);
  });

  describe('Tier-1 rules — all 14 intents reachable', () => {
    it.each<[string, RealtyIntent]>([
      ['stop messaging me, this is spam', RealtyIntent.COMPLAINT_ABUSE],
      ['thoda discount kar do bhai', RealtyIntent.NEGOTIATION],
      ['what will my EMI be on a home loan', RealtyIntent.LOAN_QUERY],
      ['what is the RERA number and possession date', RealtyIntent.LEGAL_RERA],
      ['I want to sell my flat', RealtyIntent.SELLER_LEAD],
      ['looking for a flat on rent in kothrud', RealtyIntent.RENTAL],
      ['can I do a site visit tomorrow', RealtyIntent.SITE_VISIT],
      ['please send the brochure and floor plan', RealtyIntent.DOC_REQUEST],
      ['is any 3BHK available', RealtyIntent.AVAILABILITY],
      ['what is the price of the 2bhk', RealtyIntent.PRICE_INQUIRY],
      ['where is the project located, any metro nearby', RealtyIntent.LOCATION_AMENITY],
      ['interested in your 2 bhk project', RealtyIntent.NEW_ENQUIRY],
    ])('classifies "%s" as %s without the LLM', async (text, expected) => {
      const result = await service.classify(text);
      expect(result.intent).toBe(expected);
      expect(result.tier).toBe(1);
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('attaches the default route policy to every result', async () => {
      const neg = await service.classify('best price kya hai, kam karo');
      expect(neg.intent).toBe(RealtyIntent.NEGOTIATION);
      expect(neg.policy).toBe(RealtyRoutePolicy.ESCALATE);

      const avail = await service.classify('koi unit available hai kya');
      expect(avail.policy).toBe(RealtyRoutePolicy.AUTO_ALLOWED);

      const price = await service.classify('rate kya hai per sq ft');
      expect(price.policy).toBe(RealtyRoutePolicy.DRAFT_ONLY);
    });

    it('orders abuse/negotiation ahead of price so they are never misread', async () => {
      // Contains both "price" and a discount ask — must resolve to NEGOTIATION.
      const r = await service.classify('what is the price, and can you give best price discount');
      expect(r.intent).toBe(RealtyIntent.NEGOTIATION);
    });

    it('honours negative patterns (rent vs buy)', () => {
      const m = service.classifyByRules('I want to buy not rent');
      expect(m?.intent).not.toBe(RealtyIntent.RENTAL);
    });
  });

  describe('Tier-3 LLM fallback', () => {
    it('uses the LLM when no rule matches and returns its intent + policy', async () => {
      llm.complete.mockResolvedValue({
        text: '{}',
        modelId: 'claude-haiku-4-5',
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 20,
      });
      llm.extractJson.mockReturnValue({
        primaryIntent: RealtyIntent.SELLER_LEAD,
        secondaryIntent: null,
        confidence: 0.77,
        entities: {},
        reasoning: 'owner intends to list',
      });

      const r = await service.classify('mere paas ek property hai jise list karna chahta hoon');
      expect(r.intent).toBe(RealtyIntent.SELLER_LEAD);
      expect(r.tier).toBe(3);
      expect(r.policy).toBe(RealtyRoutePolicy.ESCALATE);
    });

    it('falls back to GENERAL on invalid LLM output', async () => {
      llm.complete.mockResolvedValue({ text: 'x', modelId: 'm', promptTokens: 1, completionTokens: 1, latencyMs: 1 });
      llm.extractJson.mockReturnValue(null);
      const r = await service.classify('zzz totally unmatched phrase 123');
      expect(r.intent).toBe(RealtyIntent.GENERAL);
      expect(r.policy).toBe(RealtyRoutePolicy.AUTO_ALLOWED);
    });

    it('falls back to GENERAL when the LLM throws', async () => {
      llm.complete.mockRejectedValue(new Error('down'));
      const r = await service.classify('another unmatched phrase qwerty');
      expect(r.intent).toBe(RealtyIntent.GENERAL);
    });
  });
});
