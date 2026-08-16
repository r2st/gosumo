import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChannelType, ConversationStatus } from '@gosumo/shared';

import { PrismaService } from '../../common/services/prisma.service';
import {
  ConversationSearchRepository,
  SEARCH_COUNT_CEILING,
  type MessageSearchFilters,
} from './conversation-search.repository';
import { ConversationSearchService } from './conversation-search.service';
import { buildSnippet, snippetTerms, SNIPPET_MAX_LENGTH } from './search-snippet.util';

const BUSINESS_ID = '00000000-0000-4000-a000-000000000001';
const OTHER_BUSINESS = '00000000-0000-4000-a000-0000000000ff';

// ─────────────────────────────────────────────
// Snippets
// ─────────────────────────────────────────────

describe('buildSnippet', () => {
  it('returns an empty snippet for a message with no text', () => {
    expect(buildSnippet(null, 'refund')).toEqual({ text: '', matches: [] });
    expect(buildSnippet('', 'refund')).toEqual({ text: '', matches: [] });
  });

  it('never emits markup', () => {
    // The whole reason ts_headline is not used: `text_content` is bytes a
    // customer chose, and a snippet field the dashboard treats as HTML would
    // make the inbox the one place an attacker controls the markup.
    const hostile = 'please refund <img src=x onerror=alert(1)> my order';
    const snippet = buildSnippet(hostile, 'refund');

    expect(snippet.text).toContain('<img src=x onerror=alert(1)>');
    expect(snippet.text).not.toContain('<mark>');
    expect(snippet.text).not.toContain('&lt;');
  });

  it('reports match offsets that index into the returned snippet', () => {
    const text = 'I would like a refund please';
    const snippet = buildSnippet(text, 'refund');

    expect(snippet.matches).toHaveLength(1);
    const [m] = snippet.matches;
    expect(snippet.text.slice(m!.start, m!.end)).toBe('refund');
  });

  it('keeps offsets correct when the snippet is clipped at the front', () => {
    // The leading ellipsis is a character in the returned string, so every
    // offset shifts by one — the case that silently mis-highlights if the
    // prefix is forgotten.
    const text = `${'x'.repeat(500)} refund ${'y'.repeat(500)}`;
    const snippet = buildSnippet(text, 'refund');

    expect(snippet.text.startsWith('…')).toBe(true);
    const [m] = snippet.matches;
    expect(snippet.text.slice(m!.start, m!.end)).toBe('refund');
  });

  it('bounds the snippet length', () => {
    const text = 'z'.repeat(5000);
    const snippet = buildSnippet(text, 'nothing-matches-here');
    // Plus at most two ellipsis characters.
    expect(snippet.text.length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH + 2);
  });

  it('falls back to the head of the message when no term is locatable', () => {
    // Postgres matched on a stem this tokenizer does not reproduce. An empty
    // snippet would be worse than an unhighlighted one.
    const snippet = buildSnippet('payments were processed', 'processing');
    expect(snippet.text.startsWith('payments were')).toBe(true);
    expect(snippet.matches).toEqual([]);
  });

  it('merges overlapping term matches into one range', () => {
    const snippet = buildSnippet('the payment failed', 'pay payment');
    expect(snippet.matches).toHaveLength(1);
    expect(snippet.text.slice(snippet.matches[0]!.start, snippet.matches[0]!.end)).toBe('payment');
  });

  it('finds every occurrence of a term', () => {
    const snippet = buildSnippet('refund refund refund', 'refund');
    expect(snippet.matches).toHaveLength(3);
  });

  it('matches case-insensitively', () => {
    const snippet = buildSnippet('REFUND requested', 'refund');
    expect(snippet.text.slice(snippet.matches[0]!.start, snippet.matches[0]!.end)).toBe('REFUND');
  });
});

describe('snippetTerms', () => {
  it('strips the websearch operators rather than highlighting them', () => {
    // `-word` is a term the query *excluded*; highlighting it would point at
    // the opposite of what was searched for.
    expect(snippetTerms('"order status" OR refund -cancelled')).toEqual([
      'order',
      'status',
      'refund',
      'cancelled',
    ]);
  });

  it('drops one-character noise', () => {
    expect(snippetTerms('a b refund')).toEqual(['refund']);
  });

  it('deduplicates', () => {
    expect(snippetTerms('refund REFUND refund')).toEqual(['refund']);
  });

  it('handles Devanagari, which the "simple" text-search config also indexes', () => {
    expect(snippetTerms('वापसी चाहिए')).toEqual(['वापसी', 'चाहिए']);
  });
});

// ─────────────────────────────────────────────
// Repository: tenant isolation and query shape
// ─────────────────────────────────────────────

/**
 * Is this interpolated value a `Prisma.sql` fragment rather than a bound value?
 *
 * Shape-checked rather than `instanceof Prisma.Sql`: `Prisma.Sql` is a type
 * export in the generated client, not a runtime constructor, so `instanceof`
 * throws.
 */
function isSqlFragment(value: unknown): value is Prisma.Sql {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Prisma.Sql).sql === 'string' &&
    Array.isArray((value as Prisma.Sql).values)
  );
}

describe('ConversationSearchRepository', () => {
  let queryRaw: jest.Mock;
  let repository: ConversationSearchRepository;

  /**
   * The SQL text and bound values of the last `$queryRaw` call.
   *
   * `$queryRaw` is a tagged template, so the mock is invoked as
   * `(strings, ...values)`. The interpolated `Prisma.Sql` fragments (the WHERE
   * clause) arrive as values, so they are spliced back into the text here —
   * otherwise every assertion about the filters would be looking at a
   * placeholder.
   */
  function lastQuery(): { sql: string; values: unknown[] } {
    const call = queryRaw.mock.calls[queryRaw.mock.calls.length - 1]!;
    const [strings, ...args] = call as [TemplateStringsArray, ...unknown[]];

    let sql = '';
    const values: unknown[] = [];
    strings.forEach((chunk, i) => {
      sql += chunk;
      if (i >= args.length) return;
      const arg = args[i];
      if (isSqlFragment(arg)) {
        sql += arg.sql;
        values.push(...arg.values);
      } else {
        sql += `$${values.length + 1}`;
        values.push(arg);
      }
    });

    return { sql, values };
  }

  const filters: MessageSearchFilters = {
    query: 'refund',
    limit: 20,
    offset: 0,
  };

  beforeEach(() => {
    queryRaw = jest.fn().mockResolvedValue([]);
    repository = new ConversationSearchRepository({ $queryRaw: queryRaw } as unknown as PrismaService);
  });

  it('binds the search term as a parameter, never as SQL text', async () => {
    const hostile = "'; DROP TABLE messages; --";
    await repository.searchMessages(BUSINESS_ID, { ...filters, query: hostile });

    const { sql, values } = lastQuery();
    expect(sql).not.toContain('DROP TABLE');
    expect(values).toContain(hostile);
  });

  it('scopes both messages and conversations to the tenant', async () => {
    // Both, not one: the composite (business_id, search_vector) GIN index can
    // only prune to a tenant if the predicate is on the indexed table, so
    // filtering on the join alone would run the text match platform-wide.
    await repository.searchMessages(BUSINESS_ID, filters);

    const { sql, values } = lastQuery();
    expect(sql).toContain('m.business_id');
    expect(sql).toContain('c.business_id');
    expect(values.filter((v) => v === BUSINESS_ID)).toHaveLength(2);
    expect(values).not.toContain(OTHER_BUSINESS);
  });

  it('excludes soft-deleted conversations', async () => {
    await repository.searchMessages(BUSINESS_ID, filters);
    expect(lastQuery().sql).toContain('c.deleted_at IS NULL');
  });

  it('uses websearch_to_tsquery, which cannot raise a syntax error on user input', async () => {
    // to_tsquery would turn an unbalanced quote into a 500; plainto_tsquery
    // would silently discard the phrase the user quoted.
    await repository.searchMessages(BUSINESS_ID, filters);
    expect(lastQuery().sql).toContain('websearch_to_tsquery');
  });

  it('matches through the indexed tsvector column', async () => {
    await repository.searchMessages(BUSINESS_ID, filters);
    expect(lastQuery().sql).toContain('m.search_vector @@ q.query');
  });

  it.each([
    ['clientId', { clientId: 'cl-1' }, 'c.client_id'],
    ['conversationId', { conversationId: 'cv-1' }, 'm.conversation_id'],
    ['channel', { channel: ChannelType.EMAIL }, 'c.channel'],
    ['status', { status: ConversationStatus.RESOLVED }, 'c.status'],
    ['dateFrom', { dateFrom: new Date('2026-01-01') }, 'm.created_at >='],
    ['dateTo', { dateTo: new Date('2026-02-01') }, 'm.created_at <'],
  ])('applies the %s filter', async (_name, extra, fragment) => {
    await repository.searchMessages(BUSINESS_ID, { ...filters, ...extra });
    expect(lastQuery().sql).toContain(fragment);
  });

  it('omits a filter the caller did not supply', async () => {
    await repository.searchMessages(BUSINESS_ID, filters);
    const { sql } = lastQuery();
    expect(sql).not.toContain('c.client_id =');
    expect(sql).not.toContain('c.channel =');
  });

  it('orders by a total order, so a page does not shuffle between requests', async () => {
    // ts_rank_cd ties constantly on short messages; rank alone is not a total
    // order and Postgres is free to return ties differently each time.
    await repository.searchMessages(BUSINESS_ID, filters);
    expect(lastQuery().sql).toContain('ORDER BY rank DESC, m.created_at DESC, m.id DESC');
  });

  it('caps the count query rather than tallying every match', async () => {
    await repository.countMessages(BUSINESS_ID, filters);
    const { sql, values } = lastQuery();
    expect(sql).toContain('LIMIT');
    expect(values).toContain(SEARCH_COUNT_CEILING);
  });

  it('counts distinct conversations for the collapsed view', async () => {
    await repository.countConversations(BUSINESS_ID, filters);
    expect(lastQuery().sql).toContain('DISTINCT m.conversation_id');
  });

  it('collapses to one row per conversation with a match tally', async () => {
    await repository.searchConversations(BUSINESS_ID, filters);
    const { sql } = lastQuery();
    expect(sql).toContain('DISTINCT ON (conversation_id)');
    expect(sql).toContain('match_count');
  });
});

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

describe('ConversationSearchService', () => {
  function makeService(rows: unknown[] = [], total = 0) {
    const repository = {
      searchMessages: jest.fn().mockResolvedValue(rows),
      searchConversations: jest.fn().mockResolvedValue(rows),
      countMessages: jest.fn().mockResolvedValue(total),
      countConversations: jest.fn().mockResolvedValue(total),
    } as unknown as ConversationSearchRepository;

    return { service: new ConversationSearchService(repository), repository };
  }

  function messageRow(overrides: Record<string, unknown> = {}) {
    return {
      message_id: 'm-1',
      conversation_id: 'cv-1',
      sequence: 4,
      direction: 'INBOUND',
      sender_type: 'CLIENT',
      sent_at: new Date('2026-08-01T10:00:00Z'),
      created_at: new Date('2026-08-01T10:00:05Z'),
      text_content: 'I would like a refund for my order',
      rank: 0.42,
      subject: 'Order 123',
      channel: 'WHATSAPP',
      status: 'OPEN',
      client_id: 'cl-1',
      client_name: 'Priya',
      ...overrides,
    };
  }

  it('shapes a hit with its conversation context and a plain-text snippet', async () => {
    const { service } = makeService([messageRow()], 1);

    const result = await service.searchMessages(BUSINESS_ID, { q: 'refund' });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      messageId: 'm-1',
      conversationId: 'cv-1',
      sequence: 4,
      rank: 0.42,
      conversation: {
        subject: 'Order 123',
        channel: ChannelType.WHATSAPP,
        status: ConversationStatus.OPEN,
        clientId: 'cl-1',
        clientName: 'Priya',
      },
    });
    expect(result.data[0]!.highlights.length).toBeGreaterThan(0);
  });

  it('falls back to created_at when a message has no channel-assigned sent_at', async () => {
    // `sent_at` is written only by the channel adapter, so web-chat and system
    // messages have none — returning null would make the client sort on a
    // field that is sometimes missing.
    const { service } = makeService([messageRow({ sent_at: null })], 1);

    const result = await service.searchMessages(BUSINESS_ID, { q: 'refund' });
    expect(result.data[0]!.sentAt).toBe('2026-08-01T10:00:05.000Z');
  });

  it('echoes the query so a client highlights the same terms the server did', async () => {
    const { service } = makeService([], 0);
    const result = await service.searchMessages(BUSINESS_ID, { q: 'refund order' });
    expect(result.query).toBe('refund order');
  });

  it('reports an exact total below the ceiling', async () => {
    const { service } = makeService([], 12);
    const result = await service.searchMessages(BUSINESS_ID, { q: 'refund' });
    expect(result.pagination).toMatchObject({ total: 12, totalIsExact: true });
  });

  it('flags a total that hit the ceiling as inexact', async () => {
    // So a client renders "500+" rather than claiming a precise number the
    // capped count never computed.
    const { service } = makeService([], SEARCH_COUNT_CEILING);
    const result = await service.searchMessages(BUSINESS_ID, { q: 'the' });
    expect(result.pagination).toMatchObject({
      total: SEARCH_COUNT_CEILING,
      totalIsExact: false,
    });
  });

  it('translates page/limit into an offset', async () => {
    const { service, repository } = makeService([], 0);

    await service.searchMessages(BUSINESS_ID, { q: 'refund', page: 3, limit: 10 });

    expect(repository.searchMessages).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.objectContaining({ limit: 10, offset: 20 }),
    );
  });

  it('reports the page back from the offset it computed', async () => {
    const { service } = makeService([], 0);
    const result = await service.searchMessages(BUSINESS_ID, { q: 'refund', page: 3, limit: 10 });
    expect(result.pagination).toMatchObject({ page: 3, limit: 10 });
  });

  it('rejects an inverted date range instead of silently swapping it', async () => {
    const { service } = makeService();

    await expect(
      service.searchMessages(BUSINESS_ID, {
        q: 'refund',
        dateFrom: '2026-08-01T00:00:00Z',
        dateTo: '2026-07-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a zero-width date range', async () => {
    const { service } = makeService();

    await expect(
      service.searchMessages(BUSINESS_ID, {
        q: 'refund',
        dateFrom: '2026-08-01T00:00:00Z',
        dateTo: '2026-08-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes the tenant id through to every repository call', async () => {
    const { service, repository } = makeService([], 0);

    await service.searchConversations(BUSINESS_ID, { q: 'refund' });

    expect(repository.searchConversations).toHaveBeenCalledWith(BUSINESS_ID, expect.anything());
    expect(repository.countConversations).toHaveBeenCalledWith(BUSINESS_ID, expect.anything());
  });

  it('collapses to conversations with a match count', async () => {
    const { service } = makeService(
      [
        {
          conversation_id: 'cv-1',
          subject: 'Order 123',
          channel: 'EMAIL',
          status: 'RESOLVED',
          client_id: 'cl-1',
          client_name: 'Priya',
          last_message_at: new Date('2026-08-02T10:00:00Z'),
          match_count: 3,
          rank: 0.9,
          text_content: 'refund processed',
        },
      ],
      1,
    );

    const result = await service.searchConversations(BUSINESS_ID, { q: 'refund' });

    expect(result.data[0]).toMatchObject({
      conversationId: 'cv-1',
      matchCount: 3,
      rank: 0.9,
      channel: ChannelType.EMAIL,
      status: ConversationStatus.RESOLVED,
      lastMessageAt: '2026-08-02T10:00:00.000Z',
    });
  });

  it('returns an empty page rather than an error when nothing matches', async () => {
    const { service } = makeService([], 0);
    const result = await service.searchMessages(BUSINESS_ID, { q: 'zzzznothing' });
    expect(result.data).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });
});
