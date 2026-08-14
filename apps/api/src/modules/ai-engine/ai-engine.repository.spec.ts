/**
 * AiEngineRepository unit tests.
 *
 * Every other spec in this module mocks the repository out, so its own logic
 * had never been executed. Two methods here are not thin Prisma wrappers and
 * carry real behaviour worth pinning:
 *
 *  - `getLoopCount` powers the loop hard-override, which forces confidence to 0
 *    when the AI has produced the same decision type repeatedly. It counts a
 *    *consecutive run at the head* of the stream, not a total — a run broken by
 *    a different decision must stop the count, or a conversation that looped an
 *    hour ago would keep tripping the override forever.
 *
 *  - `getRecentIntents` reads intents out of an untyped JSON column for the loop
 *    detector, so every malformed shape has to degrade to "no intent" rather
 *    than throwing inside the pipeline.
 *
 * The remaining methods are checked for the thing that must never regress: a
 * `business_id` in the WHERE clause of every single query.
 */
import { Test } from '@nestjs/testing';
import { AiDecisionOutcome, AiDecisionType, EmbeddingEntityType } from '@gosumo/database';
import { AiEngineRepository, type CreateDecisionData } from './ai-engine.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const CONVO = '00000000-0000-4000-a000-0000000000c1';

describe('AiEngineRepository', () => {
  let repository: AiEngineRepository;
  let prisma: {
    ai_decisions: { create: jest.Mock; findFirst: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    business_rules: { findMany: jest.Mock };
    businesses: { findFirst: jest.Mock };
    conversations: { findFirst: jest.Mock };
    messages: { findMany: jest.Mock };
    vector_embeddings_metadata: {
      create: jest.Mock;
      findFirst: jest.Mock;
      deleteMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      ai_decisions: {
        create: jest.fn().mockResolvedValue({ id: 'd1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      business_rules: { findMany: jest.fn().mockResolvedValue([]) },
      businesses: { findFirst: jest.fn().mockResolvedValue(null) },
      conversations: { findFirst: jest.fn().mockResolvedValue(null) },
      messages: { findMany: jest.fn().mockResolvedValue([]) },
      vector_embeddings_metadata: {
        create: jest.fn().mockResolvedValue({ id: 'e1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const module = await Test.createTestingModule({
      providers: [AiEngineRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(AiEngineRepository);
  });

  function baseDecision(): CreateDecisionData {
    return {
      business_id: BIZ,
      conversation_id: CONVO,
      type: AiDecisionType.SEND_MESSAGE,
      outcome: AiDecisionOutcome.AUTO_EXECUTED,
      proposed_action: { intent: 'PRICE_INQUIRY' },
      confidence_score: 95,
      confidence_breakdown: { dataAvailability: 1, policyClarity: 0.9 },
    };
  }

  describe('createDecision', () => {
    it('nulls every optional field the caller omitted', async () => {
      await repository.createDecision(baseDecision());

      expect(prisma.ai_decisions.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          message_id: null,
          task_id: null,
          model_id: null,
          prompt_tokens: null,
          completion_tokens: null,
          latency_ms: null,
          executed_at: null,
        }),
      });
    });

    it('stamps decided_at when the caller did not supply one', async () => {
      await repository.createDecision(baseDecision());

      const { decided_at } = prisma.ai_decisions.create.mock.calls[0][0].data;
      expect(decided_at).toBeInstanceOf(Date);
    });

    it('preserves every optional field the caller did supply', async () => {
      const decidedAt = new Date('2026-01-01T00:00:00.000Z');
      const executedAt = new Date('2026-01-01T00:00:01.000Z');

      await repository.createDecision({
        ...baseDecision(),
        message_id: 'm1',
        task_id: 't1',
        model_id: 'openai/gpt-oss-20b:free',
        prompt_tokens: 120,
        completion_tokens: 40,
        latency_ms: 830,
        decided_at: decidedAt,
        executed_at: executedAt,
      });

      expect(prisma.ai_decisions.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          message_id: 'm1',
          task_id: 't1',
          model_id: 'openai/gpt-oss-20b:free',
          prompt_tokens: 120,
          completion_tokens: 40,
          latency_ms: 830,
          decided_at: decidedAt,
          executed_at: executedAt,
        }),
      });
    });

    it('keeps a zero token count rather than nulling it', async () => {
      // 0 is falsy; `??` is required here so a genuinely free call is recorded
      // as 0 tokens instead of "unknown".
      await repository.createDecision({
        ...baseDecision(),
        prompt_tokens: 0,
        completion_tokens: 0,
        latency_ms: 0,
      });

      expect(prisma.ai_decisions.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          prompt_tokens: 0,
          completion_tokens: 0,
          latency_ms: 0,
        }),
      });
    });
  });

  describe('findDecisionsByConversation', () => {
    it('defaults to the first page of 20 when no options are passed', async () => {
      const result = await repository.findDecisionsByConversation(BIZ, CONVO);

      expect(prisma.ai_decisions.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 20 });
    });

    it('defaults each option independently', async () => {
      await repository.findDecisionsByConversation(BIZ, CONVO, { limit: 5 });
      expect(prisma.ai_decisions.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 5 }),
      );

      await repository.findDecisionsByConversation(BIZ, CONVO, { page: 3 });
      expect(prisma.ai_decisions.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 40, take: 20 }),
      );
    });

    it('computes the offset from page and limit together', async () => {
      await repository.findDecisionsByConversation(BIZ, CONVO, { page: 4, limit: 25 });

      expect(prisma.ai_decisions.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 75, take: 25 }),
      );
    });

    it('counts against the same tenant-scoped filter it lists with', async () => {
      prisma.ai_decisions.findMany.mockResolvedValue([{ id: 'd1' }]);
      prisma.ai_decisions.count.mockResolvedValue(1);

      const result = await repository.findDecisionsByConversation(BIZ, CONVO);

      const where = { business_id: BIZ, conversation_id: CONVO };
      expect(prisma.ai_decisions.findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
      expect(prisma.ai_decisions.count).toHaveBeenCalledWith({ where });
      expect(result.total).toBe(1);
    });
  });

  describe('getLoopCount', () => {
    /** The stream comes back newest-first, which is the order the loop walks. */
    function stream(...types: string[]) {
      prisma.ai_decisions.findMany.mockResolvedValue(types.map((type) => ({ type })));
    }

    it('is zero when the conversation has no decisions at all', async () => {
      stream();

      await expect(repository.getLoopCount(BIZ, CONVO, 'RESPONSE')).resolves.toBe(0);
    });

    it('is zero when the most recent decision is a different type', async () => {
      stream('ESCALATION', 'RESPONSE', 'RESPONSE');

      await expect(repository.getLoopCount(BIZ, CONVO, 'RESPONSE')).resolves.toBe(0);
    });

    it('counts an unbroken run at the head of the stream', async () => {
      stream('RESPONSE', 'RESPONSE', 'RESPONSE', 'ESCALATION');

      await expect(repository.getLoopCount(BIZ, CONVO, 'RESPONSE')).resolves.toBe(3);
    });

    it('stops at the first decision of a different type', async () => {
      // A loop that was broken and later resumed is not a live loop; counting
      // the whole history would keep the hard-override latched forever.
      stream('RESPONSE', 'ESCALATION', 'RESPONSE', 'RESPONSE', 'RESPONSE');

      await expect(repository.getLoopCount(BIZ, CONVO, 'RESPONSE')).resolves.toBe(1);
    });

    it('counts the whole window when every decision matches', async () => {
      stream('RESPONSE', 'RESPONSE', 'RESPONSE');

      await expect(repository.getLoopCount(BIZ, CONVO, 'RESPONSE')).resolves.toBe(3);
    });

    it('reads a bounded, tenant-scoped, newest-first window', async () => {
      stream();

      await repository.getLoopCount(BIZ, CONVO, 'RESPONSE');

      expect(prisma.ai_decisions.findMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, conversation_id: CONVO },
        orderBy: { decided_at: 'desc' },
        select: { type: true },
        take: 50,
      });
    });
  });

  describe('getRecentIntents', () => {
    function rows(...actions: unknown[]) {
      prisma.ai_decisions.findMany.mockResolvedValue(actions.map((a) => ({ proposed_action: a })));
    }

    it('returns intents oldest-first, reversing the newest-first query', async () => {
      // The loop detector reads this as a chronological sequence.
      rows({ intent: 'C' }, { intent: 'B' }, { intent: 'A' });

      await expect(repository.getRecentIntents(BIZ, CONVO, 3)).resolves.toEqual(['A', 'B', 'C']);
    });

    it('drops a row whose proposed_action is null', async () => {
      rows({ intent: 'A' }, null);

      await expect(repository.getRecentIntents(BIZ, CONVO, 5)).resolves.toEqual(['A']);
    });

    it('drops a row with no intent key', async () => {
      rows({ intent: 'A' }, { response: 'hello' });

      await expect(repository.getRecentIntents(BIZ, CONVO, 5)).resolves.toEqual(['A']);
    });

    it('drops a row whose intent is not a string', async () => {
      // The column is untyped JSON — a numeric or object intent must not reach
      // the detector as-is.
      rows({ intent: 42 }, { intent: { nested: true } }, { intent: 'A' });

      await expect(repository.getRecentIntents(BIZ, CONVO, 5)).resolves.toEqual(['A']);
    });

    it('returns an empty list when nothing in the window has a usable intent', async () => {
      rows(null, {}, { intent: null });

      await expect(repository.getRecentIntents(BIZ, CONVO, 5)).resolves.toEqual([]);
    });

    it('honours the caller-supplied window size', async () => {
      rows();

      await repository.getRecentIntents(BIZ, CONVO, 7);

      expect(prisma.ai_decisions.findMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, conversation_id: CONVO },
        orderBy: { decided_at: 'desc' },
        take: 7,
        select: { proposed_action: true },
      });
    });
  });

  describe('getBusinessAISettings', () => {
    it('returns null for a business that does not exist', async () => {
      prisma.businesses.findFirst.mockResolvedValue(null);

      await expect(repository.getBusinessAISettings(BIZ)).resolves.toBeNull();
    });

    it('returns the ai_settings payload for a business that does', async () => {
      prisma.businesses.findFirst.mockResolvedValue({
        ai_settings: { autoExecuteThreshold: 90, reviewThreshold: 70 },
      });

      await expect(repository.getBusinessAISettings(BIZ)).resolves.toEqual({
        autoExecuteThreshold: 90,
        reviewThreshold: 70,
      });
    });

    it('passes an unset ai_settings column straight through as null', async () => {
      prisma.businesses.findFirst.mockResolvedValue({ ai_settings: null });

      await expect(repository.getBusinessAISettings(BIZ)).resolves.toBeNull();
    });
  });

  describe('tenant scoping', () => {
    it('scopes findDecisionById', async () => {
      await repository.findDecisionById(BIZ, 'd1');

      expect(prisma.ai_decisions.findFirst).toHaveBeenCalledWith({
        where: { id: 'd1', business_id: BIZ },
      });
    });

    it('scopes findActiveBusinessRules and excludes inactive and deleted rules', async () => {
      await repository.findActiveBusinessRules(BIZ);

      expect(prisma.business_rules.findMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, is_active: true, deleted_at: null },
        orderBy: { priority: 'desc' },
      });
    });

    it('scopes getConversationWithClient and skips soft-deleted conversations', async () => {
      await repository.getConversationWithClient(BIZ, CONVO);

      expect(prisma.conversations.findFirst).toHaveBeenCalledWith({
        where: { id: CONVO, business_id: BIZ, deleted_at: null },
        include: { client: true },
      });
    });

    it('scopes getLastMessages and bounds the window', async () => {
      await repository.getLastMessages(BIZ, CONVO, 10);

      expect(prisma.messages.findMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, conversation_id: CONVO },
        orderBy: { created_at: 'desc' },
        take: 10,
      });
    });

    it('scopes the embedding-metadata read and delete', async () => {
      await repository.findEmbeddingMetadata(BIZ, 'entry-1');
      await repository.deleteEmbeddingMetadata(BIZ, 'entry-1');

      expect(prisma.vector_embeddings_metadata.findFirst).toHaveBeenCalledWith({
        where: { business_id: BIZ, entity_id: 'entry-1' },
      });
      expect(prisma.vector_embeddings_metadata.deleteMany).toHaveBeenCalledWith({
        where: { business_id: BIZ, entity_id: 'entry-1' },
      });
    });

    it('stamps embedded_at when recording embedding metadata', async () => {
      await repository.createEmbeddingMetadata({
        business_id: BIZ,
        entity_type: EmbeddingEntityType.FAQ,
        entity_id: 'entry-1',
        collection: 'kb',
        qdrant_point_id: 'p1',
        content_hash: 'h1',
        model_id: 'openai/gpt-oss-20b:free',
      });

      const { data } = prisma.vector_embeddings_metadata.create.mock.calls[0][0];
      expect(data.business_id).toBe(BIZ);
      expect(data.embedded_at).toBeInstanceOf(Date);
    });
  });
});
