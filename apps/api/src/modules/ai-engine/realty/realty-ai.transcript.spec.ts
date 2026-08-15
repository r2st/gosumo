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
import { ContextLoaderService, TranscriptEntry } from '../pipeline/context-loader.service';
import { RealtyLeadsService } from '../../realty-leads/realty-leads.service';
import { RealtyInventoryService } from '../../realty-inventory/realty-inventory.service';
import { RealtyIntelligenceService } from '../../realty-intelligence/realty-intelligence.service';
import { ComplianceNoticeService } from '../../compliance/compliance-notice.service';

/**
 * The grounded prompt reserves a `<conversation_history>` block and
 * `renderTranscript` renders up to 15 turns into it — but the loop passed a
 * hardcoded `[]`, so every turn of every conversation was prompted with "No
 * prior messages in this conversation." The model could not resolve a reference
 * back to anything already said, and re-opened ground the buyer had covered.
 */

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
    languagePref: null,
    bltc: profile(),
    ...over,
  } as unknown as Awaited<ReturnType<RealtyLeadsService['getLead']>>;
}

describe('RealtyAiService — conversation history in the grounded prompt', () => {
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
  let context: { loadTranscript: jest.Mock };

  const completionOf = (obj: unknown) => ({
    text: JSON.stringify(obj),
    modelId: 'openai/gpt-oss-120b:free',
    promptTokens: 100,
    completionTokens: 50,
    latencyMs: 200,
  });

  /** The system prompt the LLM was actually called with. */
  const systemPrompt = (): string => llm.complete.mock.calls[0]![0].system as string;

  /** Whatever the model returns, wrapped in the strict JSON contract. */
  const reply = (responseText: unknown) =>
    completionOf({
      response_text: responseText,
      confidence: 95,
      intent: 'NEW_ENQUIRY',
      bltc_updates: {},
      stage_transition: null,
      actions: [],
      escalation_reason: null,
    });

  beforeEach(() => {
    classifier = { classify: jest.fn() };
    classifier.classify.mockResolvedValue({
      intent: RealtyIntent.NEW_ENQUIRY,
      secondaryIntent: null,
      confidence: 0.9,
      tier: 1,
      policy: 'AUTO_ALLOWED',
      entities: {},
      reasoning: '',
    });

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
      getLead: jest.fn().mockResolvedValue(leadDto()),
      applyBltcUpdate: jest
        .fn()
        .mockResolvedValue({ lead: { bltc: profile() }, contradictions: [] }),
    };
    inventory = {
      matchForLead: jest.fn().mockResolvedValue([]),
      getProject: jest.fn(),
      listUnits: jest.fn(),
      listAssets: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };
    context = { loadTranscript: jest.fn().mockResolvedValue([] as TranscriptEntry[]) };

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
      undefined as unknown as RealtyIntelligenceService,
      undefined as unknown as ComplianceNoticeService,
      context as unknown as ContextLoaderService,
    );
  });

  it('renders the prior turns into the prompt instead of "No prior messages"', async () => {
    context.loadTranscript.mockResolvedValue([
      { direction: 'INBOUND', text: 'Looking for a 2BHK in Wakad' },
      { direction: 'OUTBOUND', text: 'Green Vista and Sun Orchid both fit that.' },
    ] satisfies TranscriptEntry[]);
    llm.complete.mockResolvedValue(reply('Sun Orchid it is — shall I book a visit?'));

    await service.processTurn('biz-1', {
      leadId: 'lead-1',
      messageText: "the second one's fine",
      conversationId: 'conv-1',
    });

    const prompt = systemPrompt();
    expect(prompt).toContain('[Buyer] Looking for a 2BHK in Wakad');
    expect(prompt).toContain('[Agent] Green Vista and Sun Orchid both fit that.');
    expect(prompt).not.toContain('No prior messages in this conversation.');
  });

  it('scopes the transcript read to the tenant and the lead conversation', async () => {
    llm.complete.mockResolvedValue(reply('Sure.'));

    await service.processTurn('biz-1', {
      leadId: 'lead-1',
      messageText: 'hi',
      conversationId: 'conv-1',
    });

    expect(context.loadTranscript).toHaveBeenCalledWith('biz-1', 'conv-1', expect.any(Number));
  });

  it('drops the trailing echo of the message currently being answered', async () => {
    context.loadTranscript.mockResolvedValue([
      { direction: 'OUTBOUND', text: 'What is your budget?' },
      { direction: 'INBOUND', text: 'around 80 lakh' },
    ] satisfies TranscriptEntry[]);
    llm.complete.mockResolvedValue(reply('Noted — 80 lakh.'));

    await service.processTurn('biz-1', {
      leadId: 'lead-1',
      messageText: '  around 80 lakh  ',
      conversationId: 'conv-1',
    });

    const prompt = systemPrompt();
    expect(prompt).toContain('[Agent] What is your budget?');
    // Present once as the message under answer, never as history.
    expect(prompt).not.toContain('[Buyer] around 80 lakh');
  });

  it('keeps a genuine earlier buyer turn that only resembles the current one', async () => {
    context.loadTranscript.mockResolvedValue([
      { direction: 'INBOUND', text: 'any update?' },
      { direction: 'OUTBOUND', text: 'Checking with the developer now.' },
    ] satisfies TranscriptEntry[]);
    llm.complete.mockResolvedValue(reply('Still confirming.'));

    await service.processTurn('biz-1', {
      leadId: 'lead-1',
      messageText: 'any update?',
      conversationId: 'conv-1',
    });

    // The echo rule only fires on the *last* entry; this one is followed by a
    // reply, so it is real history.
    expect(systemPrompt()).toContain('[Buyer] any update?');
  });

  it('caps the window at 15 turns even when more are returned', async () => {
    const entries: TranscriptEntry[] = Array.from({ length: 30 }, (_, i) => ({
      direction: i % 2 === 0 ? 'INBOUND' : 'OUTBOUND',
      text: `turn-${i}`,
    }));
    context.loadTranscript.mockResolvedValue(entries);
    llm.complete.mockResolvedValue(reply('ok'));

    await service.processTurn('biz-1', {
      leadId: 'lead-1',
      messageText: 'ok?',
      conversationId: 'conv-1',
    });

    const prompt = systemPrompt();
    expect(prompt).toContain('turn-29');
    expect(prompt).toContain('turn-15');
    expect(prompt).not.toContain('turn-14');
  });

  it('reads no transcript when the turn carries no conversation', async () => {
    llm.complete.mockResolvedValue(reply('Hello!'));

    await service.processTurn('biz-1', { leadId: 'lead-1', messageText: 'hi' });

    expect(context.loadTranscript).not.toHaveBeenCalled();
    expect(systemPrompt()).toContain('No prior messages in this conversation.');
  });

  it('still answers the buyer when the transcript read fails', async () => {
    context.loadTranscript.mockRejectedValue(new Error('db down'));
    llm.complete.mockResolvedValue(reply('Hello!'));

    const d = await service.processTurn('biz-1', {
      leadId: 'lead-1',
      messageText: 'hi',
      conversationId: 'conv-1',
    });

    expect(d.responseText).toBe('Hello!');
    expect(systemPrompt()).toContain('No prior messages in this conversation.');
  });

  it('still qualifies a lead normally with history present', async () => {
    context.loadTranscript.mockResolvedValue([
      { direction: 'OUTBOUND', text: 'Which locality?' },
    ] satisfies TranscriptEntry[]);
    leads.applyBltcUpdate.mockResolvedValue({
      lead: { bltc: profile({ budgetMaxPaise: 80 * LAKH, localities: ['Wakad'], config: '2BHK' }) },
      contradictions: [],
    });
    llm.complete.mockResolvedValue(reply('Wakad, noted.'));

    const d = await service.processTurn('biz-1', {
      leadId: 'lead-1',
      messageText: 'Wakad, 80 lakh, 2BHK, buying in 3 months',
      conversationId: 'conv-1',
    });

    expect(d.guardViolations).toHaveLength(0);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(d.bltc.budgetMaxPaise).toBe(80 * LAKH);
    expect(d.bltc.localities).toContain('Wakad');
  });
});

/**
 * The loader is an `@Optional()` dependency, which means a wiring mistake
 * degrades silently to the exact bug above — every turn prompted with no
 * history and nothing failing. These two assertions are what makes that loud.
 */
describe('RealtyAiModule — transcript wiring', () => {
  it('declares the transcript loader as a constructor dependency', () => {
    const params = Reflect.getMetadata('design:paramtypes', RealtyAiService) as unknown[];
    expect(params).toContain(ContextLoaderService);
  });

  it('provides the transcript loader so Nest can satisfy it', async () => {
    const { RealtyAiModule } = await import('./realty-ai.module');
    const providers = Reflect.getMetadata('providers', RealtyAiModule) as unknown[];
    expect(providers).toContain(ContextLoaderService);
  });
});
