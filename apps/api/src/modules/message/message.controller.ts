import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { MessageService } from './message.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  MessagePaginationQueryDto,
  MessageSearchQueryDto,
  UpdateDeliveryStatusDto,
  AttachMediaDto,
  AttachAIMetadataDto,
  ReactionDto,
} from './dto';

/**
 * MessageController — REST endpoints for message retrieval, search, media,
 * reactions, threading, and delivery status.
 *
 * Message creation (store inbound/outbound) is internal — invoked by other
 * modules via MessageService, not over REST.
 */
@ApiTags('messages')
@Controller()
export class MessageController {
  private readonly logger = new Logger(MessageController.name);

  constructor(private readonly messageService: MessageService) {}

  // ─── Conversation message listing & stats ────

  @Get('conversations/:conversationId/messages')
  @ApiOperation({ summary: 'Get paginated messages for a conversation' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (1-100, default 20)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Base64 pagination cursor' })
  @ApiResponse({ status: 200, description: 'Paginated list of messages' })
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

  @Get('conversations/:conversationId/messages/stats')
  @ApiOperation({ summary: 'Aggregate message counts for a conversation' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Message statistics' })
  async getStats(
    @TenantId() businessId: string,
    @Param('conversationId', UuidValidationPipe) conversationId: string,
  ) {
    return this.messageService.getMessageStats(businessId, conversationId);
  }

  // ─── Search ──────────────────────────────────

  @Get('messages/search')
  @ApiOperation({ summary: 'Search messages by text content' })
  @ApiQuery({ name: 'q', required: true, description: 'Search query' })
  @ApiResponse({ status: 200, description: 'Search results' })
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

  // ─── Single message ──────────────────────────

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

  @Get('messages/:id/thread')
  @ApiOperation({ summary: 'Get a message with its direct replies' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Message UUID' })
  @ApiResponse({ status: 200, description: 'Message thread' })
  async getThread(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.messageService.getMessageThread(businessId, id);
  }

  @Patch('messages/:id/status')
  @ApiOperation({ summary: 'Update message delivery status' })
  @ApiParam({ name: 'id', description: 'Message UUID' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({ status: 404, description: 'Message not found' })
  async updateStatus(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateDeliveryStatusDto,
  ) {
    return this.messageService.updateDeliveryStatus(businessId, id, dto);
  }

  @Post('messages/:id/ai-metadata')
  @HttpCode(200)
  @ApiOperation({ summary: 'Attach AI metadata to a message' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Message UUID' })
  @ApiResponse({ status: 200, description: 'Metadata attached' })
  async attachAIMetadata(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: AttachAIMetadataDto,
  ) {
    return this.messageService.attachAIMetadata(businessId, id, dto);
  }

  // ─── Media ───────────────────────────────────

  @Post('messages/:id/media')
  @HttpCode(201)
  @ApiOperation({ summary: 'Attach an S3-backed media file to a message' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Message UUID' })
  @ApiResponse({ status: 201, description: 'Media attached' })
  async attachMedia(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: AttachMediaDto,
  ) {
    return this.messageService.attachMedia(businessId, id, dto);
  }

  @Get('messages/:id/media')
  @ApiOperation({ summary: 'List media attached to a message' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Message UUID' })
  @ApiResponse({ status: 200, description: 'Media files' })
  async getMedia(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.messageService.getMessageMedia(businessId, id);
  }

  // ─── Reactions ───────────────────────────────

  @Post('messages/:id/reactions')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add a reaction to a message' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Message UUID' })
  @ApiResponse({ status: 200, description: 'Reaction added' })
  async addReaction(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ReactionDto,
  ) {
    return this.messageService.addReaction(businessId, id, dto);
  }

  @Delete('messages/:id/reactions/:senderId')
  @ApiOperation({ summary: 'Remove a sender reaction from a message' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Message UUID' })
  @ApiParam({ name: 'senderId', description: 'Reacting sender UUID' })
  @ApiResponse({ status: 200, description: 'Reaction removed' })
  async removeReaction(
    @TenantId() businessId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Param('senderId', UuidValidationPipe) senderId: string,
  ) {
    return this.messageService.removeReaction(businessId, id, senderId);
  }
}
