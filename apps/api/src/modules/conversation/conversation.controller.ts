import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ConversationService } from './conversation.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  ListConversationsQueryDto,
  UpdateConversationStatusDto,
  AssignConversationDto,
  ResolveConversationDto,
  SnoozeConversationDto,
  EscalateConversationDto,
  AutoAssignDto,
  AddTagDto,
  SetTagsDto,
  UpdateNoteDto,
} from './dto';

/**
 * ConversationController — REST endpoints for conversation management.
 *
 * All routes are protected. The @TenantId() decorator extracts the businessId
 * from the JWT-populated request context.
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
    @CurrentUser('sub') userId: string,
    @Query() query: ListConversationsQueryDto,
  ) {
    const result = await this.conversationService.listConversations(tenantId, query, userId);
    const { data, ...rest } = result as any;
    return { data, pagination: { total: rest.total ?? 0, limit: rest.limit ?? 20, page: rest.page ?? 1, totalPages: rest.totalPages ?? 0 } };
  }

  @Get('stats')
  @ApiOperation({ summary: 'Aggregate conversation counts and resolution stats' })
  @ApiResponse({ status: 200, description: 'Conversation statistics' })
  async stats(@TenantId() tenantId: string) {
    return this.conversationService.getConversationStats(tenantId);
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

  @Get(':id/context')
  @ApiOperation({ summary: 'Get conversation context for AI engine' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation context' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async getContext(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.conversationService.getConversationContext(tenantId, id);
  }

  @Get(':id/sla')
  @ApiOperation({ summary: 'Get SLA metrics for a conversation' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'SLA metrics' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async getSla(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.conversationService.getSlaMetrics(tenantId, id);
  }

  // ─── Status / lifecycle ──────────────────────

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

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resolve a conversation' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation resolved' })
  @ApiResponse({ status: 409, description: 'Open HITL tasks exist' })
  async resolve(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ResolveConversationDto,
  ) {
    return this.conversationService.resolveConversation(tenantId, id, dto);
  }

  @Post(':id/close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close a conversation (resolve by human)' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation closed' })
  async close(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ResolveConversationDto,
  ) {
    return this.conversationService.closeConversation(tenantId, id, dto.actorId);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reopen a resolved or snoozed conversation' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation reopened' })
  async reopen(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ResolveConversationDto,
  ) {
    return this.conversationService.reopenConversation(tenantId, id, dto.actorId);
  }

  @Post(':id/snooze')
  @HttpCode(200)
  @ApiOperation({ summary: 'Snooze a conversation until a future time' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation snoozed' })
  @ApiResponse({ status: 400, description: 'Invalid snooze duration' })
  async snooze(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: SnoozeConversationDto,
  ) {
    return this.conversationService.snoozeConversation(
      tenantId,
      id,
      new Date(dto.snoozeUntil),
      dto.actorId,
    );
  }

  @Post(':id/escalate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Escalate a conversation to a human agent' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation escalated' })
  async escalate(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: EscalateConversationDto,
  ) {
    return this.conversationService.escalateConversation(tenantId, id, dto);
  }

  // ─── Assignment ──────────────────────────────

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

  @Post(':id/auto-assign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Auto-assign a conversation using a strategy' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Conversation auto-assigned' })
  @ApiResponse({ status: 400, description: 'Missing candidate agents' })
  async autoAssign(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: AutoAssignDto,
  ) {
    return this.conversationService.autoAssign(tenantId, id, {
      strategy: dto.strategy,
      candidateAgentIds: dto.candidateAgentIds,
    });
  }

  // ─── Tags & notes ────────────────────────────

  @Post(':id/tags')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add a tag to a conversation' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Tag added' })
  async addTag(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: AddTagDto,
  ) {
    return this.conversationService.addTag(tenantId, id, dto.tag);
  }

  @Put(':id/tags')
  @ApiOperation({ summary: 'Replace the full tag set' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Tags replaced' })
  async setTags(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: SetTagsDto,
  ) {
    return this.conversationService.setTags(tenantId, id, dto.tags);
  }

  @Delete(':id/tags/:tag')
  @ApiOperation({ summary: 'Remove a tag from a conversation' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiParam({ name: 'tag', description: 'Tag to remove' })
  @ApiResponse({ status: 200, description: 'Tag removed' })
  async removeTag(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Param('tag') tag: string,
  ) {
    return this.conversationService.removeTag(tenantId, id, tag);
  }

  @Patch(':id/note')
  @ApiOperation({ summary: 'Update the internal note' })
  @ApiParam({ name: 'id', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'Note updated' })
  async updateNote(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateNoteDto,
  ) {
    return this.conversationService.updateNote(tenantId, id, dto.note);
  }
}
