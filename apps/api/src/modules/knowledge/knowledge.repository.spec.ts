/**
 * KnowledgeRepository unit tests.
 *
 * Two things here are not ordinary Prisma plumbing:
 *
 *  1. **The search statement is hand-written SQL.** Root rule #1 applies to it
 *     exactly as it does to a Prisma `where`, and hand-written SQL is where
 *     tenant scoping is most likely to be forgotten. The repository-wide
 *     contract asserts the statement mentions `business_id`; these cases
 *     assert *what it does with it*, and that the AI-only and intent filters
 *     are actually appended rather than silently dropped.
 *
 *  2. **The `tsvector` expression is duplicated** between the query and the GIN
 *     index in migration 0045. Postgres matches an expression index by parsing
 *     both sides, and a mismatch does not error — the planner falls back to a
 *     sequential scan over the tenant's articles. That degradation is invisible
 *     until the table is large, so the two texts are compared here.
 */
import * as fs from 'fs';
import * as path from 'path';

import { Test } from '@nestjs/testing';
import { KnowledgeArticleStatus } from '@gosumo/database';
import { IntentType } from '@gosumo/shared';

import {
  KNOWLEDGE_TSVECTOR_SQL,
  KNOWLEDGE_TSV_FUNCTION,
  KnowledgeRepository,
} from './knowledge.repository';
import { PrismaService } from '../../common/services/prisma.service';

const BIZ = '00000000-0000-4000-a000-000000000001';
const ID = '00000000-0000-4000-b000-000000000001';

describe('KnowledgeRepository', () => {
  let repository: KnowledgeRepository;
  let prisma: {
    knowledge_articles: {
      create: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
      aggregate: jest.Mock;
    };
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      knowledge_articles: {
        create: jest.fn().mockResolvedValue({ id: ID }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: ID }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _sum: { use_count: null } }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [KnowledgeRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = module.get(KnowledgeRepository);
  });

  /**
   * A value interpolated into the raw template: its own SQL text if it is a
   * `Prisma.Sql` fragment, otherwise `?` for the bind hole it becomes.
   *
   * The statement composes `KNOWLEDGE_TSVECTOR_SQL` and the two optional
   * filters as fragments, so reading the template's static strings alone would
   * show `?` where a whole WHERE clause lives — which is exactly how a dropped
   * tenant predicate would hide. This mirrors the renderer in
   * `repository-contract.spec.ts`.
   */
  function fragmentText(value: unknown): string {
    const frag = value as { strings?: unknown; values?: unknown } | null;
    if (!frag || typeof frag !== 'object' || !Array.isArray(frag.strings)) return '?';

    const binds = Array.isArray(frag.values) ? frag.values : [];
    return frag.strings
      .map((chunk, i) => (i < binds.length ? `${String(chunk)}${fragmentText(binds[i])}` : String(chunk)))
      .join('');
  }

  /** The SQL text of the one raw statement, parameters collapsed to `?`. */
  function rawSql(): string {
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    return strings
      .map((chunk, i) => (i < values.length ? `${chunk}${fragmentText(values[i])}` : chunk))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Every bind value the statement carries, flattened through nested
   * fragments — the intent filter's parameter lives inside one.
   */
  function rawParams(): unknown[] {
    const [, ...values] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];

    const flatten = (value: unknown): unknown[] => {
      const frag = value as { strings?: unknown; values?: unknown } | null;
      if (frag && typeof frag === 'object' && Array.isArray(frag.strings)) {
        return (Array.isArray(frag.values) ? frag.values : []).flatMap(flatten);
      }
      return [value];
    };

    return values.flatMap(flatten);
  }

  const listWhere = () =>
    prisma.knowledge_articles.findMany.mock.calls[0][0].where as Record<string, unknown>;

  // ─────────────────────────────────────────────
  // Writes
  // ─────────────────────────────────────────────

  describe('create', () => {
    it('stamps the tenant and defaults the array columns to empty', async () => {
      await repository.create(BIZ, { title: 'T', slug: 't', body: 'b' });

      expect(prisma.knowledge_articles.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          business_id: BIZ,
          tags: [],
          keywords: [],
          applicable_intents: [],
          status: KnowledgeArticleStatus.DRAFT,
          ai_enabled: true,
        }),
      });
    });

    it('honours an explicit ai_enabled of false rather than treating it as unset', async () => {
      await repository.create(BIZ, { title: 'T', slug: 't', body: 'b', aiEnabled: false });

      expect(prisma.knowledge_articles.create.mock.calls[0][0].data.ai_enabled).toBe(false);
    });
  });

  describe('update', () => {
    it('omits every field the caller did not supply', async () => {
      await repository.update(BIZ, ID, { title: 'New' });

      expect(prisma.knowledge_articles.update.mock.calls[0][0].data).toEqual({ title: 'New' });
    });

    it('scopes the update to the tenant', async () => {
      await repository.update(BIZ, ID, { title: 'New' });

      expect(prisma.knowledge_articles.update.mock.calls[0][0].where).toEqual({
        id: ID,
        business_id: BIZ,
      });
    });

    it('writes an explicit null summary rather than skipping it', async () => {
      await repository.update(BIZ, ID, { summary: null });

      expect(prisma.knowledge_articles.update.mock.calls[0][0].data).toEqual({ summary: null });
    });
  });

  describe('softDelete', () => {
    it('sets deleted_at only on a live row of this tenant', async () => {
      await repository.softDelete(BIZ, ID);

      expect(prisma.knowledge_articles.updateMany.mock.calls[0][0].where).toEqual({
        id: ID,
        business_id: BIZ,
        deleted_at: null,
      });
    });
  });

  describe('incrementUseCounts', () => {
    it('does not issue a statement for an empty id list', async () => {
      await repository.incrementUseCounts(BIZ, []);

      expect(prisma.knowledge_articles.updateMany).not.toHaveBeenCalled();
    });

    it('bumps every id in one tenant-scoped statement', async () => {
      await repository.incrementUseCounts(BIZ, ['a', 'b']);

      expect(prisma.knowledge_articles.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.knowledge_articles.updateMany.mock.calls[0][0]).toEqual({
        where: { id: { in: ['a', 'b'] }, business_id: BIZ },
        data: { use_count: { increment: 1 } },
      });
    });
  });

  // ─────────────────────────────────────────────
  // Listing
  // ─────────────────────────────────────────────

  describe('findMany', () => {
    it('always scopes to the tenant and excludes soft-deleted rows', async () => {
      await repository.findMany(BIZ, {});

      expect(listWhere()).toMatchObject({ business_id: BIZ, deleted_at: null });
    });

    it('omits absent filters rather than matching on undefined', async () => {
      await repository.findMany(BIZ, {});

      expect(listWhere()).not.toHaveProperty('status');
      expect(listWhere()).not.toHaveProperty('category');
      expect(listWhere()).not.toHaveProperty('tags');
      expect(listWhere()).not.toHaveProperty('title');
    });

    it('filters by tag membership', async () => {
      await repository.findMany(BIZ, { tag: 'shipping' });

      expect(listWhere().tags).toEqual({ has: 'shipping' });
    });

    it('escapes LIKE metacharacters in the title filter', async () => {
      await repository.findMany(BIZ, { search: '100%_off' });

      expect(listWhere().title).toMatchObject({ contains: '100\\%\\_off' });
    });

    it('reports at least one page for an empty result', async () => {
      const result = await repository.findMany(BIZ, {});

      expect(result.totalPages).toBe(1);
    });

    it('turns page into the matching skip', async () => {
      await repository.findMany(BIZ, { page: 3, limit: 10 });

      expect(prisma.knowledge_articles.findMany.mock.calls[0][0]).toMatchObject({
        skip: 20,
        take: 10,
      });
    });
  });

  describe('findTakenSlugs', () => {
    it('includes soft-deleted rows, because the unique index does', async () => {
      await repository.findTakenSlugs(BIZ, 'refund-policy');

      const where = prisma.knowledge_articles.findMany.mock.calls[0][0].where as Record<
        string,
        unknown
      >;
      expect(where).toEqual({ business_id: BIZ, slug: { startsWith: 'refund-policy' } });
      expect(where).not.toHaveProperty('deleted_at');
    });
  });

  // ─────────────────────────────────────────────
  // Full-text search
  // ─────────────────────────────────────────────

  describe('search', () => {
    it('scopes the statement to the tenant and excludes deleted rows', async () => {
      await repository.search(BIZ, 'refund', { limit: 3 });

      const sql = rawSql();
      expect(sql).toMatch(/"business_id" = \?::uuid/);
      expect(sql).toMatch(/"deleted_at" IS NULL/);
      expect(rawParams()).toContain(BIZ);
    });

    it('passes the search term as a bound parameter, never as SQL text', async () => {
      await repository.search(BIZ, "'; DROP TABLE knowledge_articles; --", { limit: 3 });

      expect(rawSql()).not.toContain('DROP TABLE');
      expect(rawParams()).toContain("'; DROP TABLE knowledge_articles; --");
    });

    it('uses websearch_to_tsquery so punctuation in a pasted message cannot error', async () => {
      await repository.search(BIZ, "what's the refund window?", { limit: 3 });

      expect(rawSql()).toContain('websearch_to_tsquery');
      // Not the bare `to_tsquery`, which raises a syntax error on the
      // apostrophe rather than treating it as a word character.
      expect(rawSql()).not.toMatch(/(?<!websearch_|plain)to_tsquery/);
    });

    it('adds the published + ai_enabled filter only for the AI path', async () => {
      await repository.search(BIZ, 'refund', { limit: 3, aiOnly: true });

      expect(rawSql()).toContain('"ai_enabled" = TRUE');
      expect(rawSql()).toContain(`'PUBLISHED'::"KnowledgeArticleStatus"`);
    });

    it('omits the status filter for operator search', async () => {
      await repository.search(BIZ, 'refund', { limit: 3 });

      expect(rawSql()).not.toContain('"ai_enabled" = TRUE');
    });

    it('treats an article declaring no intents as applicable to every intent', async () => {
      await repository.search(BIZ, 'refund', {
        limit: 3,
        intent: IntentType.GENERAL_INQUIRY,
      });

      const sql = rawSql();
      expect(sql).toContain('cardinality("applicable_intents") = 0');
      expect(sql).toContain('ANY("applicable_intents")');
      expect(rawParams()).toContain(IntentType.GENERAL_INQUIRY);
    });

    it('omits the intent filter when none is given', async () => {
      await repository.search(BIZ, 'refund', { limit: 3 });

      expect(rawSql()).not.toContain('applicable_intents") = 0');
    });

    it('bounds the result set with the caller-supplied limit', async () => {
      await repository.search(BIZ, 'refund', { limit: 7 });

      expect(rawSql()).toMatch(/LIMIT \?/);
      expect(rawParams()).toContain(7);
    });

    it('ranks by score', async () => {
      await repository.search(BIZ, 'refund', { limit: 3 });

      expect(rawSql()).toContain('ts_rank_cd');
      expect(rawSql()).toContain('ORDER BY "score" DESC');
    });
  });

  // ─────────────────────────────────────────────
  // Index / query drift
  // ─────────────────────────────────────────────

  describe('the search index matches the search query', () => {
    const migration = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../../packages/database/prisma/migrations/0045_knowledge_articles.sql',
      ),
      'utf8',
    );

    it('calls the same function the GIN index is built on', () => {
      // `USING GIN (fn(...))` — the index's indexed expression.
      const indexed = migration.match(/USING GIN \("?([a-z_]+)"?\(/);

      expect(indexed?.[1]).toBe(KNOWLEDGE_TSV_FUNCTION);
      expect(KNOWLEDGE_TSVECTOR_SQL.text).toContain(KNOWLEDGE_TSV_FUNCTION);
    });

    it('passes the index function its arguments in the declared order', () => {
      // Postgres matches an expression index by the whole call, arguments
      // included. `fn(title, keywords, summary, body)` and `fn(title, summary,
      // keywords, body)` are different expressions — the second compiles, runs,
      // returns a differently-weighted vector, and never uses the index.
      const declared = migration.match(
        /CREATE OR REPLACE FUNCTION "knowledge_article_tsv"\(([\s\S]*?)\) RETURNS/,
      );
      expect(declared).not.toBeNull();

      const params = [...(declared?.[1] ?? '').matchAll(/"([a-z_]+)"\s+[A-Z]/g)].map((m) => m[1] ?? '');
      expect(params).toEqual(['title', 'keywords', 'summary', 'body']);

      const called = [...KNOWLEDGE_TSVECTOR_SQL.text.matchAll(/"([a-z_]+)"/g)]
        .map((m) => m[1] ?? '')
        .filter((name) => name !== KNOWLEDGE_TSV_FUNCTION);
      expect(called).toEqual(params);
    });

    it('declares the index function IMMUTABLE, or the index cannot be built', () => {
      // `to_tsvector(text, text)` and `array_to_string` are both only STABLE,
      // so Postgres rejects the inline expression outright with "functions in
      // index expression must be marked IMMUTABLE". The wrapper is what makes
      // the index legal; dropping the keyword breaks the migration, not the
      // query, so it fails at deploy time rather than in a request.
      expect(migration).toMatch(/RETURNS tsvector[\s\S]*?IMMUTABLE/);
    });

    it('pins the text search configuration with a regconfig cast', () => {
      // The bare `'english'` overload resolves the configuration at call time.
      // Inside a function asserted IMMUTABLE that is a lie with teeth: rows
      // indexed under one configuration would be searched under another.
      const body = migration.slice(
        migration.indexOf('CREATE OR REPLACE FUNCTION "knowledge_article_tsv"'),
      );
      const calls = [...body.matchAll(/to_tsvector\(([^,]+),/g)].map((m) => (m[1] ?? '').trim());

      expect(calls).toHaveLength(4);
      for (const arg of calls) {
        expect(arg).toBe("'english'::regconfig");
      }
    });

    it('weights the title and keywords above the summary and body', () => {
      const body = migration.slice(
        migration.indexOf('CREATE OR REPLACE FUNCTION "knowledge_article_tsv"'),
      );

      // $1..$4 are title, keywords, summary, body in declaration order.
      expect(body).toMatch(/coalesce\(\$1, ''\)\), 'A'/);
      expect(body).toMatch(/array_to_string\(\$2, ' '\), ''\)\), 'B'/);
      expect(body).toMatch(/coalesce\(\$3, ''\)\), 'C'/);
      expect(body).toMatch(/coalesce\(\$4, ''\)\), 'D'/);
    });

    it('coalesces every part, so one null column cannot erase the whole vector', () => {
      const body = migration.slice(
        migration.indexOf('CREATE OR REPLACE FUNCTION "knowledge_article_tsv"'),
        migration.indexOf('CREATE INDEX IF NOT EXISTS "knowledge_articles_search_idx"'),
      );

      expect(body.match(/coalesce/g) ?? []).toHaveLength(4);
    });

    it('carries no bound parameters, so it can be nested in either position', () => {
      // The fragment is interpolated twice — once into `ts_rank_cd` and once
      // into the `@@` predicate. A bind hole inside it would be numbered
      // differently at each site.
      expect(KNOWLEDGE_TSVECTOR_SQL.values).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────
  // Aggregates
  // ─────────────────────────────────────────────

  describe('aggregates', () => {
    it('groups status counts within the tenant only', async () => {
      await repository.countByStatus(BIZ);

      expect(prisma.knowledge_articles.groupBy.mock.calls[0][0].where).toEqual({
        business_id: BIZ,
        deleted_at: null,
      });
    });

    it('reports zero uses rather than null for a tenant with no articles', async () => {
      await expect(repository.sumUseCounts(BIZ)).resolves.toBe(0);
    });

    it('counts only published, AI-enabled articles as AI-visible', async () => {
      await repository.countAiEnabled(BIZ);

      expect(prisma.knowledge_articles.count.mock.calls[0][0].where).toMatchObject({
        business_id: BIZ,
        deleted_at: null,
        status: KnowledgeArticleStatus.PUBLISHED,
        ai_enabled: true,
      });
    });

    it('drops nulls from the category list', async () => {
      prisma.knowledge_articles.findMany.mockResolvedValue([
        { category: 'Payments' },
        { category: null },
      ]);

      await expect(repository.listCategories(BIZ)).resolves.toEqual(['Payments']);
    });
  });

  it('builds the tsvector fragment through Prisma.sql, not string concatenation', () => {
    // A plain string interpolated into `$queryRaw` becomes a bind parameter,
    // not SQL — the function call would reach Postgres quoted and the query
    // would rank every row against a literal instead of its own text.
    expect(
      Array.isArray((KNOWLEDGE_TSVECTOR_SQL as unknown as { strings: unknown[] }).strings),
    ).toBe(true);
    expect(KNOWLEDGE_TSVECTOR_SQL.text).toContain(KNOWLEDGE_TSV_FUNCTION);
  });
});
