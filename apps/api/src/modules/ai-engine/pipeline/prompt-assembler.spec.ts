import { IntentType, MessageDirection } from '@gosumo/shared';
import { PromptAssemblerService } from './prompt-assembler.service';
import { EnrichedContext } from './context-loader.service';
import { MAX_HISTORY_MESSAGE_CHARS } from '../ai-engine.constants';

function baseContext(overrides: Partial<EnrichedContext> = {}): EnrichedContext {
  return {
    conversation: null,
    triggerMessage: null,
    history: [],
    business: null,
    client: null,
    businessRules: [],
    messageText: '',
    channel: null,
    channelAccountId: null,
    recipientExternalId: null,
    ...overrides,
  };
}

function historyMessage(overrides: Record<string, unknown> = {}) {
  return {
    direction: MessageDirection.INBOUND,
    text_content: 'hi',
    content: null,
    ...overrides,
  } as never;
}

describe('PromptAssemblerService', () => {
  let service: PromptAssemblerService;

  beforeEach(() => {
    service = new PromptAssemblerService();
  });

  describe('conversation history truncation', () => {
    it('leaves short messages untouched', () => {
      const context = baseContext({
        history: [historyMessage({ text_content: 'When will my order arrive?' })],
      });

      const prompt = service.assembleSystemPrompt(context, IntentType.ORDER_TRACKING, '', 'en');

      expect(prompt).toContain('[Customer] When will my order arrive?');
    });

    it('truncates a single oversized message so it cannot dominate the prompt', () => {
      const hugeText = 'x'.repeat(MAX_HISTORY_MESSAGE_CHARS + 5000);
      const context = baseContext({
        history: [historyMessage({ text_content: hugeText })],
      });

      const prompt = service.assembleSystemPrompt(context, IntentType.GENERAL_INQUIRY, '', 'en');

      expect(prompt).toContain(`[truncated, ${hugeText.length} chars total]`);
      expect(prompt).not.toContain(hugeText);
      // The kept prefix should be present, capped at MAX_HISTORY_MESSAGE_CHARS.
      expect(prompt).toContain('x'.repeat(MAX_HISTORY_MESSAGE_CHARS));
      expect(prompt).not.toContain('x'.repeat(MAX_HISTORY_MESSAGE_CHARS + 1));
    });

    it('caps every message independently across a long history', () => {
      const hugeA = 'a'.repeat(MAX_HISTORY_MESSAGE_CHARS + 100);
      const hugeB = 'b'.repeat(MAX_HISTORY_MESSAGE_CHARS + 100);
      const context = baseContext({
        history: [
          historyMessage({ text_content: hugeA, direction: MessageDirection.INBOUND }),
          historyMessage({ text_content: hugeB, direction: MessageDirection.OUTBOUND }),
        ],
      });

      const prompt = service.assembleSystemPrompt(context, IntentType.GENERAL_INQUIRY, '', 'en');

      expect(prompt).not.toContain(hugeA);
      expect(prompt).not.toContain(hugeB);
      expect(prompt).toContain('[Customer]');
      expect(prompt).toContain('[Agent]');
    });

    it('reports "no prior messages" for an empty history', () => {
      const prompt = service.assembleSystemPrompt(baseContext(), IntentType.CHIT_CHAT, '', 'en');

      expect(prompt).toContain('No prior messages in this conversation.');
    });
  });

  describe('client profile section', () => {
    it('treats a missing client as a new contact', () => {
      const prompt = service.assembleSystemPrompt(baseContext(), IntentType.GENERAL_INQUIRY, '', 'en');

      expect(prompt).toContain('NEW contact with no prior history');
    });
  });

  describe('serializePolicies', () => {
    it('caps the serialized policy block at 5 rules', () => {
      const rules = Array.from({ length: 8 }, (_, i) => ({
        type: 'RULE',
        name: `Rule ${i}`,
        description: null,
        embedding_text: null,
      })) as never;

      const serialized = service.serializePolicies(rules);

      expect(serialized.split('\n')).toHaveLength(5);
    });

    it('falls back to a default message with no active rules', () => {
      expect(service.serializePolicies([])).toContain('No explicit policies configured');
    });
  });
});
