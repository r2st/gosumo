import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';
import { WebhookLogService } from './webhook-log.service';
import { WebhookDlqService } from './webhook-dlq.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  ListWebhookDeadLettersQueryDto,
  ListWebhookEventsQueryDto,
  ResolveWebhookDeadLetterDto,
  WebhookStatsQueryDto,
} from './dto';

@ApiTags('webhook-log')
@Controller('webhook-log')
export class WebhookLogController {
  constructor(
    private readonly webhookLogService: WebhookLogService,
    private readonly dlq: WebhookDlqService,
  ) {}

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

  // ── Dead-letter queue ────────────────────────
  //
  // Declared above `GET :id` so the literal `dlq` segment is matched before the
  // wildcard param that would otherwise swallow it.

  @Get('dlq')
  @ApiOperation({ summary: 'List webhook deliveries parked for retry or given up on' })
  @ApiResponse({ status: 200, description: 'Dead-lettered deliveries, newest first' })
  async listDeadLetters(
    @TenantId() tenantId: string,
    @Query() query: ListWebhookDeadLettersQueryDto,
  ) {
    return this.dlq.list(tenantId, {
      status: query.status,
      source: query.source,
      eventType: query.eventType,
      limit: query.limit,
    });
  }

  @Get('dlq/stats')
  @ApiOperation({ summary: 'Dead-letter counts by status, and the replayable sources' })
  @ApiResponse({ status: 200, description: 'Counts per status for this business' })
  async deadLetterStats(@TenantId() tenantId: string) {
    return this.dlq.stats(tenantId);
  }

  @Get('dlq/:id')
  @ApiOperation({ summary: 'Get one dead-lettered delivery, including its stored payload' })
  @ApiParam({ name: 'id', description: 'Dead-letter UUID' })
  @ApiResponse({ status: 200, description: 'The requested dead letter' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  async getDeadLetter(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.dlq.get(tenantId, id);
  }

  @Post('dlq/:id/replay')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a parked delivery now, without waiting out its remaining backoff',
  })
  @ApiParam({ name: 'id', description: 'Dead-letter UUID' })
  @ApiResponse({ status: 200, description: 'Replay outcome and the entry as it now stands' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  async replayDeadLetter(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.dlq.replayNow(tenantId, id);
  }

  @Post('dlq/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a dead letter RESOLVED or DISCARDED, ending its retries' })
  @ApiParam({ name: 'id', description: 'Dead-letter UUID' })
  @ApiResponse({ status: 200, description: 'The updated dead letter' })
  @ApiResponse({ status: 404, description: 'Not found, or not visible to this business' })
  async resolveDeadLetter(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: ResolveWebhookDeadLetterDto,
  ) {
    return this.dlq.resolve(tenantId, id, dto.status, dto.note);
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
