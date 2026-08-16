import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChannelType, ConversationStatus } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';

/**
 * Ceiling on the exact-count query.
 *
 * A search UI needs to know whether there are three results or thousands; it
 * does not need to know there are exactly 41,208. Counting every match on a
 * common term means scanning the whole posting list for that term across the
 * tenant's history, which is the one part of this query whose cost is unbounded
 * by the page size — and it is paid on every keystroke of a type-ahead.
 *
 * So the count stops at this many and the response says it stopped
 * (`totalIsExact: false`), which is what lets the client render "500+".
 */
export const SEARCH_COUNT_CEILING = 500;

export interface MessageSearchFilters {
  query: string;
  clientId?: string;
  conversationId?: string;
  channel?: ChannelType;
  status?: ConversationStatus;
  dateFrom?: Date;
  dateTo?: Date;
  limit: number;
  offset: number;
}

export interface MessageSearchRow {
  message_id: string;
  conversation_id: string;
  sequence: number;
  direction: string;
  sender_type: string;
  sent_at: Date | null;
  created_at: Date;
  text_content: string | null;
  rank: number;
  subject: string | null;
  channel: string;
  status: string;
  client_id: string;
  client_name: string | null;
}

export interface ConversationSearchRow {
  conversation_id: string;
  subject: string | null;
  channel: string;
  status: string;
  client_id: string;
  client_name: string | null;
  last_message_at: Date | null;
  match_count: number;
  rank: number;
  text_content: string | null;
}

/**
 * ConversationSearchRepository — full-text search over `messages`, joined to
 * the conversation and contact a hit belongs to.
 *
 * ## Why raw SQL
 *
 * Prisma has no tsvector type and no `@@` operator, so every query here is
 * `$queryRaw`. Values are interpolated through Prisma's tagged template, which
 * binds them as parameters — the search term reaches Postgres as `$1` and is
 * never parsed as SQL. The optional filters are assembled with `Prisma.sql` /
 * `Prisma.join` for the same reason: a string-concatenated WHERE clause would
 * work identically and lose that property.
 *
 * ## Why `websearch_to_tsquery`
 *
 * `to_tsquery` raises a syntax error on input a person would reasonably type —
 * `a & ` , an unbalanced quote, a bare `!`. In a search box that turns a typo
 * into a 500. `plainto_tsquery` never errors but also ignores quotes and
 * operators, so a phrase search silently becomes an AND of its words.
 * `websearch_to_tsquery` is the one that both accepts anything and honours
 * quoted phrases, `OR`, and `-exclusion` — the syntax users already know.
 *
 * ## Tenant isolation
 *
 * `business_id` is in the WHERE clause of every query below, on `messages` and
 * again on the joined `conversations` — not because one would be insufficient
 * for correctness, but because the composite `(business_id, search_vector)` GIN
 * index (migration 0042) can only prune to one tenant if the predicate is on
 * the indexed table. Without it the text match runs across every tenant's rows
 * and the tenant filter is applied afterwards.
 */
@Injectable()
export class ConversationSearchRepository {
  private readonly logger = new Logger(ConversationSearchRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The filter fragment shared by every query here.
   *
   * `deleted_at IS NULL` is on the conversation and not the message: messages
   * are append-only and have no soft-delete column, so a message's visibility
   * is entirely its conversation's.
   */
  private conditions(businessId: string, f: MessageSearchFilters): Prisma.Sql[] {
    const parts: Prisma.Sql[] = [
      Prisma.sql`m.business_id = ${businessId}::uuid`,
      Prisma.sql`c.business_id = ${businessId}::uuid`,
      Prisma.sql`c.deleted_at IS NULL`,
      Prisma.sql`m.search_vector @@ q.query`,
    ];

    if (f.clientId) parts.push(Prisma.sql`c.client_id = ${f.clientId}::uuid`);
    if (f.conversationId) parts.push(Prisma.sql`m.conversation_id = ${f.conversationId}::uuid`);
    if (f.channel) parts.push(Prisma.sql`c.channel = ${f.channel}::"ChannelType"`);
    if (f.status) parts.push(Prisma.sql`c.status = ${f.status}::"ConversationStatus"`);
    // Filtered on the message's own timestamp, so "conversations in March" means
    // messages sent in March — a thread open since January still matches on the
    // message the caller is looking for.
    if (f.dateFrom) parts.push(Prisma.sql`m.created_at >= ${f.dateFrom}`);
    if (f.dateTo) parts.push(Prisma.sql`m.created_at < ${f.dateTo}`);

    return parts;
  }

  /** Ranked matching messages, one row per message. */
  async searchMessages(
    businessId: string,
    filters: MessageSearchFilters,
  ): Promise<MessageSearchRow[]> {
    const where = Prisma.join(this.conditions(businessId, filters), ' AND ');

    return this.prisma.$queryRaw<MessageSearchRow[]>`
      WITH q AS (SELECT websearch_to_tsquery('simple', ${filters.query}) AS query)
      SELECT m.id                                   AS message_id,
             m.conversation_id,
             m.sequence,
             m.direction::text                      AS direction,
             m.sender_type,
             m.sent_at,
             m.created_at,
             m.text_content,
             ts_rank_cd(m.search_vector, q.query)::float8 AS rank,
             c.subject,
             c.channel::text                         AS channel,
             c.status::text                          AS status,
             c.client_id,
             cl.name                                 AS client_name
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN clients cl ON cl.id = c.client_id AND cl.business_id = c.business_id
      CROSS JOIN q
      WHERE ${where}
      -- (created_at, id) after rank so the order is total: ts_rank_cd ties
      -- constantly on short messages, and an untied sort would shuffle a page
      -- between two identical requests.
      ORDER BY rank DESC, m.created_at DESC, m.id DESC
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `;
  }

  /**
   * Matching messages collapsed to one row per conversation: the best rank, the
   * number of hits, and the text of the best-ranked message.
   *
   * `DISTINCT ON` rather than a window function — it is the cheaper plan for
   * "one row per group, chosen by an ordering" and it reads as what it does.
   */
  async searchConversations(
    businessId: string,
    filters: MessageSearchFilters,
  ): Promise<ConversationSearchRow[]> {
    const where = Prisma.join(this.conditions(businessId, filters), ' AND ');

    return this.prisma.$queryRaw<ConversationSearchRow[]>`
      WITH q AS (SELECT websearch_to_tsquery('simple', ${filters.query}) AS query),
      hits AS (
        SELECT m.conversation_id,
               m.text_content,
               m.created_at,
               m.id,
               ts_rank_cd(m.search_vector, q.query)::float8 AS rank
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        CROSS JOIN q
        WHERE ${where}
      ),
      best AS (
        SELECT DISTINCT ON (conversation_id)
               conversation_id, text_content, rank
        FROM hits
        ORDER BY conversation_id, rank DESC, created_at DESC, id DESC
      ),
      tallied AS (
        SELECT conversation_id, COUNT(*)::int AS match_count
        FROM hits
        GROUP BY 1
      )
      SELECT b.conversation_id,
             c.subject,
             c.channel::text  AS channel,
             c.status::text   AS status,
             c.client_id,
             cl.name          AS client_name,
             c.last_message_at,
             t.match_count,
             b.rank,
             b.text_content
      FROM best b
      JOIN tallied t ON t.conversation_id = b.conversation_id
      JOIN conversations c ON c.id = b.conversation_id
      LEFT JOIN clients cl ON cl.id = c.client_id AND cl.business_id = c.business_id
      ORDER BY b.rank DESC, c.last_message_at DESC NULLS LAST, b.conversation_id DESC
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `;
  }

  /**
   * How many messages match, stopping at {@link SEARCH_COUNT_CEILING}.
   *
   * The subquery's `LIMIT` is what bounds the work: Postgres stops reading the
   * index once it has that many rows, so a term matching the tenant's entire
   * history costs the same as one matching exactly the ceiling.
   */
  async countMessages(businessId: string, filters: MessageSearchFilters): Promise<number> {
    const where = Prisma.join(this.conditions(businessId, filters), ' AND ');

    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      WITH q AS (SELECT websearch_to_tsquery('simple', ${filters.query}) AS query)
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT 1
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        CROSS JOIN q
        WHERE ${where}
        LIMIT ${SEARCH_COUNT_CEILING}
      ) capped
    `;
    return rows[0]?.count ?? 0;
  }

  /** The conversation-collapsed counterpart of {@link countMessages}. */
  async countConversations(businessId: string, filters: MessageSearchFilters): Promise<number> {
    const where = Prisma.join(this.conditions(businessId, filters), ' AND ');

    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      WITH q AS (SELECT websearch_to_tsquery('simple', ${filters.query}) AS query)
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT DISTINCT m.conversation_id
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        CROSS JOIN q
        WHERE ${where}
        LIMIT ${SEARCH_COUNT_CEILING}
      ) capped
    `;
    return rows[0]?.count ?? 0;
  }
}
