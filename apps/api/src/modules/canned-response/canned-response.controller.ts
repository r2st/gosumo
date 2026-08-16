import { Controller, Get, Post, Patch, Delete, Param, Query, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { TeamMemberRole } from '@gosumo/database';
import { CannedResponseService } from './canned-response.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateCannedResponseDto,
  UpdateCannedResponseDto,
  ListCannedResponsesQueryDto,
  RecordUsageDto,
  RenderTemplateDto,
  ReviewTemplateDto,
} from './dto';

@ApiTags('canned-responses')
@Controller('canned-responses')
export class CannedResponseController {
  constructor(private readonly cannedResponseService: CannedResponseService) {}

  @Post()
  @ApiOperation({ summary: 'Create a canned response' })
  @ApiResponse({ status: 201, description: 'Canned response created' })
  @ApiResponse({ status: 409, description: 'Shortcut already in use' })
  async create(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateCannedResponseDto,
  ) {
    return this.cannedResponseService.create(tenantId, dto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'List canned responses with search and filters' })
  @ApiResponse({ status: 200, description: 'Paginated canned response list for this business' })
  async list(@TenantId() tenantId: string, @Query() query: ListCannedResponsesQueryDto) {
    return this.cannedResponseService.list(tenantId, query);
  }

  @Get('shortcut/:shortcut')
  @ApiOperation({ summary: 'Look up a canned response by its shortcut' })
  @ApiResponse({ status: 200, description: 'The requested shortcut' })
  @ApiParam({ name: 'shortcut', description: 'Shortcut' })
  @ApiResponse({ status: 404, description: 'No canned response with this shortcut' })
  async getByShortcut(@TenantId() tenantId: string, @Param('shortcut') shortcut: string) {
    return this.cannedResponseService.getByShortcut(tenantId, shortcut);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a canned response by ID' })
  @ApiResponse({ status: 200, description: 'The requested canned response' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async get(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.cannedResponseService.get(tenantId, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a canned response' })
  @ApiResponse({ status: 200, description: 'The updated canned response' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async update(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateCannedResponseDto,
  ) {
    return this.cannedResponseService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a canned response' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 204, description: 'Canned response deleted' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async delete(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    await this.cannedResponseService.delete(tenantId, id);
  }

  @Post(':id/usage')
  @ApiOperation({ summary: 'Record that a canned response was used (increments usage_count)' })
  @ApiResponse({ status: 201, description: 'The updated usage counters' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async recordUsage(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RecordUsageDto,
  ) {
    return this.cannedResponseService.recordUsage(tenantId, id, dto.conversationId, userId);
  }

  // ─── Variables ───────────────────────────────

  @Post(':id/render')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Render an approved template with the agent’s values, ready to send',
    description:
      'Refuses when a required variable has no value — a blank in the middle of a ' +
      'sentence is a message nobody wrote.',
  })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 200, description: 'The rendered body' })
  @ApiResponse({ status: 400, description: 'Not approved, or a required variable is missing' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async render(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RenderTemplateDto,
  ) {
    return this.cannedResponseService.render(tenantId, id, dto.values ?? {});
  }

  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview a template while writing it',
    description:
      'Unlike render, this ignores the approval state and reports missing variables ' +
      'instead of refusing — previewing a half-written template is the normal case.',
  })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 200, description: 'The rendered body plus what is still missing' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async preview(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: RenderTemplateDto,
  ) {
    return this.cannedResponseService.preview(tenantId, id, dto.values ?? {});
  }

  // ─── Approval workflow ───────────────────────

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit a draft (or a rejected response) for review' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 200, description: 'Now PENDING review' })
  @ApiResponse({ status: 400, description: 'Not in a submittable state' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async submit(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.cannedResponseService.submitForApproval(tenantId, id, userId);
  }

  @Post(':id/approve')
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending response, making it usable' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 200, description: 'Now APPROVED' })
  @ApiResponse({ status: 400, description: 'Not pending review' })
  @ApiResponse({ status: 403, description: 'Only a MANAGER or OWNER may review' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async approve(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ReviewTemplateDto,
  ) {
    return this.cannedResponseService.approve(tenantId, id, userId, dto.note);
  }

  @Post(':id/reject')
  @Roles(TeamMemberRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending response with a note the author can act on' })
  @ApiParam({ name: 'id', description: 'Canned response UUID' })
  @ApiResponse({ status: 200, description: 'Now REJECTED' })
  @ApiResponse({ status: 400, description: 'Not pending review, or no note supplied' })
  @ApiResponse({ status: 403, description: 'Only a MANAGER or OWNER may review' })
  @ApiResponse({ status: 404, description: 'Canned response not found' })
  async reject(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ReviewTemplateDto,
  ) {
    return this.cannedResponseService.reject(tenantId, id, dto.note ?? '', userId);
  }
}
