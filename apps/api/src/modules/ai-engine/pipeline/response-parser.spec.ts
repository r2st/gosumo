import { ConfigService } from '@nestjs/config';
import { IntentType } from '@gosumo/shared';
import { ResponseParserService } from './response-parser.service';
import { LlmClientService } from './llm-client.service';

function makeParser(): ResponseParserService {
  const config = { get: () => '' } as unknown as ConfigService;
  return new ResponseParserService(new LlmClientService(config));
}

describe('ResponseParserService', () => {
  let parser: ResponseParserService;

  beforeEach(() => {
    parser = makeParser();
  });

  describe('parse', () => {
    it('parses a well-formed response', () => {
      const raw = JSON.stringify({
        response_text: 'Aapka appointment confirm ho gaya!',
        intent: 'BOOKING',
        reasoning: 'slot available',
        suggested_actions: [{ type: 'CREATE_BOOKING', parameters: { slot: '3pm' }, confidence: 0.9 }],
        profile_updates: { lastBooking: '2026-06-26' },
        requires_escalation: false,
        jailbreak_detected: false,
        pii_detected: false,
        language_used: 'hi',
      });
      const parsed = parser.parse(raw, IntentType.GENERAL_INQUIRY);
      expect(parsed).not.toBeNull();
      expect(parsed!.intent).toBe(IntentType.BOOKING);
      expect(parsed!.responseText).toBe('Aapka appointment confirm ho gaya!');
      expect(parsed!.suggestedActions).toHaveLength(1);
      expect(parsed!.suggestedActions[0]!.type).toBe('CREATE_BOOKING');
    });

    it('extracts JSON wrapped in markdown fences and prose', () => {
      const raw = 'Sure! Here is the JSON:\n```json\n{"response_text":"hi","intent":"CHIT_CHAT","requires_escalation":false}\n```\nDone.';
      const parsed = parser.parse(raw, IntentType.GENERAL_INQUIRY);
      expect(parsed).not.toBeNull();
      expect(parsed!.intent).toBe(IntentType.CHIT_CHAT);
    });

    it('returns null when no JSON object is present', () => {
      expect(parser.parse('no json here at all', IntentType.GENERAL_INQUIRY)).toBeNull();
    });

    it('falls back to the provided intent when the model intent is invalid', () => {
      const parsed = parser.parse('{"response_text":"x","intent":"NONSENSE","requires_escalation":false}', IntentType.REFUND);
      expect(parsed!.intent).toBe(IntentType.REFUND);
    });

    it('drops malformed suggested actions', () => {
      const parsed = parser.parse(
        '{"response_text":"x","intent":"ORDER","requires_escalation":false,"suggested_actions":[{"parameters":{}},{"type":"CREATE_ORDER","confidence":2}]}',
        IntentType.ORDER,
      );
      expect(parsed!.suggestedActions).toHaveLength(1);
      expect(parsed!.suggestedActions[0]!.confidence).toBe(1); // clamped
    });
  });

  describe('validate', () => {
    const base = {
      responseText: 'hello',
      intent: IntentType.GENERAL_INQUIRY,
      reasoning: 'r',
      suggestedActions: [],
      profileUpdates: {},
      requiresEscalation: false,
      escalationReason: null,
      urgency: null,
      holdingMessage: null,
      jailbreakDetected: false,
      piiDetected: false,
      languageUsed: 'en',
    };

    it('passes a normal response', () => {
      expect(parser.validate({ ...base }).valid).toBe(true);
    });

    it('fails when a non-escalation response has empty text', () => {
      const result = parser.validate({ ...base, responseText: '' });
      expect(result.valid).toBe(false);
      expect(result.failures.join(' ')).toContain('empty response_text');
    });

    it('fails when the model self-reports a jailbreak', () => {
      expect(parser.validate({ ...base, jailbreakDetected: true }).valid).toBe(false);
    });

    it('fails when the model self-reports PII', () => {
      expect(parser.validate({ ...base, piiDetected: true }).valid).toBe(false);
    });

    it('fails when response text exceeds the channel limit', () => {
      expect(parser.validate({ ...base, responseText: 'x'.repeat(5000) }).valid).toBe(false);
    });
  });
});
