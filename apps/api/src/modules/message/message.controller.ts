import {
  Controller,
  Get,
  Param,
  Query,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { MessageService } from './message.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { MessagePaginationQueryDto, MessageSearchQueryDto } from './dto';

/**
 * MessageController — REST endpoints for message retrieval and search.
 *
 * All routes are protected (no @Public decorator). The @TenantId() decorator
 * extracts the businessId from the JWT-populated request context.
 *
 * Message creation is handled internally via MessageService (called by
 * other modules, not via REST). These endpoints are read-only.
 *
 * Routes:
 *   GET /conversations/:conversationId/messages — paginated messages for a conversation
 *   GET /messages/search                        — search messages by text content
 *   GET /messages/:id                           — get a single message by ID
 */
@ApiTags('messages')
@Controller()
export class MessageController {
  private readonly logger = new Logger(MessageController.name);

  constructor(private readonly messageService: MessageService) {}

  // ─────────────────────────────────────────────
  // Conversation Messages (paginated)
  // ─────────────────────────────────────────────

  @Get('conversations/:conversationId/messages')
  @ApiOperation({ summary: 'Get paginated messages for a conversation' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (1-100, default 20)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Base64 pagination cursor' })
  @ApiResponse({ status: 200, description: 'Paginated list of messages' })
  @ApiResponse({ status: 400, description: 'Invalid cursor or pagination parameters' })
  async getConversationMessages(
    @TenantId() businessId: string,
    @Param('conversationId', UuidValidationPipe) conversationId: string,
    @Query() query: MessagePaginationQueryDto,
  ) {
    return this.messageService.getConversationMessages(
      businessId,
      conversationId,
      query,
    );
  }

  // ─────────────────────────────────────────────
  // Search Messages
  // ─────────────────────────────────────────────

  @Get('messages/search')
  @ApiOperation({ summary: 'Search messages by text content' })
  @ApiQuery({ name: 'q', required: true, description: 'Search query' })
  @ApiQuery({ name: 'conversationId', required: false, description: 'Filter by conversation UUID' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Filter by start date (ISO-8601)' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Filter by end date (ISO-8601)' })
  @ApiResponse({ status: 200, description: 'Search results' })
  @ApiResponse({ status: 400, description: 'Missing or invalid search query' })
  async searchMessages(
    @TenantId() businessId: string,
    @Query() query: MessageSearchQueryDto,
  ) {
    return this.messageService.searchMessages(businessId, query.q, {
      conversationId: query.conversationId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  }

  // ─────────────────────────────────────────────
  // Single Message
  // ─────────────────────────────────────────────

  @Get('messages/:id')
  @ApiOperation({ summary: 'Get a single message by ID' })
  @ApiParam({ name: 'id', description: 'Message UUID' })
  @ApiResponse({ status: 200, description: 'Message details' })
  @ApiResponse({ status: 404, description: 'Message not found' })
  async getMessage(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.messageService.getMessageById(businessId, id);
  }
}
