/**
 * KnowledgeService unit tests.
 *
 * The management half is ordinary CRUD; the parts worth asserting are the ones
 * whose failure is invisible:
 *
 *  - **Slug allocation** must consider soft-deleted rows. The unique index does
 *    not exclude them, so choosing a suffix from the live rows alone produces a
 *    value a deleted row already holds and the create fails a P2002.
 *  - **`published_at`** records when an article *first* went live. Re-publishing
 *    something archived must not reset it, or every un-archive silently makes
 *    the article look newly written.
 *  - **`retrieveForAi`** is on the message hot path and is the one caller that
 *    must never throw. A knowledge base that cannot be read has to degrade to
 *    an ungrounded answer — the same contract the vector retriever already
 *    honours — rather than drop the customer's turn.
 *  - **The score floor** exists because the prompt presents whatever comes back
 *    as the business's own policy. A weak match is worse than no match: it
 *    makes the model answer confidently off the wrong document.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { KnowledgeArticleStatus } from '@gosumo/database';
import { IntentType } from '@gosumo/shared';

import { KnowledgeService } from './knowledge.service';
import { KnowledgeRepository } from './knowledge.repository';
import { AI_ARTICLE_SCORE_FLOOR, ARTICLE_EXCERPT_LENGTH } from './knowledge.constants';

const BIZ = '00000000-0000-4000-a000-000000000001';
const ID = '00000000-0000-4000-b000-000000000001';
const USER = '00000000-0000-4000-c000-000000000001';

type Article = Record<string, unknown>;

function article(overrides: Article = {}): Article {
  return {
    id: ID,
    business_id: BIZ,
    title: 'Refund policy',
    slug: 'refund-policy',
    summary: 'Refunds within 7 days.',
    body: 'The full refund policy text.',
    category: 'Payments',
    tags: [],
    keywords: [],
    applicable_intents: [],
    status: KnowledgeArticleStatus.DRAFT,
    ai_enabled: true,
    use_count: 0,
    published_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('KnowledgeService', () => {
  let service: KnowledgeService;
  let repository: {
    create: jest.Mock;
    findMany: jest.Mock;
    findById: jest.Mock;
    findBySlug: jest.Mock;
    findTakenSlugs: jest.Mock;
    update: jest.Mock;
    softDelete: jest.Mock;
    incrementUseCounts: jest.Mock;
    search: jest.Mock;
    countByStatus: jest.Mock;
    countAiEnabled: jest.Mock;
    sumUseCounts: jest.Mock;
    listCategories: jest.Mock;
  };

  beforeEach(async () => {
    repository = {
      create: jest.fn().mockImplementation((_biz, data) => article(data as Article)),
      findMany: jest
        .fn()
        .mockResolvedValue({ data: [], total: 0, page: 1, limit: 20, totalPages: 1 }),
      findById: jest.fn().mockResolvedValue(article()),
      findBySlug: jest.fn().mockResolvedValue(null),
      findTakenSlugs: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation((_biz, _id, data) => article(data as Article)),
      softDelete: jest.fn().mockResolvedValue(undefined),
      incrementUseCounts: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue([]),
      countByStatus: jest.fn().mockResolvedValue([]),
      countAiEnabled: jest.fn().mockResolvedValue(0),
      sumUseCounts: jest.fn().mockResolvedValue(0),
      listCategories: jest.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [KnowledgeService, { provide: KnowledgeRepository, useValue: repository }],
    }).compile();

    service = module.get(KnowledgeService);
  });

  // ─────────────────────────────────────────────
  // Slug allocation
  // ─────────────────────────────────────────────

  describe('slug allocation', () => {
    it('derives the slug from the title when it is free', async () => {
      await service.create(BIZ, { title: 'Refund Policy', body: 'text' }, USER);

      expect(repository.create).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ slug: 'refund-policy' }),
      );
    });

    it('suffixes when a live article already holds the slug', async () => {
      repository.findTakenSlugs.mockResolvedValue(['refund-policy']);

      await service.create(BIZ, { title: 'Refund Policy', body: 'text' }, USER);

      expect(repository.create).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ slug: 'refund-policy-2' }),
      );
    });

    it('skips a slug held only by a soft-deleted article', async () => {
      // The unique index spans deleted rows, so `findTakenSlugs` returns them
      // and the suffix has to step past.
      repository.findTakenSlugs.mockResolvedValue(['refund-policy', 'refund-policy-2']);

      await service.create(BIZ, { title: 'Refund Policy', body: 'text' }, USER);

      expect(repository.create).toHaveBeenCalledWith(
        BIZ,
        expect.objectContaining({ slug: 'refund-policy-3' }),
      );
    });

    it('reports a conflict rather than looping once the suffix range is exhausted', async () => {
      const taken = ['refund-policy'];
      for (let i = 2; i <= 100; i += 1) taken.push(`refund-policy-${i}`);
      repository.findTakenSlugs.mockResolvedValue(taken);

      await expect(
        service.create(BIZ, { title: 'Refund Policy', body: 'text' }, USER),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('uses the fallback for a title that transliterates to nothing', async () => {
      await service.create(BIZ, { title: 'वापसी नीति', body: 'text' }, USER);

      const slug = repository.create.mock.calls[0][1].slug as string;
      expect(slug.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────
  // Publication lifecycle
  // ─────────────────────────────────────────────

  describe('published_at', () => {
    it('stamps it when an article is created already published', async () => {
      await service.create(
        BIZ,
        { title: 'A', body: 'b', status: KnowledgeArticleStatus.PUBLISHED },
        USER,
      );

      expect(repository.create.mock.calls[0][1].publishedAt).toBeInstanceOf(Date);
    });

    it('leaves it null for a draft', async () => {
      await service.create(BIZ, { title: 'A', body: 'b' }, USER);

      expect(repository.create.mock.calls[0][1].publishedAt).toBeNull();
    });

    it('stamps it on the first publish', async () => {
      repository.findById.mockResolvedValue(article({ published_at: null }));

      await service.publish(BIZ, ID, USER);

      expect(repository.update.mock.calls[0][2].publishedAt).toBeInstanceOf(Date);
    });

    it('preserves the original date when an archived article is re-published', async () => {
      const first = new Date('2026-01-01T00:00:00Z');
      repository.findById.mockResolvedValue(
        article({ published_at: first, status: KnowledgeArticleStatus.ARCHIVED }),
      );

      await service.publish(BIZ, ID, USER);

      // `undefined` is "leave the column alone" — not a null that would erase it.
      expect(repository.update.mock.calls[0][2]).not.toHaveProperty('publishedAt');
    });

    it('does not touch it when archiving', async () => {
      repository.findById.mockResolvedValue(
        article({ published_at: new Date(), status: KnowledgeArticleStatus.PUBLISHED }),
      );

      await service.archive(BIZ, ID, USER);

      expect(repository.update.mock.calls[0][2]).not.toHaveProperty('publishedAt');
    });
  });

  describe('update', () => {
    it('never re-derives the slug from a changed title', async () => {
      await service.update(BIZ, ID, { title: 'Refunds and returns' }, USER);

      expect(repository.update.mock.calls[0][2]).not.toHaveProperty('slug');
    });

    it('404s on an article this tenant does not have', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.update(BIZ, ID, { title: 'x' }, USER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('404s before soft-deleting an article that is not there', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(service.remove(BIZ, ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.softDelete).not.toHaveBeenCalled();
    });

    it('soft-deletes an existing article', async () => {
      await service.remove(BIZ, ID);

      expect(repository.softDelete).toHaveBeenCalledWith(BIZ, ID);
    });
  });

  describe('getBySlug', () => {
    it('404s when the slug is unknown', async () => {
      await expect(service.getBySlug(BIZ, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────
  // AI retrieval
  // ─────────────────────────────────────────────

  describe('retrieveForAi', () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: ID,
      title: 'Refund policy',
      slug: 'refund-policy',
      summary: 'Refunds within 7 days.',
      body: 'long body',
      category: null,
      applicable_intents: [],
      score: 1,
      ...overrides,
    });

    it('restricts the query to published, AI-enabled articles', async () => {
      await service.retrieveForAi(BIZ, 'can I get a refund', IntentType.GENERAL_INQUIRY);

      expect(repository.search).toHaveBeenCalledWith(
        BIZ,
        'can I get a refund',
        expect.objectContaining({ aiOnly: true, intent: IntentType.GENERAL_INQUIRY }),
      );
    });

    it('returns the summary as the grounding excerpt', async () => {
      repository.search.mockResolvedValue([row()]);

      const hits = await service.retrieveForAi(BIZ, 'refund', IntentType.GENERAL_INQUIRY);

      expect(hits).toEqual([
        { id: ID, title: 'Refund policy', excerpt: 'Refunds within 7 days.', score: 1 },
      ]);
    });

    it('drops hits below the score floor', async () => {
      repository.search.mockResolvedValue([
        row({ id: 'keep', score: AI_ARTICLE_SCORE_FLOOR }),
        row({ id: 'drop', score: AI_ARTICLE_SCORE_FLOOR / 2 }),
      ]);

      const hits = await service.retrieveForAi(BIZ, 'refund', IntentType.GENERAL_INQUIRY);

      expect(hits.map((h) => h.id)).toEqual(['keep']);
    });

    it('returns nothing for a blank message without querying', async () => {
      const hits = await service.retrieveForAi(BIZ, '   ', IntentType.GENERAL_INQUIRY);

      expect(hits).toEqual([]);
      expect(repository.search).not.toHaveBeenCalled();
    });

    it('degrades to ungrounded rather than throwing when the store is unreadable', async () => {
      repository.search.mockRejectedValue(new Error('connection refused'));

      await expect(
        service.retrieveForAi(BIZ, 'refund', IntentType.GENERAL_INQUIRY),
      ).resolves.toEqual([]);
    });

    it('counts a retrieval against the articles that grounded it', async () => {
      repository.search.mockResolvedValue([row()]);

      await service.retrieveForAi(BIZ, 'refund', IntentType.GENERAL_INQUIRY);

      expect(repository.incrementUseCounts).toHaveBeenCalledWith(BIZ, [ID]);
    });

    it('still answers when the use-count increment fails', async () => {
      repository.search.mockResolvedValue([row()]);
      repository.incrementUseCounts.mockRejectedValue(new Error('deadlock'));

      await expect(
        service.retrieveForAi(BIZ, 'refund', IntentType.GENERAL_INQUIRY),
      ).resolves.toHaveLength(1);
    });

    it('does not increment anything when every hit is below the floor', async () => {
      repository.search.mockResolvedValue([row({ score: 0 })]);

      await service.retrieveForAi(BIZ, 'refund', IntentType.GENERAL_INQUIRY);

      expect(repository.incrementUseCounts).not.toHaveBeenCalled();
    });
  });

  describe('excerpt', () => {
    const row = (overrides: Record<string, unknown>) => ({
      id: ID,
      title: 'T',
      slug: 's',
      summary: null,
      body: '',
      category: null,
      applicable_intents: [],
      score: 1,
      ...overrides,
    });

    it('falls back to the body when there is no summary', async () => {
      repository.search.mockResolvedValue([row({ summary: null, body: 'Short body.' })]);

      const [hit] = await service.retrieveForAi(BIZ, 'q', IntentType.GENERAL_INQUIRY);
      expect(hit).toBeDefined();

      expect(hit!.excerpt).toBe('Short body.');
    });

    it('treats a whitespace-only summary as absent', async () => {
      repository.search.mockResolvedValue([row({ summary: '   ', body: 'Real text.' })]);

      const [hit] = await service.retrieveForAi(BIZ, 'q', IntentType.GENERAL_INQUIRY);
      expect(hit).toBeDefined();

      expect(hit!.excerpt).toBe('Real text.');
    });

    it('truncates a long body at a word boundary', async () => {
      const body = `${'word '.repeat(400)}`;
      repository.search.mockResolvedValue([row({ summary: null, body })]);

      const [hit] = await service.retrieveForAi(BIZ, 'q', IntentType.GENERAL_INQUIRY);
      expect(hit).toBeDefined();

      expect(hit!.excerpt.length).toBeLessThanOrEqual(ARTICLE_EXCERPT_LENGTH + 1);
      expect(hit!.excerpt.endsWith('…')).toBe(true);
      // Cut on a boundary, not mid-token.
      expect(hit!.excerpt).not.toMatch(/wor…$/);
    });
  });

  // ─────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────

  describe('stats', () => {
    it('reports zero for a status with no articles rather than omitting it', async () => {
      repository.countByStatus.mockResolvedValue([
        { status: KnowledgeArticleStatus.PUBLISHED, count: 3 },
      ]);

      const stats = await service.stats(BIZ);

      expect(stats).toMatchObject({ total: 3, published: 3, draft: 0, archived: 0 });
    });
  });
});
