import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConversationTagSource, MessageDirection } from '@gosumo/database';
import { ConversationTaggingService } from './conversation-tagging.service';
import type { ConversationTagRepository } from './conversation-tag.repository';
import type { ConversationRepository } from '../conversation.repository';
import type { MessageService } from '../../message/message.service';
import type { LlmClientService } from '../../ai-engine/pipeline/llm-client.service';
import {
  MAX_AI_TAGS_PER_CONVERSATION,
  MAX_TAGS_PER_CONVERSATION,
  MIN_TAG_CONFIDENCE,
  normalizeTag,
} from './conversation-tagging.constants';

const CONVERSATION = { id: 'conv-1', business_id: 'b1', tags: [] as string[] };

function makeHarness(
  opts: {
    llmTags?: Array<{ tag: string; confidence: number; rationale?: string }>;
    suppressed?: string[];
    vocabulary?: string[];
    existingTags?: string[];
    messages?: Array<{ direction: MessageDirection; text_content: string | null }>;
    llmThrows?: boolean;
    llmRaw?: string;
  } = {},
) {
  const activeTags: string[] = [...(opts.existingTags ?? [])];

  const tags = {
    findByConversation: jest.fn().mockResolvedValue([]),
    findSuppressedTags: jest.fn().mockResolvedValue(opts.suppressed ?? []),
    findTenantVocabulary: jest.fn().mockResolvedValue(opts.vocabulary ?? []),
    findActiveTags: jest.fn().mockImplementation(async () => [...activeTags]),
    upsert: jest.fn().mockImplementation(async (_b, _c, input) => {
      if (!activeTags.includes(input.tag)) activeTags.push(input.tag);
      return { tag: input.tag };
    }),
    suppress: jest.fn().mockImplementation(async (_b, _c, tag) => {
      const i = activeTags.indexOf(tag);
      if (i === -1) return false;
      activeTags.splice(i, 1);
      return true;
    }),
    statsByTag: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ConversationTagRepository>;

  const conversations = {
    findById: jest
      .fn()
      .mockImplementation(async () => ({ ...CONVERSATION, tags: [...activeTags] })),
    update: jest
      .fn()
      .mockImplementation(async (_b, _id, data) => ({ ...CONVERSATION, ...data })),
  } as unknown as jest.Mocked<ConversationRepository>;

  const messages = {
    getLastNMessages: jest.fn().mockResolvedValue(
      opts.messages ?? [
        { direction: MessageDirection.INBOUND, text_content: 'mera refund kab aayega?' },
        { direction: MessageDirection.OUTBOUND, text_content: 'checking for you' },
      ],
    ),
  } as unknown as jest.Mocked<MessageService>;

  const llm = {
    complete: opts.llmThrows
      ? jest.fn().mockRejectedValue(new Error('model unavailable'))
      : jest.fn().mockResolvedValue({
          text: opts.llmRaw ?? JSON.stringify({ tags: opts.llmTags ?? [] }),
          modelId: 'openai/gpt-oss-20b:free',
        }),
    extractJson: jest.fn().mockImplementation((text: string) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }),
  } as unknown as jest.Mocked<LlmClientService>;

  const eventEmitter = { emit: jest.fn() };

  const service = new ConversationTaggingService(
    tags,
    conversations,
    messages,
    llm,
    eventEmitter as never,
  );

  return { service, tags, conversations, messages, llm, eventEmitter, activeTags };
}

describe('normalizeTag', () => {
  it('collapses the spellings of one tag into a single stored form', () => {
    // Without this the unique index on (conversation_id, tag) happily holds all
    // three, and the filter that made tagging worth building splits three ways.
    expect(normalizeTag('Refund Request')).toBe('refund-request');
    expect(normalizeTag('refund_request')).toBe('refund-request');
    expect(normalizeTag('  REFUND---REQUEST  ')).toBe('refund-request');
  });

  it('strips characters that are not letters, digits or hyphens', () => {
    expect(normalizeTag('vip!! customer?')).toBe('vip-customer');
    expect(normalizeTag('#priority')).toBe('priority');
  });

  it('returns empty for input that normalizes to nothing', () => {
    expect(normalizeTag('!!!')).toBe('');
    expect(normalizeTag('   ')).toBe('');
  });

  it('caps at the column length', () => {
    expect(normalizeTag('a'.repeat(300))).toHaveLength(100);
  });
});

describe('ConversationTaggingService.autoTag', () => {
  it('applies a confident tag from the taxonomy', async () => {
    const { service, tags } = makeHarness({
      llmTags: [{ tag: 'refund-request', confidence: 0.95, rationale: 'asks for money back' }],
    });

    const result = await service.autoTag('b1', 'conv-1');

    expect(result.applied).toEqual(['refund-request']);
    expect(tags.upsert).toHaveBeenCalledWith(
      'b1',
      'conv-1',
      expect.objectContaining({ source: ConversationTagSource.AI, confidence: 0.95 }),
    );
  });

  it('never re-applies a tag a human removed', async () => {
    // The whole point of the tombstone. Without it, removing a wrong tag lasts
    // until the next inbound message re-runs the tagger.
    const { service, tags } = makeHarness({
      llmTags: [{ tag: 'churn-risk', confidence: 0.99 }],
      suppressed: ['churn-risk'],
    });

    const result = await service.autoTag('b1', 'conv-1');

    expect(result.applied).toEqual([]);
    expect(result.skippedSuppressed).toEqual(['churn-risk']);
    expect(tags.upsert).not.toHaveBeenCalled();
  });

  it('reports suppression even when the tag would also fail another check', async () => {
    const { service } = makeHarness({
      llmTags: [{ tag: 'churn-risk', confidence: 0.1 }],
      suppressed: ['churn-risk'],
    });

    const result = await service.autoTag('b1', 'conv-1');
    expect(result.skippedSuppressed).toEqual(['churn-risk']);
    expect(result.rejectedLowConfidence).toEqual([]);
  });

  it('discards a proposal below the confidence floor', async () => {
    const { service, tags } = makeHarness({
      llmTags: [{ tag: 'complaint', confidence: MIN_TAG_CONFIDENCE - 0.01 }],
    });

    const result = await service.autoTag('b1', 'conv-1');

    expect(result.rejectedLowConfidence).toEqual(['complaint']);
    expect(tags.upsert).not.toHaveBeenCalled();
  });

  it('accepts a proposal exactly at the floor', async () => {
    const { service } = makeHarness({
      llmTags: [{ tag: 'complaint', confidence: MIN_TAG_CONFIDENCE }],
    });
    expect((await service.autoTag('b1', 'conv-1')).applied).toEqual(['complaint']);
  });

  it('refuses a tag outside the allowed vocabulary', async () => {
    // An unconstrained tagger invents a new spelling every run.
    const { service, tags } = makeHarness({
      llmTags: [{ tag: 'made-up-topic', confidence: 0.99 }],
    });

    const result = await service.autoTag('b1', 'conv-1');

    expect(result.skippedUnknown).toEqual(['made-up-topic']);
    expect(tags.upsert).not.toHaveBeenCalled();
  });

  it('accepts a tag the tenant itself already uses', async () => {
    const { service } = makeHarness({
      llmTags: [{ tag: 'franchise-lead', confidence: 0.9 }],
      vocabulary: ['franchise-lead'],
    });

    expect((await service.autoTag('b1', 'conv-1')).applied).toEqual(['franchise-lead']);
  });

  it('normalizes what the model returns before matching it', async () => {
    const { service } = makeHarness({
      llmTags: [{ tag: 'Refund_Request', confidence: 0.9 }],
    });
    expect((await service.autoTag('b1', 'conv-1')).applied).toEqual(['refund-request']);
  });

  it('caps how many tags one pass may apply', async () => {
    const { service } = makeHarness({
      llmTags: [
        { tag: 'pricing', confidence: 0.9 },
        { tag: 'shipping', confidence: 0.9 },
        { tag: 'complaint', confidence: 0.9 },
        { tag: 'booking', confidence: 0.9 },
        { tag: 'payment-issue', confidence: 0.9 },
        { tag: 'cancellation', confidence: 0.9 },
        { tag: 'spam', confidence: 0.9 },
      ],
    });

    const result = await service.autoTag('b1', 'conv-1');
    expect(result.applied.length).toBeLessThanOrEqual(MAX_AI_TAGS_PER_CONVERSATION);
  });

  it('respects the per-conversation ceiling', async () => {
    const existing = Array.from({ length: MAX_TAGS_PER_CONVERSATION }, (_, i) => `t${i}`);
    const { service, tags } = makeHarness({
      llmTags: [{ tag: 'pricing', confidence: 0.99 }],
      existingTags: existing,
    });

    await service.autoTag('b1', 'conv-1');
    expect(tags.upsert).not.toHaveBeenCalled();
  });

  it('skips a tag the conversation already carries', async () => {
    const { service, tags } = makeHarness({
      llmTags: [{ tag: 'pricing', confidence: 0.99 }],
      existingTags: ['pricing'],
    });

    const result = await service.autoTag('b1', 'conv-1');
    expect(result.applied).toEqual([]);
    expect(tags.upsert).not.toHaveBeenCalled();
  });

  it('returns an empty result rather than throwing when the model is down', async () => {
    // Tagging is enrichment. An exception here would fail whatever inbound path
    // invoked it, which is a far worse outcome than an untagged conversation.
    const { service } = makeHarness({ llmThrows: true });

    const result = await service.autoTag('b1', 'conv-1');

    expect(result.applied).toEqual([]);
    expect(result.model).toBeNull();
  });

  it('survives an unparseable model response', async () => {
    const { service } = makeHarness({ llmRaw: 'I am not JSON' });
    await expect(service.autoTag('b1', 'conv-1')).resolves.toMatchObject({ applied: [] });
  });

  it('survives a response whose tags field is not an array', async () => {
    const { service } = makeHarness({ llmRaw: JSON.stringify({ tags: 'pricing' }) });
    await expect(service.autoTag('b1', 'conv-1')).resolves.toMatchObject({ applied: [] });
  });

  it('treats a non-numeric confidence as zero rather than trusting it', async () => {
    const { service } = makeHarness({
      llmRaw: JSON.stringify({ tags: [{ tag: 'pricing', confidence: 'very sure' }] }),
    });

    const result = await service.autoTag('b1', 'conv-1');
    expect(result.applied).toEqual([]);
    expect(result.rejectedLowConfidence).toEqual(['pricing']);
  });

  it('does nothing when the conversation has no readable messages', async () => {
    const { service, llm } = makeHarness({ messages: [] });

    const result = await service.autoTag('b1', 'conv-1');

    expect(result.applied).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('ignores messages with no text', async () => {
    const { service, llm } = makeHarness({
      messages: [
        { direction: MessageDirection.INBOUND, text_content: null },
        { direction: MessageDirection.INBOUND, text_content: '   ' },
      ],
    });

    await service.autoTag('b1', 'conv-1');
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('404s for a conversation outside the tenant', async () => {
    const { service, conversations } = makeHarness();
    conversations.findById.mockResolvedValue(null);

    await expect(service.autoTag('b1', 'conv-x')).rejects.toThrow(NotFoundException);
  });

  it('emits conversation.tagged only when something was applied', async () => {
    const quiet = makeHarness({ llmTags: [] });
    await quiet.service.autoTag('b1', 'conv-1');
    expect(quiet.eventEmitter.emit).not.toHaveBeenCalled();

    const loud = makeHarness({ llmTags: [{ tag: 'pricing', confidence: 0.9 }] });
    await loud.service.autoTag('b1', 'conv-1');
    expect(loud.eventEmitter.emit).toHaveBeenCalledWith(
      'conversation.tagged',
      expect.objectContaining({ source: ConversationTagSource.AI }),
    );
  });

  it('writes the array from the live rows, so the two cannot drift', async () => {
    const { service, conversations } = makeHarness({
      llmTags: [{ tag: 'pricing', confidence: 0.9 }],
    });

    await service.autoTag('b1', 'conv-1');

    expect(conversations.update).toHaveBeenCalledWith('b1', 'conv-1', {
      tags: ['pricing'],
    });
  });
});

describe('ConversationTaggingService manual overrides', () => {
  it('records a manual tag with MANUAL provenance and the actor', async () => {
    const { service, tags } = makeHarness();
    await service.addTags('b1', 'conv-1', ['VIP Customer'], 'tm-7');

    expect(tags.upsert).toHaveBeenCalledWith('b1', 'conv-1', {
      tag: 'vip-customer',
      source: ConversationTagSource.MANUAL,
      createdBy: 'tm-7',
    });
  });

  it('rejects a tag list that normalizes to nothing', async () => {
    const { service } = makeHarness();
    await expect(service.addTags('b1', 'conv-1', ['!!!', '  '])).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses to push a conversation past the tag ceiling', async () => {
    const existing = Array.from({ length: MAX_TAGS_PER_CONVERSATION }, (_, i) => `t${i}`);
    const { service } = makeHarness({ existingTags: existing });

    await expect(service.addTags('b1', 'conv-1', ['pricing'])).rejects.toThrow(
      BadRequestException,
    );
  });

  it('tombstones a removed tag instead of deleting it', async () => {
    const { service, tags } = makeHarness({ existingTags: ['pricing'] });
    await service.removeTag('b1', 'conv-1', 'pricing', 'tm-7');

    expect(tags.suppress).toHaveBeenCalledWith('b1', 'conv-1', 'pricing', 'tm-7');
  });

  it('is idempotent when removing a tag that is not there', async () => {
    const { service, eventEmitter } = makeHarness();

    await expect(service.removeTag('b1', 'conv-1', 'pricing')).resolves.toBeDefined();
    // Nothing changed, so nothing is announced.
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('rejects a removal whose tag normalizes to nothing', async () => {
    const { service } = makeHarness();
    await expect(service.removeTag('b1', 'conv-1', '###')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lets a person re-add a tag they previously removed', async () => {
    // The upsert clears the tombstone — a person overriding their own earlier
    // decision has to stick.
    const { service, tags } = makeHarness({ suppressed: ['churn-risk'] });
    await service.addTags('b1', 'conv-1', ['churn-risk'], 'tm-7');

    expect(tags.upsert).toHaveBeenCalledWith(
      'b1',
      'conv-1',
      expect.objectContaining({ tag: 'churn-risk', source: ConversationTagSource.MANUAL }),
    );
  });

  it('suppresses every tag a wholesale replace drops', async () => {
    const { service, tags } = makeHarness({ existingTags: ['pricing', 'shipping'] });
    await service.setTags('b1', 'conv-1', ['pricing', 'complaint'], 'tm-7');

    expect(tags.suppress).toHaveBeenCalledWith('b1', 'conv-1', 'shipping', 'tm-7');
    expect(tags.suppress).not.toHaveBeenCalledWith('b1', 'conv-1', 'pricing', 'tm-7');
    expect(tags.upsert).toHaveBeenCalledWith(
      'b1',
      'conv-1',
      expect.objectContaining({ tag: 'complaint' }),
    );
  });

  it('rejects a replace that exceeds the ceiling', async () => {
    const { service } = makeHarness();
    const tooMany = Array.from({ length: MAX_TAGS_PER_CONVERSATION + 1 }, (_, i) => `t${i}`);

    await expect(service.setTags('b1', 'conv-1', tooMany)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('deduplicates a replace list before applying it', async () => {
    const { service, tags } = makeHarness();
    await service.setTags('b1', 'conv-1', ['pricing', 'Pricing', 'PRICING']);

    const upserted = tags.upsert.mock.calls.map((c) => c[2].tag);
    expect(upserted).toEqual(['pricing']);
  });
});
