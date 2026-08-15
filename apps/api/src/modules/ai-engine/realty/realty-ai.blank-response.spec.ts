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

/**
 * A model that returns `"response_text": ""` is not an exotic failure — it is
 * what one emits when it decides mid-generation that it should not answer.
 *
 * `""` is not nullish, so it survived
 * `grounded.responseText ?? nextQuestion ?? CONFIRMING_FALLBACK` untouched and
 * defeated the very fallback chain that exists to guarantee the buyer always
 * gets something back. Downstream in the bridge, the AUTO band then matched no
 * delivery branch at all — `routeMode === 'AUTO' && decision.responseText` is
 * false, and the DRAFT/GUIDED branch does not accept AUTO — so the turn ended
 * with no send, no draft queued for a human, and an "escalated" log line
 * carrying no reason. The buyer was left on read with nothing recording it.
 *
 * The whitespace variant was worse: `"   "` is truthy, so it was sent.
 */

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

describe('RealtyResponseParserService — a blank reply is nothing to say', () => {
  const llm = {
    extractJson: <T>(t: string): T | null => {
      try {
        return JSON.parse(t) as T;
      } catch {
        return null;
      }
    },
  } as unknown as LlmClientService;

  const parse = (responseText: unknown) =>
    new RealtyResponseParserService(llm).parse(
      JSON.stringify({
        response_text: responseText,
        confidence: 95,
        intent: 'AVAILABILITY',
        bltc_updates: {},
        actions: [],
        escalation_reason: null,
      }),
      RealtyIntent.GENERAL,
    );

  it.each([
    ['an empty string', ''],
    ['spaces', '   '],
    ['a newline and tabs', '\n\t\r '],
  ])('reports %s as nothing to say', (_label, value) => {
    expect(parse(value)!.responseText).toBeNull();
  });

  it.each([
    ['a missing field', undefined],
    ['an explicit null', null],
    ['a non-string', 42],
  ])('still reports %s as nothing to say', (_label, value) => {
    expect(parse(value)!.responseText).toBeNull();
  });

  it('leaves a real reply byte-for-byte alone, surrounding whitespace included', () => {
    expect(parse('  Green Vista has two 2BHKs left.  ')!.responseText).toBe(
      '  Green Vista has two 2BHKs left.  ',
    );
  });

  it('does not confuse a blank reply with an unparseable one', () => {
    // Both used to end at "escalate", but only one of them is a parse failure,
    // and the confidence/BLTC the model did return is still usable.
    const parsed = parse('');
    expect(parsed).not.toBeNull();
    expect(parsed!.confidence).toBe(95);
    expect(parsed!.intent).toBe('AVAILABILITY');
  });
});

describe('RealtyAiService — a blank reply falls through to the fallback chain', () => {
  let service: RealtyAiService;
  let llm: { complete: jest.Mock; extractJson: <T>(t: string) => T | null };
  let leads: { getLead: jest.Mock; applyBltcUpdate: jest.Mock };
  let audit: { record: jest.Mock };

  const reply = (responseText: unknown) => ({
    text: JSON.stringify({
      response_text: responseText,
      confidence: 95,
      intent: 'NEW_ENQUIRY',
      bltc_updates: {},
      stage_transition: null,
      actions: [],
      escalation_reason: null,
    }),
    modelId: 'openai/gpt-oss-120b:free',
    promptTokens: 100,
    completionTokens: 50,
    latencyMs: 200,
  });

  beforeEach(() => {
    const classifier = {
      classify: jest.fn().mockResolvedValue({
        intent: RealtyIntent.NEW_ENQUIRY,
        secondaryIntent: null,
        confidence: 0.9,
        tier: 1,
        policy: 'AUTO_ALLOWED',
        entities: {},
        reasoning: '',
      }),
    };
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
    const inventory = {
      matchForLead: jest.fn().mockResolvedValue([]),
      getProject: jest.fn(),
      listUnits: jest.fn(),
      listAssets: jest.fn().mockResolvedValue([]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };

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
      { emit: jest.fn() } as unknown as import('@nestjs/event-emitter').EventEmitter2,
    );
  });

  const turn = () =>
    service.processTurn('biz-1', { leadId: 'lead-1', messageText: 'hi, looking to buy' });

  it.each([
    ['an empty reply', ''],
    ['a whitespace-only reply', '   \n\t  '],
  ])('never proposes %s to the buyer', async (_label, value) => {
    llm.complete.mockResolvedValue(reply(value));

    const d = await turn();

    expect(d.responseText).toBeTruthy();
    expect(d.responseText!.trim()).not.toBe('');
  });

  it('records a sayable reply on the audit trail rather than a blank turn', async () => {
    llm.complete.mockResolvedValue(reply(''));

    await turn();

    const entry = audit.record.mock.calls[0]![0] as { responseText: string | null };
    expect(entry.responseText?.trim()).toBeTruthy();
  });

  it('leaves a real reply untouched', async () => {
    llm.complete.mockResolvedValue(reply('  Green Vista has two 2BHKs left.  '));

    expect((await turn()).responseText).toBe('  Green Vista has two 2BHKs left.  ');
  });
});
