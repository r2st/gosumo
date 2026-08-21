import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { knowledge_articles } from '@prisma/client';
import { KnowledgeArticleStatus } from '@gosumo/database';
import { IntentType } from '@gosumo/shared';

import {
  KnowledgeRepository,
  type KnowledgeSearchRow,
} from './knowledge.repository';
import {
  AI_ARTICLE_SCORE_FLOOR,
  ARTICLE_EXCERPT_LENGTH,
  MAX_AI_ARTICLES,
} from './knowledge.constants';
import { disambiguateSlug, slugify } from './slug.util';
import {
  CreateKnowledgeArticleDto,
  KnowledgeArticleDto,
  KnowledgeSearchHitDto,
  KnowledgeStatsDto,
  ListKnowledgeArticlesQueryDto,
  PaginatedKnowledgeArticlesDto,
  SearchKnowledgeArticlesQueryDto,
  UpdateKnowledgeArticleDto,
} from './dto';

/** What the AI pipeline gets back: enough to ground a prompt and to attribute. */
export interface GroundingArticle {
  id: string;
  title: string;
  excerpt: string;
  score: number;
}

/**
 * KnowledgeService — FAQ and help-article management, plus the retrieval path
 * the AI engine grounds on.
 *
 * The retrieval half is deliberately failure-tolerant in a way the CRUD half is
 * not. `retrieveForAi` is called on the message hot path; a knowledge base that
 * cannot be read must degrade to an ungrounded answer, exactly as the vector
 * retriever already does, rather than drop the customer's message.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(private readonly repository: KnowledgeRepository) {}

  // ─────────────────────────────────────────────
  // Management
  // ─────────────────────────────────────────────

  async create(
    businessId: string,
    dto: CreateKnowledgeArticleDto,
    userId?: string,
  ): Promise<KnowledgeArticleDto> {
    const slug = await this.allocateSlug(businessId, dto.title);
    const status = dto.status ?? KnowledgeArticleStatus.DRAFT;

    const article = await this.repository.create(businessId, {
      title: dto.title,
      slug,
      body: dto.body,
      summary: dto.summary ?? null,
      category: dto.category ?? null,
      tags: dto.tags ?? [],
      keywords: dto.keywords ?? [],
      applicableIntents: dto.applicableIntents ?? [],
      status,
      aiEnabled: dto.aiEnabled ?? true,
      createdBy: userId ?? null,
      // `published_at` is the moment it first went live, not the last edit —
      // set here only when the article is created already published.
      publishedAt: status === KnowledgeArticleStatus.PUBLISHED ? new Date() : null,
    });

    return this.toDto(article);
  }

  async list(
    businessId: string,
    query: ListKnowledgeArticlesQueryDto,
  ): Promise<PaginatedKnowledgeArticlesDto> {
    const result = await this.repository.findMany(businessId, {
      search: query.search,
      category: query.category,
      tag: query.tag,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });

    return {
      data: result.data.map((a) => this.toDto(a)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
    };
  }

  async get(businessId: string, id: string): Promise<KnowledgeArticleDto> {
    return this.toDto(await this.require(businessId, id));
  }

  async getBySlug(businessId: string, slug: string): Promise<KnowledgeArticleDto> {
    const article = await this.repository.findBySlug(businessId, slug);
    if (!article) {
      throw new NotFoundException(`Knowledge article "${slug}" not found`);
    }
    return this.toDto(article);
  }

  async update(
    businessId: string,
    id: string,
    dto: UpdateKnowledgeArticleDto,
    userId?: string,
  ): Promise<KnowledgeArticleDto> {
    const existing = await this.require(businessId, id);

    // The slug is not re-derived when the title changes. It is the stable
    // handle a saved link or an embedded help widget points at, and silently
    // repointing it on a typo fix would break those with no way to notice.
    const publishedAt = this.nextPublishedAt(existing, dto.status);

    const updated = await this.repository.update(businessId, id, {
      title: dto.title,
      body: dto.body,
      summary: dto.summary,
      category: dto.category,
      tags: dto.tags,
      keywords: dto.keywords,
      applicableIntents: dto.applicableIntents,
      status: dto.status,
      aiEnabled: dto.aiEnabled,
      updatedBy: userId ?? null,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    });

    return this.toDto(updated);
  }

  async publish(
    businessId: string,
    id: string,
    userId?: string,
  ): Promise<KnowledgeArticleDto> {
    return this.update(businessId, id, { status: KnowledgeArticleStatus.PUBLISHED }, userId);
  }

  async archive(
    businessId: string,
    id: string,
    userId?: string,
  ): Promise<KnowledgeArticleDto> {
    return this.update(businessId, id, { status: KnowledgeArticleStatus.ARCHIVED }, userId);
  }

  async remove(businessId: string, id: string): Promise<void> {
    await this.require(businessId, id);
    await this.repository.softDelete(businessId, id);
  }

  async stats(businessId: string): Promise<KnowledgeStatsDto> {
    const [byStatus, aiEnabled, totalUses, categories] = await Promise.all([
      this.repository.countByStatus(businessId),
      this.repository.countAiEnabled(businessId),
      this.repository.sumUseCounts(businessId),
      this.repository.listCategories(businessId),
    ]);

    const count = (status: KnowledgeArticleStatus): number =>
      byStatus.find((r) => r.status === status)?.count ?? 0;

    return {
      total: byStatus.reduce((sum, r) => sum + r.count, 0),
      published: count(KnowledgeArticleStatus.PUBLISHED),
      draft: count(KnowledgeArticleStatus.DRAFT),
      archived: count(KnowledgeArticleStatus.ARCHIVED),
      aiEnabled,
      totalUses,
      categories,
    };
  }

  // ─────────────────────────────────────────────
  // Search
  // ─────────────────────────────────────────────

  /** Operator-facing ranked search. Spans every status, no score floor. */
  async search(
    businessId: string,
    query: SearchKnowledgeArticlesQueryDto,
  ): Promise<KnowledgeSearchHitDto[]> {
    const rows = await this.repository.search(businessId, query.q, {
      limit: query.limit ?? MAX_AI_ARTICLES,
      intent: query.intent,
    });

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      excerpt: this.excerpt(row),
      category: row.category,
      score: row.score,
    }));
  }

  /**
   * The AI grounding path.
   *
   * Three differences from operator search, each load-bearing:
   *   - only PUBLISHED + `ai_enabled` rows are eligible;
   *   - hits below `AI_ARTICLE_SCORE_FLOOR` are dropped, because the prompt
   *     presents whatever comes back as the business's own policy and a weak
   *     match makes the model answer confidently off the wrong document;
   *   - it never throws. A knowledge base that cannot be read degrades to an
   *     ungrounded answer, which the confidence calculator already penalises,
   *     rather than failing the customer's turn.
   */
  async retrieveForAi(
    businessId: string,
    text: string,
    intent: IntentType,
    limit = MAX_AI_ARTICLES,
  ): Promise<GroundingArticle[]> {
    const term = text.trim();
    if (term.length === 0) return [];

    let rows: KnowledgeSearchRow[];
    try {
      rows = await this.repository.search(businessId, term, {
        limit,
        aiOnly: true,
        intent,
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Knowledge retrieval failed for business ${businessId}; continuing ungrounded: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return [];
    }

    const hits = rows
      .filter((row) => row.score >= AI_ARTICLE_SCORE_FLOOR)
      .map((row) => ({
        id: row.id,
        title: row.title,
        excerpt: this.excerpt(row),
        score: row.score,
      }));

    if (hits.length > 0) {
      // Fire-and-forget. The counter is reporting, and losing an increment is
      // strictly better than failing a turn that has already been answered.
      this.repository
        .incrementUseCounts(
          businessId,
          hits.map((h) => h.id),
        )
        .catch((err: unknown) => {
          this.logger.debug(
            `Knowledge use-count increment failed for business ${businessId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        });
    }

    return hits;
  }

  // ─────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────

  private async require(businessId: string, id: string): Promise<knowledge_articles> {
    const article = await this.repository.findById(businessId, id);
    if (!article) {
      throw new NotFoundException(`Knowledge article ${id} not found`);
    }
    return article;
  }

  /**
   * Pick a free slug for a new article.
   *
   * Two articles legitimately share a title ("Refund policy" for two
   * categories), so a collision is a naming problem rather than an error:
   * the second gets `refund-policy-2`. Only an exhausted suffix range —
   * which means a hundred same-titled articles — is reported as a conflict.
   */
  private async allocateSlug(businessId: string, title: string): Promise<string> {
    const base = slugify(title, 'article');
    const taken = new Set(await this.repository.findTakenSlugs(businessId, base));

    if (!taken.has(base)) return base;

    for (let attempt = 2; attempt <= 100; attempt += 1) {
      const candidate = disambiguateSlug(base, attempt);
      if (!taken.has(candidate)) return candidate;
    }

    throw new ConflictException(
      `Too many knowledge articles already use the slug "${base}" — please give this article a more distinct title`,
    );
  }

  /**
   * What `published_at` becomes for a status transition.
   *
   * `undefined` means "leave it alone". The column records when the article
   * *first* went live: re-publishing something previously archived keeps the
   * original date rather than resetting the article's apparent age.
   */
  private nextPublishedAt(
    existing: knowledge_articles,
    status?: KnowledgeArticleStatus,
  ): Date | null | undefined {
    if (status === undefined) return undefined;
    if (status !== KnowledgeArticleStatus.PUBLISHED) return undefined;
    if (existing.published_at !== null) return undefined;
    return new Date();
  }

  /**
   * The text an article contributes to a prompt.
   *
   * `summary` when set, else the head of the body. The body is truncated at a
   * word boundary — cutting mid-word leaves the model a fragment it tends to
   * complete by guessing, which is the opposite of what grounding is for.
   */
  private excerpt(row: Pick<KnowledgeSearchRow, 'summary' | 'body'>): string {
    const summary = row.summary?.trim();
    if (summary) return summary;

    const body = row.body.trim();
    if (body.length <= ARTICLE_EXCERPT_LENGTH) return body;

    const head = body.slice(0, ARTICLE_EXCERPT_LENGTH);
    const lastSpace = head.lastIndexOf(' ');
    return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
  }

  private toDto(article: knowledge_articles): KnowledgeArticleDto {
    return {
      id: article.id,
      title: article.title,
      slug: article.slug,
      summary: article.summary,
      body: article.body,
      category: article.category,
      tags: article.tags,
      keywords: article.keywords,
      applicableIntents: article.applicable_intents,
      status: article.status,
      aiEnabled: article.ai_enabled,
      useCount: article.use_count,
      publishedAt: article.published_at,
      createdAt: article.created_at,
      updatedAt: article.updated_at,
    };
  }
}
