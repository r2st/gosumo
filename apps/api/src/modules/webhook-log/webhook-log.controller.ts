import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { WebhookLogService } from './webhook-log.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import { ListWebhookEventsQueryDto, WebhookStatsQueryDto } from './dto';

@ApiTags('webhook-log')
@Controller('webhook-log')
export class WebhookLogController {
  constructor(private readonly webhookLogService: WebhookLogService) {}

  @Get()
  @ApiOperation({ summary: 'List inbound webhook deliveries with search and filters' })
  @ApiResponse({ status: 200, description: 'Paginated webhook log list for this business' })
  async list(@TenantId() tenantId: string, @Query() query: ListWebhookEventsQueryDto) {
    return this.webhookLogService.list(tenantId, query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Webhook delivery stats for a date range (defaults to trailing 7 days)' })
  @ApiResponse({ status: 200, description: 'The delivery statistics for this business' })
  async getStats(@TenantId() tenantId: string, @Query() query: WebhookStatsQueryDto) {
    return this.webhookLogService.getStats(tenantId, query.from, query.to);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single webhook delivery, including its raw payload' })
  @ApiResponse({ status: 200, description: 'The requested webhook log' })
  @ApiParam({ name: 'id', description: 'Webhook event UUID' })
  @ApiResponse({ status: 404, description: 'Webhook event not found' })
  async get(@TenantId() tenantId: string, @Param('id', UuidValidationPipe) id: string) {
    return this.webhookLogService.get(tenantId, id);
  }
}
