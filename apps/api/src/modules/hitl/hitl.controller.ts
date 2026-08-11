import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { HitlService } from './hitl.service';
import type { InternalNote } from './hitl.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateTaskDto,
  ListTasksQueryDto,
  AssignTaskDto,
  ResolveTaskDto,
  ApproveDraftDto,
  RejectDraftDto,
  EditDraftDto,
  SendManualResponseDto,
  PostInternalNoteDto,
  EscalateTaskDto,
} from './dto';

/**
 * HitlController — REST endpoints for human-in-the-loop task management.
 *
 * All routes are protected by the global JwtAuthGuard. The @TenantId()
 * decorator extracts the businessId from the JWT-populated request context.
 *
 * Routes:
 *   GET    /hitl/tasks/stats                                — queue statistics
 *   GET    /hitl/tasks                                      — list tasks with filters
 *   GET    /hitl/tasks/:id                                  — get a single task
 *   POST   /hitl/tasks                                      — create a task manually
 *   PATCH  /hitl/tasks/:id/assign                           — assign task to agent
 *   PATCH  /hitl/tasks/:id/resolve                          — resolve task
 *   POST   /hitl/tasks/:id/approve                          — approve AI draft
 *   POST   /hitl/tasks/:id/reject                           — reject AI draft
 *   POST   /hitl/tasks/:id/edit-send                        — edit and send draft
 *   POST   /hitl/conversations/:conversationId/manual-response — send manual response
 *   POST   /hitl/conversations/:conversationId/notes        — post internal note
 *   GET    /hitl/conversations/:conversationId/notes        — get internal notes
 *   POST   /hitl/tasks/:id/escalate                         — escalate task
 */
@ApiTags('hitl')
@Controller('hitl')
export class HitlController {
  private readonly logger = new Logger(HitlController.name);

  constructor(private readonly hitlService: HitlService) {}

  // ───────────────────────────────────────────────────────────────────
  // Task queue stats — must be BEFORE tasks/:id to avoid "stats" as UUID
  // ───────────────────────────────────────────────────────────────────

  @Get('tasks/stats')
  @ApiOperation({ summary: 'Get task queue statistics' })
  @ApiResponse({ status: 200, description: 'Queue statistics' })
  async getTaskQueueStats(@TenantId() tenantId: string) {
    return this.hitlService.getTaskQueueStats(tenantId);
  }

  // ───────────────────────────────────────────────────────────────────
  // Task CRUD
  // ───────────────────────────────────────────────────────────────────

  @Get('tasks')
  @ApiOperation({ summary: 'List HITL tasks with optional filters' })
  @ApiResponse({ status: 200, description: 'Paginated list of tasks' })
  async listTasks(
    @TenantId() tenantId: string,
    @Query() query: ListTasksQueryDto,
  ) {
    return this.hitlService.listTasks(tenantId, query);
  }

  @Get('tasks/:id')
  @ApiOperation({ summary: 'Get a single task by ID' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiResponse({ status: 200, description: 'Task details' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async getTask(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.hitlService.getTask(tenantId, id);
  }

  @Post('tasks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a HITL task manually' })
  @ApiResponse({ status: 201, description: 'Task created' })
  async createTask(
    @TenantId() tenantId: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.hitlService.createTask(tenantId, dto);
  }

  // ───────────────────────────────────────────────────────────────────
  // Task actions
  // ───────────────────────────────────────────────────────────────────

  @Patch('tasks/:id/assign')
  @ApiOperation({ summary: 'Assign a task to a team member' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiResponse({ status: 200, description: 'Task assigned' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async assignTask(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: AssignTaskDto,
  ) {
    return this.hitlService.assignTask(tenantId, id, dto);
  }

  @Patch('tasks/:id/resolve')
  @ApiOperation({ summary: 'Resolve a task' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiResponse({ status: 200, description: 'Task resolved' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async resolveTask(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ResolveTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hitlService.resolveTask(tenantId, id, dto, user.sub);
  }

  @Post('tasks/:id/approve')
  @ApiOperation({ summary: 'Approve an AI-generated draft response' })
  @ApiResponse({ status: 201, description: 'Result of the approve action' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiResponse({ status: 200, description: 'Draft approved and sent' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async approveDraft(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ApproveDraftDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hitlService.approveDraft(tenantId, id, dto, user.sub);
  }

  @Post('tasks/:id/reject')
  @ApiOperation({ summary: 'Reject an AI-generated draft response' })
  @ApiResponse({ status: 201, description: 'Result of the reject action' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiResponse({ status: 200, description: 'Draft rejected' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async rejectDraft(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RejectDraftDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hitlService.rejectDraft(tenantId, id, dto, user.sub);
  }

  @Post('tasks/:id/edit-send')
  @ApiOperation({ summary: 'Edit an AI draft and send it' })
  @ApiResponse({ status: 201, description: 'Result of the edit send action' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiResponse({ status: 200, description: 'Edited draft sent' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async editAndSendDraft(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: EditDraftDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hitlService.editAndSendDraft(tenantId, id, dto, user.sub);
  }

  @Post('tasks/:id/escalate')
  @ApiOperation({ summary: 'Escalate a task to a higher priority or team' })
  @ApiResponse({ status: 201, description: 'Result of the escalate action' })
  @ApiParam({ name: 'id', description: 'Task UUID' })
  @ApiResponse({ status: 200, description: 'Task escalated' })
  @ApiResponse({ status: 404, description: 'Task not found' })
  async escalateTask(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: EscalateTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hitlService.escalateTask(tenantId, id, dto, user.sub);
  }

  // ───────────────────────────────────────────────────────────────────
  // Conversation-scoped endpoints
  // ───────────────────────────────────────────────────────────────────

  @Post('conversations/:conversationId/manual-response')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Send a manual response to a conversation' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @ApiResponse({ status: 204, description: 'Manual response sent' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async sendManualResponse(
    @TenantId() tenantId: string,
    @Param('conversationId', UuidValidationPipe) conversationId: string,
    @Body() dto: SendManualResponseDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    dto.conversationId = conversationId;
    await this.hitlService.sendManualResponse(tenantId, dto, user.sub);
  }

  @Post('conversations/:conversationId/notes')
  @ApiOperation({ summary: 'Post an internal note on a conversation' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @ApiResponse({ status: 201, description: 'Note created' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async postInternalNote(
    @TenantId() tenantId: string,
    @Param('conversationId', UuidValidationPipe) conversationId: string,
    @Body() dto: PostInternalNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InternalNote> {
    return this.hitlService.postInternalNote(
      tenantId,
      conversationId,
      dto,
      user.sub,
    );
  }

  @Get('conversations/:conversationId/notes')
  @ApiOperation({ summary: 'Get internal notes for a conversation' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @ApiResponse({ status: 200, description: 'List of internal notes' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async getInternalNotes(
    @TenantId() tenantId: string,
    @Param('conversationId', UuidValidationPipe) conversationId: string,
  ): Promise<InternalNote[]> {
    return this.hitlService.getInternalNotes(tenantId, conversationId);
  }
}
