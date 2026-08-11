import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { RealtyBrokerService } from './realty-broker.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  CreateApprovalDto,
  ResolveApprovalDto,
  ListApprovalsQueryDto,
  UpdateSettingsDto,
  TakeoverDto,
  ReleaseDto,
  ListAlertsQueryDto,
} from './dto';

/**
 * RealtyBrokerController — the broker console REST surface (Phase 6): approval
 * queue, autonomy dial / settings, notification centre, takeover protocol,
 * morning briefing, and console metrics. JWT-guarded; @TenantId() scopes it.
 */
@ApiTags('realty-broker')
@Controller('realty/broker')
export class RealtyBrokerController {
  constructor(private readonly brokerService: RealtyBrokerService) {}

  // ── Console + briefing ───────────────────────

  @Get('console')
  @ApiOperation({ summary: 'Broker console header metrics' })
  @ApiResponse({ status: 200, description: 'Paginated console list for this business' })
  async console(@TenantId() tenantId: string) {
    return this.brokerService.getConsoleMetrics(tenantId);
  }

  @Get('briefing')
  @ApiOperation({ summary: "Today's morning briefing (visits, hot leads, follow-ups, pipeline)" })
  @ApiResponse({ status: 200, description: 'The briefing for this business' })
  async briefing(@TenantId() tenantId: string) {
    return this.brokerService.buildBriefing(tenantId);
  }

  @Post('briefing/generate')
  @ApiOperation({ summary: 'Generate the briefing and push it to the notification centre' })
  @ApiResponse({ status: 200, description: 'Result of the generate action' })
  @HttpCode(HttpStatus.OK)
  async generateBriefing(@TenantId() tenantId: string) {
    return this.brokerService.generateAndPushBriefing(tenantId);
  }

  // ── Settings / autonomy dial ─────────────────

  @Get('settings')
  @ApiOperation({ summary: 'Get broker account settings (autonomy dial, kill switch, briefing)' })
  @ApiResponse({ status: 200, description: 'The settings for this business' })
  async getSettings(@TenantId() tenantId: string) {
    return this.brokerService.getSettingsDto(tenantId);
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Update broker account settings' })
  @ApiResponse({ status: 200, description: 'The updated settings' })
  async updateSettings(@TenantId() tenantId: string, @Body() dto: UpdateSettingsDto) {
    return this.brokerService.updateSettings(tenantId, dto);
  }

  // ── Approval queue ───────────────────────────

  @Post('approvals')
  @ApiOperation({ summary: 'Queue an AI draft for human review (70–89% band)' })
  @ApiResponse({ status: 201, description: 'The created approval' })
  async createApproval(@TenantId() tenantId: string, @Body() dto: CreateApprovalDto) {
    return this.brokerService.createApproval(tenantId, dto);
  }

  @Get('approvals')
  @ApiOperation({ summary: 'List AI drafts in the approval queue' })
  @ApiResponse({ status: 200, description: 'Paginated approval list for this business' })
  async listApprovals(@TenantId() tenantId: string, @Query() query: ListApprovalsQueryDto) {
    return this.brokerService.listApprovals(tenantId, query);
  }

  @Get('approvals/:id')
  @ApiOperation({ summary: 'Get a single queued draft' })
  @ApiResponse({ status: 200, description: 'The requested approval' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Approval UUID' })
  async getApproval(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.brokerService.getApproval(tenantId, id);
  }

  @Post('approvals/:id/resolve')
  @ApiOperation({ summary: 'Approve / edit / reject a queued draft' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Approval UUID' })
  @ApiResponse({ status: 200, description: 'Resolved approval' })
  @HttpCode(HttpStatus.OK)
  async resolveApproval(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ResolveApprovalDto,
    @CurrentUser('sub') userId: string,
  ) {
    return this.brokerService.resolveApproval(tenantId, id, dto, userId);
  }

  // ── Notification centre ──────────────────────

  @Get('alerts')
  @ApiOperation({ summary: 'List broker alerts + unread count' })
  @ApiResponse({ status: 200, description: 'Paginated alert list for this business' })
  async listAlerts(@TenantId() tenantId: string, @Query() query: ListAlertsQueryDto) {
    return this.brokerService.listAlerts(tenantId, query);
  }

  @Post('alerts/:id/read')
  @ApiOperation({ summary: 'Mark an alert as read' })
  @ApiResponse({ status: 200, description: 'The alert, now marked read' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'id', description: 'Alert UUID' })
  @HttpCode(HttpStatus.OK)
  async markRead(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.brokerService.markAlertRead(tenantId, id);
  }

  @Post('alerts/read-all')
  @ApiOperation({ summary: 'Mark all alerts read' })
  @ApiResponse({ status: 200, description: 'Count of alerts marked read' })
  @HttpCode(HttpStatus.OK)
  async markAllRead(@TenantId() tenantId: string) {
    return this.brokerService.markAllAlertsRead(tenantId);
  }

  // ── Takeover protocol ────────────────────────

  @Get('control/:conversationId')
  @ApiOperation({ summary: 'Who owns a conversation — AI or human (defaults to AI)' })
  @ApiResponse({ status: 200, description: 'The requested control' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  async getControl(
    @TenantId() tenantId: string,
    @Param('conversationId', UuidValidationPipe) conversationId: string,
  ) {
    return this.brokerService.getControl(tenantId, conversationId);
  }

  @Post('takeover')
  @ApiOperation({ summary: 'Take a conversation over from the AI (seamless handoff)' })
  @ApiResponse({ status: 200, description: 'Result of the takeover action' })
  @HttpCode(HttpStatus.OK)
  async takeover(
    @TenantId() tenantId: string,
    @Body() dto: TakeoverDto,
    @CurrentUser('sub') userId: string,
  ) {
    return this.brokerService.takeOver(tenantId, dto.conversationId, userId, dto.leadId);
  }

  @Post('release')
  @ApiOperation({ summary: 'Return a conversation to the AI' })
  @ApiResponse({ status: 200, description: 'Result of the release action' })
  @HttpCode(HttpStatus.OK)
  async release(@TenantId() tenantId: string, @Body() dto: ReleaseDto) {
    return this.brokerService.release(tenantId, dto.conversationId);
  }
}
