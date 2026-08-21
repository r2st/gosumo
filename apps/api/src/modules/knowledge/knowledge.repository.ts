import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { knowledge_articles } from '@prisma/client';
import { KnowledgeArticleStatus } from '@gosumo/database';

import { PrismaService } from '../../common/services/prisma.service';
import { escapeLikeTerm } from '../../common/utils/search-pattern.util';

export interface KnowledgeListFilters {
  search?: string;
  category?: string;
  tag?: string;
  status?: KnowledgeArticleStatus;
  page?: number;
  limit?: number;
}

export interface PaginatedKnowledgeArticles {
  data: knowledge_articles[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreateKnowledgeArticleData {
  title: string;
  slug: string;
  body: string;
  summary?: string | null;
  category?: string | null;
  tags?: string[];
  keywords?: string[];
  applicableIntents?: string[];
  status?: KnowledgeArticleStatus;
  aiEnabled?: boolean;
  createdBy?: string | null;
  publishedAt?: Date | null;
}

export interface UpdateKnowledgeArticleData {
  title?: string;
  slug?: string;
  body?: string;
  summary?: string | null;
  category?: string | null;
  tags?: string[];
  keywords?: string[];
  applicableIntents?: string[];
  status?: KnowledgeArticleStatus;
  aiEnabled?: boolean;
  updatedBy?: string | null;
  publishedAt?: Date | null;
}

/** One full-text hit, straight out of Postgres. */
export interface KnowledgeSearchRow {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  body: string;
  category: string | null;
  applicable_intents: string[];
  score: number;
}

export interface KnowledgeSearchOptions {
  limit: number;
  /** Restrict to PUBLISHED + `ai_enabled` rows. Set for the AI retrieval path. */
  aiOnly?: boolean;
  /**
   * Keep only articles that declare this intent, or declare none at all.
   * Applied in SQL so the `limit` is spent on eligible rows.
   */
  intent?: string;
}

export interface KnowledgeStatsRow {
  status: KnowledgeArticleStatus;
  count: number;
}

/**
 * The indexed `tsvector` expression: a call to the IMMUTABLE function built in
 * migration 0045.
 *
 * It is a function call rather than the expression itself because Postgres
 * only uses an expression index when the query repeats the expression exactly,
 * and a mismatch does not error — it silently degrades every search to a
 * sequential scan over the tenant's articles. Naming a function makes that
 * drift impossible: there is one definition, in the database. (The function
 * also exists because the inline form cannot be indexed at all — see the note
 * in the migration on IMMUTABLE.)
 */
export const KNOWLEDGE_TSVECTOR_SQL = Prisma.sql`"knowledge_article_tsv"("title", "keywords", "summary", "body")`;

/** The Postgres function the index and the query share. Asserted in the spec. */
export const KNOWLEDGE_TSV_FUNCTION = 'knowledge_article_tsv';

/**
 * KnowledgeRepository — all Prisma access for the knowledge base.
 */
@Injectable()
export class KnowledgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(businessId: string, data: CreateKnowledgeArticleData): Promise<knowledge_articles> {
    return this.prisma.knowledge_articles.create({
      data: {
        business_id: businessId,
        title: data.title,
        slug: data.slug,
        body: data.body,
        summary: data.summary ?? null,
        category: data.category ?? null,
        tags: data.tags ?? [],
        keywords: data.keywords ?? [],
        applicable_intents: data.applicableIntents ?? [],
        status: data.status ?? KnowledgeArticleStatus.DRAFT,
        ai_enabled: data.aiEnabled ?? true,
        created_by: data.createdBy ?? null,
        published_at: data.publishedAt ?? null,
      },
    });
  }

  async findMany(
    businessId: string,
    filters: KnowledgeListFilters,
  ): Promise<PaginatedKnowledgeArticles> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const where = this.buildWhere(businessId, filters);

    const [data, total] = await Promise.all([
      this.prisma.knowledge_articles.findMany({
        where,
        orderBy: [{ updated_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.knowledge_articles.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async findById(businessId: string, id: string): Promise<knowledge_articles | null> {
    return this.prisma.knowledge_articles.findFirst({
      where: { id, business_id: businessId, deleted_at: null },
    });
  }

  async findBySlug(businessId: string, slug: string): Promise<knowledge_articles | null> {
    return this.prisma.knowledge_articles.findFirst({
      where: { business_id: businessId, slug, deleted_at: null },
    });
  }

  /**
   * Every slug in the tenant matching `base` or `base-<n>`, deleted rows
   * included.
   *
   * The unique index spans soft-deleted rows on purpose, so slug selection has
   * to see them: picking a suffix from the live rows alone would produce a
   * value a deleted row already holds, and the create would fail a P2002 the
   * operator cannot do anything about.
   */
  async findTakenSlugs(businessId: string, base: string): Promise<string[]> {
    const rows = await this.prisma.knowledge_articles.findMany({
      where: {
        business_id: businessId,
        slug: { startsWith: base },
      },
      select: { slug: true },
    });
    return rows.map((r) => r.slug);
  }

  async update(
    businessId: string,
    id: string,
    data: UpdateKnowledgeArticleData,
  ): Promise<knowledge_articles> {
    return this.prisma.knowledge_articles.update({
      where: { id, business_id: businessId },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.slug !== undefined ? { slug: data.slug } : {}),
        ...(data.body !== undefined ? { body: data.body } : {}),
        ...(data.summary !== undefined ? { summary: data.summary } : {}),
        ...(data.category !== undefined ? { category: data.category } : {}),
        ...(data.tags !== undefined ? { tags: data.tags } : {}),
        ...(data.keywords !== undefined ? { keywords: data.keywords } : {}),
        ...(data.applicableIntents !== undefined
          ? { applicable_intents: data.applicableIntents }
          : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.aiEnabled !== undefined ? { ai_enabled: data.aiEnabled } : {}),
        ...(data.updatedBy !== undefined ? { updated_by: data.updatedBy } : {}),
        ...(data.publishedAt !== undefined ? { published_at: data.publishedAt } : {}),
      },
    });
  }

  async softDelete(businessId: string, id: string): Promise<void> {
    await this.prisma.knowledge_articles.updateMany({
      where: { id, business_id: businessId, deleted_at: null },
      data: { deleted_at: new Date() },
    });
  }

  /**
   * Bump the retrieval counter for the articles that grounded a turn.
   *
   * `updateMany` rather than a per-row update: this runs on the AI hot path,
   * and the caller treats a failure as unimportant. One statement keeps that
   * cost to a single round trip.
   */
  async incrementUseCounts(businessId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.knowledge_articles.updateMany({
      where: { id: { in: ids }, business_id: businessId },
      data: { use_count: { increment: 1 } },
    });
  }

  /**
   * Full-text search, ranked by `ts_rank_cd` over the weighted vector.
   *
   * `websearch_to_tsquery` rather than `plainto_tsquery`: it accepts the
   * quoted-phrase and `or` syntax a person types without throwing on the
   * punctuation that makes `to_tsquery` fail. A customer message pasted in
   * whole is a legitimate query here, and `to_tsquery` would 500 on the first
   * apostrophe.
   *
   * The intent filter is `cardinality(...) = 0 OR $intent = ANY(...)`: an
   * article that declares no intents is applicable to all of them, which is
   * the documented default and what every article created without the field
   * gets.
   */
  async search(
    businessId: string,
    term: string,
    options: KnowledgeSearchOptions,
  ): Promise<KnowledgeSearchRow[]> {
    const query = Prisma.sql`websearch_to_tsquery('english', ${term})`;

    const statusFilter = options.aiOnly
      ? Prisma.sql`AND "status" = 'PUBLISHED'::"KnowledgeArticleStatus" AND "ai_enabled" = TRUE`
      : Prisma.empty;

    const intentFilter = options.intent
      ? Prisma.sql`AND (cardinality("applicable_intents") = 0 OR ${options.intent} = ANY("applicable_intents"))`
      : Prisma.empty;

    return this.prisma.$queryRaw<KnowledgeSearchRow[]>`
      SELECT "id",
             "title",
             "slug",
             "summary",
             "body",
             "category",
             "applicable_intents",
             ts_rank_cd(${KNOWLEDGE_TSVECTOR_SQL}, ${query}) AS "score"
        FROM "knowledge_articles"
       WHERE "business_id" = ${businessId}::uuid
         AND "deleted_at" IS NULL
         ${statusFilter}
         ${intentFilter}
         AND ${KNOWLEDGE_TSVECTOR_SQL} @@ ${query}
       ORDER BY "score" DESC, "updated_at" DESC
       LIMIT ${options.limit}
    `;
  }

  /** Per-status counts, one grouped read rather than four counts. */
  async countByStatus(businessId: string): Promise<KnowledgeStatsRow[]> {
    const rows = await this.prisma.knowledge_articles.groupBy({
      by: ['status'],
      where: { business_id: businessId, deleted_at: null },
      _count: { _all: true },
    });
    return rows.map((r) => ({ status: r.status, count: r._count._all }));
  }

  async countAiEnabled(businessId: string): Promise<number> {
    return this.prisma.knowledge_articles.count({
      where: {
        business_id: businessId,
        deleted_at: null,
        status: KnowledgeArticleStatus.PUBLISHED,
        ai_enabled: true,
      },
    });
  }

  async sumUseCounts(businessId: string): Promise<number> {
    const result = await this.prisma.knowledge_articles.aggregate({
      where: { business_id: businessId, deleted_at: null },
      _sum: { use_count: true },
    });
    return result._sum.use_count ?? 0;
  }

  async listCategories(businessId: string): Promise<string[]> {
    const rows = await this.prisma.knowledge_articles.findMany({
      where: { business_id: businessId, deleted_at: null, category: { not: null } },
      select: { category: true },
      distinct: ['category'],
      orderBy: { category: 'asc' },
    });
    return rows.map((r) => r.category).filter((c): c is string => c !== null);
  }

  private buildWhere(
    businessId: string,
    filters: KnowledgeListFilters,
  ): Prisma.knowledge_articlesWhereInput {
    return {
      business_id: businessId,
      deleted_at: null,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.tag ? { tags: { has: filters.tag } } : {}),
      // The list endpoint's `search` is a substring match on the title, not the
      // ranked full-text search — an operator scrolling their library is
      // filtering a list they already know, and expects "ret" to find
      // "Returns". Full-text ranking lives on the dedicated search endpoint.
      ...(filters.search
        ? {
            title: {
              contains: escapeLikeTerm(filters.search),
              mode: Prisma.QueryMode.insensitive,
            },
          }
        : {}),
    };
  }
}
