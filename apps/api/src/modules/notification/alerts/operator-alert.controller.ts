import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { operator_alerts } from '@prisma/client';

import { OperatorAlertService } from './operator-alert.service';
import { TenantId } from '../../../common/decorators/tenant-id.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { UuidValidationPipe } from '../../../common/pipes/uuid-validation.pipe';
import {
  ListOperatorAlertsQueryDto,
  MarkAllReadResultDto,
  OperatorAlertDto,
  OperatorAlertUnreadDto,
  PaginatedOperatorAlertsDto,
} from './dto';

/**
 * The operator alert inbox.
 *
 * Its own controller rather than more routes on `notifications`: everything
 * there is about messages sent to *clients*, and the two have opposite audience
 * and opposite privacy rules. Mixing them is what made it easy to believe
 * operator alerting existed when only its settings did.
 *
 * Every route is readable by any authenticated team member — an alert is
 * something the whole team is meant to see, and gating it by role is how a
 * CRITICAL escalation ends up visible only to whoever is on holiday.
 */
@ApiTags('operator-alerts')
@Controller('operator-alerts')
export class OperatorAlertController {
  constructor(private readonly alertService: OperatorAlertService) {}

  @Get()
  @ApiOperation({ summary: 'List operator alerts, newest first' })
  @ApiResponse({ status: 200, description: 'Paginated alerts', type: PaginatedOperatorAlertsDto })
  async list(
    @TenantId() tenantId: string,
    @Query() query: ListOperatorAlertsQueryDto,
  ): Promise<PaginatedOperatorAlertsDto> {
    const result = await this.alertService.list(tenantId, {
      kind: query.kind,
      severity: query.severity,
      status: query.status,
      unreadOnly: query.unread,
      conversationId: query.conversationId,
      page: query.page,
      limit: query.limit,
    });
    return { ...result, data: result.data.map(toDto) };
  }

  // Declared before `:id` — otherwise `/operator-alerts/unread` is matched by
  // the UUID route and answered with a 400 about a malformed UUID.
  @Get('unread')
  @ApiOperation({ summary: 'Unread alert counts for the dashboard badge' })
  @ApiResponse({ status: 200, description: 'Counts by severity', type: OperatorAlertUnreadDto })
  async unread(@TenantId() tenantId: string): Promise<OperatorAlertUnreadDto> {
    return this.alertService.unreadCounts(tenantId);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every unread alert read' })
  @ApiResponse({ status: 200, description: 'How many were still unread', type: MarkAllReadResultDto })
  async markAllRead(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<MarkAllReadResultDto> {
    return { marked: await this.alertService.markAllRead(tenantId, userId ?? null) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch one alert' })
  @ApiParam({ name: 'id', description: 'Alert UUID' })
  @ApiResponse({ status: 200, description: 'The alert', type: OperatorAlertDto })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async get(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ): Promise<OperatorAlertDto> {
    return toDto(await this.alertService.get(tenantId, id));
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one alert read' })
  @ApiParam({ name: 'id', description: 'Alert UUID' })
  @ApiResponse({ status: 200, description: 'The alert', type: OperatorAlertDto })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  async markRead(
    @TenantId() tenantId: string,
    @CurrentUser('sub') userId: string,
    @Param('id', UuidValidationPipe) id: string,
  ): Promise<OperatorAlertDto> {
    return toDto(await this.alertService.markRead(tenantId, id, userId ?? null));
  }
}

/**
 * Row → DTO.
 *
 * `delivered_to` is included: it is the business's own operator addresses, and
 * "who was actually told" is the first question asked after a missed
 * escalation. No client data crosses this boundary.
 */
function toDto(row: operator_alerts): OperatorAlertDto {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    sourceChannel: row.source_channel,
    conversationId: row.conversation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    context: (row.context ?? {}) as Record<string, unknown>,
    status: row.status,
    reason: row.reason,
    deferredUntil: row.deferred_until,
    deliveredAt: row.delivered_at,
    deliveredTo: row.delivered_to,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
