import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ConversationService } from './conversation.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  ListConversationsQueryDto,
  UpdateConversationStatusDto,
  AssignConversationDto,
} from './dto';

/**
 * ConversationController — REST endpoints for conversation management.
 *
 * All routes are protected. The @TenantId() decorator extracts the businessId
 * from the JWT-populated request context.
 *
 * Routes:
 *   GET    /conversations             — list conversations with filters
 *   GET    /conversations/:id         — get a single conversation
 *   PATCH  /conversations/:id/status  — update conversation status
 *   PATCH  /conversations/:id/assign  — assign conversation to a team member
 *   GET    /conversations/:id/context — get conversation context for AI
 */
@ApiTags('conversations')
@Controller('conversations')
export class ConversationController {
  private readonly logger = new Logger(ConversationController.name);

  constructor(private readonly conversationService: ConversationService) {}

  @Get()
  @ApiOperation({ summary: 'List conversations with optional filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of conversations' })
  async list(
    @TenantId() tenantId: string,
    @Query() query: ListConversationsQueryDto,
  ) {
    return this.conversationService.listConversations(tenantId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single conversation by ID' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation details' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async getById(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.conversationService.getConversation(tenantId, id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update conversation status' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async updateStatus(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateConversationStatusDto,
  ) {
    return this.conversationService.updateStatus(
      tenantId,
      id,
      dto.newStatus,
      dto.actorId,
    );
  }

  @Patch(':id/assign')
  @ApiOperation({ summary: 'Assign conversation to a team member' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation assigned' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async assign(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: AssignConversationDto,
  ) {
    return this.conversationService.assignConversation(
      tenantId,
      id,
      dto.assigneeId,
    );
  }

  @Get(':id/context')
  @ApiOperation({ summary: 'Get conversation context for AI engine' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation context with messages and client profile' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async getContext(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.conversationService.getConversationContext(tenantId, id);
  }
}
