import { IntentType } from '@gosumo/shared';
import { IntentClassifierService } from './intent-classifier.service';
import { LlmClientService } from './llm-client.service';

describe('IntentClassifierService', () => {
  let service: IntentClassifierService;
  let llm: jest.Mocked<Pick<LlmClientService, 'complete' | 'extractJson'>>;

  beforeEach(() => {
    llm = {
      complete: jest.fn(),
      extractJson: jest.fn(),
    } as unknown as jest.Mocked<Pick<LlmClientService, 'complete' | 'extractJson'>>;
    service = new IntentClassifierService(llm as unknown as LlmClientService);
  });

  describe('Tier-1 rules', () => {
    it.each<[string, IntentType]>([
      ['paisa wapas karo', IntentType.REFUND],
      ['mera parcel kahan hai', IntentType.ORDER_TRACKING],
      ['UPI link bhejo', IntentType.PAYMENT],
      ['kal 3 baje slot available hai', IntentType.BOOKING],
      ['facial ka price kya hai', IntentType.PRICING],
      ['2 kilo aloo chahiye', IntentType.ORDER],
    ])('classifies "%s" as %s without calling the LLM', async (text, expected) => {
      const result = await service.classify(text);
      expect(result.intent).toBe(expected);
      expect(result.tier).toBe(1);
      expect(llm.complete).not.toHaveBeenCalled();
    });

    it('honors negative patterns ("don\'t cancel" is not CANCELLATION)', () => {
      const match = service.classifyByRules('please dont cancel my order');
      // Should not match CANCELLATION; may match ORDER instead or nothing.
      expect(match?.intent).not.toBe(IntentType.CANCELLATION);
    });

    it('returns null from classifyByRules when nothing matches', () => {
      expect(service.classifyByRules('hmm okay sure')).toBeNull();
    });
  });

  describe('Tier-3 LLM fallback', () => {
    it('calls the LLM and returns its classification when rules miss', async () => {
      llm.complete.mockResolvedValue({
        text: '{"primaryIntent":"CHIT_CHAT","secondaryIntent":null,"confidence":0.8,"entities":{},"reasoning":"greeting"}',
        modelId: 'claude-haiku-4-5',
        promptTokens: 10,
        completionTokens: 5,
        latencyMs: 100,
      });
      llm.extractJson.mockReturnValue({
        primaryIntent: IntentType.CHIT_CHAT,
        secondaryIntent: null,
        confidence: 0.8,
        entities: {},
        reasoning: 'greeting',
      });

      const result = await service.classify('namaste bhaiya kaise ho');
      expect(result.intent).toBe(IntentType.CHIT_CHAT);
      expect(result.tier).toBe(3);
      expect(llm.complete).toHaveBeenCalledTimes(1);
    });

    it('falls back to GENERAL_INQUIRY when the LLM result is invalid', async () => {
      llm.complete.mockResolvedValue({
        text: 'garbage',
        modelId: 'm',
        promptTokens: 1,
        completionTokens: 1,
        latencyMs: 1,
      });
      llm.extractJson.mockReturnValue(null);

      const result = await service.classify('completely novel unmatched phrase xyz');
      expect(result.intent).toBe(IntentType.GENERAL_INQUIRY);
      expect(result.confidence).toBe(0.5);
    });

    it('falls back to GENERAL_INQUIRY when the LLM throws', async () => {
      llm.complete.mockRejectedValue(new Error('LLM down'));
      const result = await service.classify('another unmatched phrase qwerty');
      expect(result.intent).toBe(IntentType.GENERAL_INQUIRY);
    });
  });
});
