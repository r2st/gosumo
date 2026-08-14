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
        modelId: 'openai/gpt-oss-20b:free',
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

  // ─────────────────────────────────────────────
  // What the classifier does with a model that answers *almost* correctly.
  //
  // The fallback path is already covered; these are the partial results — a
  // valid primary intent alongside a junk secondary, a missing `entities`, a
  // confidence that is not a number. Each one flows straight into the
  // confidence calculator and the action router, so a bad value here decides
  // whether a real customer message is auto-answered or escalated.
  // ─────────────────────────────────────────────

  describe('Tier-3 partial and malformed LLM results', () => {
    const llmReturns = (parsed: unknown): void => {
      llm.complete.mockResolvedValue({ text: '{}' } as never);
      llm.extractJson.mockReturnValue(parsed as never);
    };

    /** Nothing in INTENT_RULES matches this, so it always reaches the LLM. */
    const UNMATCHED = 'another unmatched phrase qwerty';

    it('keeps a secondary intent that is a real IntentType', async () => {
      llmReturns({
        primaryIntent: IntentType.BOOKING,
        secondaryIntent: IntentType.PRICING,
        confidence: 0.8,
        entities: { date: 'tomorrow' },
        reasoning: 'asked to book and priced it',
      });

      expect(await service.classify(UNMATCHED)).toMatchObject({
        intent: IntentType.BOOKING,
        secondaryIntent: IntentType.PRICING,
        confidence: 0.8,
        entities: { date: 'tomorrow' },
      });
    });

    it('drops a secondary intent the enum does not contain', async () => {
      llmReturns({
        primaryIntent: IntentType.BOOKING,
        secondaryIntent: 'VIBES',
        confidence: 0.8,
      });

      // A hallucinated intent must not reach downstream routing as if real.
      expect((await service.classify(UNMATCHED)).secondaryIntent).toBeNull();
    });

    it('substitutes defaults for a result missing entities and reasoning', async () => {
      llmReturns({ primaryIntent: IntentType.REFUND, confidence: 0.7 });

      const result = await service.classify(UNMATCHED);
      expect(result.entities).toEqual({});
      expect(result.reasoning).toBe('LLM classification');
    });

    it.each([
      ['a string', '0.9'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['undefined', undefined],
    ])('falls back to 0.5 when confidence is %s', async (_label, confidence) => {
      llmReturns({ primaryIntent: IntentType.PAYMENT, confidence });

      // 0.5 lands in the human-review band. Letting a non-number through would
      // reach the router as NaN and compare false against every threshold.
      expect((await service.classify(UNMATCHED)).confidence).toBe(0.5);
    });

    it.each([
      ['above 1', 4.2, 1],
      ['below 0', -3, 0],
    ])('clamps a confidence %s into range', async (_label, confidence, expected) => {
      llmReturns({ primaryIntent: IntentType.PAYMENT, confidence });

      expect((await service.classify(UNMATCHED)).confidence).toBe(expected);
    });

    it('falls back when the model rejects with a non-Error value', async () => {
      // Some transports reject with a plain string; the handler must not
      // assume `.message` exists while building its log line.
      llm.complete.mockRejectedValue('socket hang up');

      expect((await service.classify(UNMATCHED)).intent).toBe(
        IntentType.GENERAL_INQUIRY,
      );
    });
  });

  describe('classifyByRules', () => {
    it('returns null for empty text without consulting the rules', () => {
      expect(service.classifyByRules('')).toBeNull();
    });
  });
});
