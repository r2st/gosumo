import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConversationSearchService } from './conversation-search.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { TenantRateLimit } from '../../common/rate-limit/tenant-rate-limit.decorator';
import {
  SearchMessagesQueryDto,
  type ConversationSearchResultDto,
  type MessageSearchResultDto,
} from './dto';

/**
 * ConversationSearchController — full-text search across conversation history.
 *
 * Two views of the same query:
 *   /search/messages       — one row per matching message (jump to the message)
 *   /search/conversations  — one row per conversation, best hit shown (browse)
 *
 * Both are tenant-scoped via `@TenantId()` and both take the same filters.
 * Snippets are returned as **plain text plus offsets**, never markup — see
 * `search-snippet.util.ts`.
 */
@ApiTags('search')
@Controller('search')
export class ConversationSearchController {
  constructor(private readonly search: ConversationSearchService) {}

  @Get('messages')
  @TenantRateLimit('search')
  @ApiOperation({
    summary: 'Full-text search across conversation messages',
    description:
      'Ranked by relevance. Filter by customer, conversation, channel, status and date range. ' +
      '`total` is capped — check `totalIsExact` before rendering it as a precise number.',
  })
  @ApiResponse({ status: 200, description: 'Ranked matching messages' })
  @ApiResponse({ status: 400, description: 'Invalid query or inverted date range' })
  async messages(
    @TenantId() tenantId: string,
    @Query() query: SearchMessagesQueryDto,
  ): Promise<MessageSearchResultDto> {
    return this.search.searchMessages(tenantId, query);
  }

  @Get('conversations')
  @TenantRateLimit('search')
  @ApiOperation({
    summary: 'Full-text search, collapsed to one row per conversation',
    description:
      'Same query and filters as /search/messages, with each conversation appearing once, ' +
      'carrying its match count and its best-ranked snippet.',
  })
  @ApiResponse({ status: 200, description: 'Ranked matching conversations' })
  @ApiResponse({ status: 400, description: 'Invalid query or inverted date range' })
  async conversations(
    @TenantId() tenantId: string,
    @Query() query: SearchMessagesQueryDto,
  ): Promise<ConversationSearchResultDto> {
    return this.search.searchConversations(tenantId, query);
  }
}
