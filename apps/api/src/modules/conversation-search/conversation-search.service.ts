import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ChannelType, ConversationStatus } from '@gosumo/shared';
import {
  ConversationSearchRepository,
  SEARCH_COUNT_CEILING,
  type MessageSearchFilters,
} from './conversation-search.repository';
import { buildSnippet } from './search-snippet.util';
import type {
  ConversationSearchResultDto,
  MessageSearchResultDto,
  SearchMessagesQueryDto,
} from './dto';

const DEFAULT_LIMIT = 20;

/**
 * ConversationSearchService — the search box behind the inbox.
 *
 * Thin by design: the ranking is Postgres's, the snippet is a pure function,
 * and what is left here is range validation, pagination arithmetic and shaping.
 */
@Injectable()
export class ConversationSearchService {
  private readonly logger = new Logger(ConversationSearchService.name);

  constructor(private readonly repository: ConversationSearchRepository) {}

  async searchMessages(
    businessId: string,
    query: SearchMessagesQueryDto,
  ): Promise<MessageSearchResultDto> {
    const filters = this.toFilters(query);

    const [rows, total] = await Promise.all([
      this.repository.searchMessages(businessId, filters),
      this.repository.countMessages(businessId, filters),
    ]);

    return {
      data: rows.map((r) => {
        const snippet = buildSnippet(r.text_content, query.q);
        return {
          messageId: r.message_id,
          conversationId: r.conversation_id,
          sequence: r.sequence,
          direction: r.direction,
          senderType: r.sender_type,
          // `sent_at` is only written by the channel adapter, so a web-chat or
          // system message has none; `created_at` is the always-present
          // fallback rather than returning null and making the client sort on
          // a field that is sometimes missing.
          sentAt: (r.sent_at ?? r.created_at).toISOString(),
          rank: r.rank,
          snippet: snippet.text,
          highlights: snippet.matches,
          conversation: {
            subject: r.subject,
            channel: r.channel as ChannelType,
            status: r.status as ConversationStatus,
            clientId: r.client_id,
            clientName: r.client_name,
          },
        };
      }),
      pagination: this.pagination(total, filters),
      query: query.q,
    };
  }

  async searchConversations(
    businessId: string,
    query: SearchMessagesQueryDto,
  ): Promise<ConversationSearchResultDto> {
    const filters = this.toFilters(query);

    const [rows, total] = await Promise.all([
      this.repository.searchConversations(businessId, filters),
      this.repository.countConversations(businessId, filters),
    ]);

    return {
      data: rows.map((r) => {
        const snippet = buildSnippet(r.text_content, query.q);
        return {
          conversationId: r.conversation_id,
          subject: r.subject,
          channel: r.channel as ChannelType,
          status: r.status as ConversationStatus,
          clientId: r.client_id,
          clientName: r.client_name,
          lastMessageAt: r.last_message_at?.toISOString() ?? null,
          matchCount: r.match_count,
          rank: r.rank,
          snippet: snippet.text,
          highlights: snippet.matches,
        };
      }),
      pagination: this.pagination(total, filters),
      query: query.q,
    };
  }

  /**
   * Validate and normalise the query into repository filters.
   *
   * The date check is here rather than in the DTO because it is a relationship
   * between two fields, which `class-validator` can only express awkwardly. An
   * inverted range is rejected rather than silently swapped: a caller who sent
   * `from > to` has a bug, and returning results for a window they did not ask
   * for hides it.
   */
  private toFilters(query: SearchMessagesQueryDto): MessageSearchFilters {
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;

    const dateFrom = query.dateFrom ? new Date(query.dateFrom) : undefined;
    const dateTo = query.dateTo ? new Date(query.dateTo) : undefined;

    if (dateFrom && dateTo && dateFrom >= dateTo) {
      throw new BadRequestException('dateFrom must be earlier than dateTo');
    }

    return {
      query: query.q,
      clientId: query.clientId,
      conversationId: query.conversationId,
      channel: query.channel,
      status: query.status,
      dateFrom,
      dateTo,
      limit,
      offset: (page - 1) * limit,
    };
  }

  private pagination(
    total: number,
    filters: MessageSearchFilters,
  ): { total: number; totalIsExact: boolean; page: number; limit: number } {
    return {
      total,
      // The count query stops at the ceiling, so a total *at* the ceiling means
      // "at least this many" and the client should render it as "500+".
      totalIsExact: total < SEARCH_COUNT_CEILING,
      page: Math.floor(filters.offset / filters.limit) + 1,
      limit: filters.limit,
    };
  }
}
