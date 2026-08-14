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

    /**
     * Model output is the least trustworthy input in the pipeline: every field
     * is whatever the model felt like emitting, and a wrong *type* is the
     * failure mode that slips through, because it survives JSON.parse and only
     * breaks somewhere further downstream. Each field degrades to its typed
     * default rather than propagating.
     */
    describe('type coercion of hostile field values', () => {
      const parseWith = (fields: Record<string, unknown>) =>
        parser.parse(
          JSON.stringify({ response_text: 'x', requires_escalation: false, ...fields }),
          IntentType.GENERAL_INQUIRY,
        )!;

      it('nulls a non-string response_text', () => {
        expect(parseWith({ response_text: 42 }).responseText).toBeNull();
        expect(parseWith({ response_text: null }).responseText).toBeNull();
      });

      it('empties a non-string reasoning', () => {
        expect(parseWith({ reasoning: { why: 'because' } }).reasoning).toBe('');
      });

      it('nulls a non-string escalation_reason and holding_message', () => {
        const parsed = parseWith({ escalation_reason: 7, holding_message: false });
        expect(parsed.escalationReason).toBeNull();
        expect(parsed.holdingMessage).toBeNull();
      });

      it('defaults a non-string language_used to en', () => {
        expect(parseWith({ language_used: ['hi'] }).languageUsed).toBe('en');
      });

      /** Only a literal `true` escalates — a truthy string must not. */
      it.each([['yes'], [1], [{}]])(
        'treats a truthy non-boolean %j as not escalating',
        (value) => {
          expect(parseWith({ requires_escalation: value }).requiresEscalation).toBe(false);
        },
      );

      it('treats truthy non-boolean safety flags as not set', () => {
        const parsed = parseWith({ jailbreak_detected: 'true', pii_detected: 1 });
        expect(parsed.jailbreakDetected).toBe(false);
        expect(parsed.piiDetected).toBe(false);
      });

      it('accepts each valid urgency and rejects anything else', () => {
        for (const u of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
          expect(parseWith({ urgency: u }).urgency).toBe(u);
        }
        expect(parseWith({ urgency: 'EXTREME' }).urgency).toBeNull();
        expect(parseWith({ urgency: 3 }).urgency).toBeNull();
        expect(parseWith({}).urgency).toBeNull();
      });

      /** An array is an object to `typeof`, which is exactly the trap here. */
      it.each([[['a']], [null], ['nope'], [5]])(
        'replaces a non-plain-object profile_updates %j with an empty object',
        (value) => {
          expect(parseWith({ profile_updates: value }).profileUpdates).toEqual({});
        },
      );

      it('keeps a genuine profile_updates object', () => {
        expect(parseWith({ profile_updates: { tier: 'gold' } }).profileUpdates).toEqual({
          tier: 'gold',
        });
      });

      it('empties suggested_actions that is not an array', () => {
        expect(parseWith({ suggested_actions: { type: 'X' } }).suggestedActions).toEqual([]);
      });

      it('survives a null entry inside suggested_actions', () => {
        const parsed = parseWith({ suggested_actions: [null, { type: 'SEND_LINK' }] });
        expect(parsed.suggestedActions).toHaveLength(1);
        expect(parsed.suggestedActions[0]!.type).toBe('SEND_LINK');
      });

      it('defaults an action confidence that is not a number, and clamps a negative one', () => {
        const parsed = parseWith({
          suggested_actions: [
            { type: 'A', confidence: 'high' },
            { type: 'B', confidence: -3 },
          ],
        });
        expect(parsed.suggestedActions[0]!.confidence).toBe(0.5);
        expect(parsed.suggestedActions[1]!.confidence).toBe(0);
      });

      it('replaces non-object action parameters with an empty object', () => {
        const parsed = parseWith({ suggested_actions: [{ type: 'A', parameters: ['x'] }] });
        expect(parsed.suggestedActions[0]!.parameters).toEqual({});
      });
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

    /** Escalating is fine; escalating with nothing to say to the customer is not. */
    it('fails an escalation carrying neither a holding message nor response text', () => {
      const result = parser.validate({
        ...base,
        requiresEscalation: true,
        responseText: null,
        holdingMessage: null,
      });
      expect(result.valid).toBe(false);
      expect(result.failures.join(' ')).toContain('neither a holding message nor response_text');
    });

    it('passes an escalation that carries only a holding message', () => {
      expect(
        parser.validate({
          ...base,
          requiresEscalation: true,
          responseText: null,
          holdingMessage: 'Ek minute, main check karta hoon.',
        }).valid,
      ).toBe(true);
    });

    it('passes an escalation that carries only response text', () => {
      expect(
        parser.validate({ ...base, requiresEscalation: true, holdingMessage: null }).valid,
      ).toBe(true);
    });

    /** Whitespace is not something to say. */
    it('fails a non-escalation response whose text is only whitespace', () => {
      expect(parser.validate({ ...base, responseText: '   ' }).valid).toBe(false);
    });

    it('fails when a suggested action is missing its type', () => {
      const result = parser.validate({
        ...base,
        suggestedActions: [{ type: '', parameters: {}, confidence: 0.5 }],
      });
      expect(result.valid).toBe(false);
      expect(result.failures.join(' ')).toContain('missing its type');
    });

    it('reports each independent failure at once', () => {
      const result = parser.validate({
        ...base,
        responseText: '',
        jailbreakDetected: true,
        piiDetected: true,
      });
      expect(result.failures).toHaveLength(3);
    });

    it('passes when every suggested action has a type', () => {
      expect(
        parser.validate({
          ...base,
          suggestedActions: [{ type: 'CREATE_BOOKING', parameters: {}, confidence: 0.9 }],
        }).valid,
      ).toBe(true);
    });
  });
});
