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
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery } from '@nestjs/swagger';
import { NotificationTemplateChannel } from '@prisma/client';
import { NotificationService } from './notification.service';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { UuidValidationPipe } from '../../common/pipes/uuid-validation.pipe';
import {
  DispatchNotificationDto,
  DispatchBatchDto,
  CreateTemplateDto,
  UpdateTemplateDto,
  PreviewTemplateDto,
  SetPreferenceDto,
  CreateTriggerDto,
  UpdateTriggerDto,
  ListNotificationsQueryDto,
  UpdateDeliveryStatusDto,
} from './dto';

/**
 * NotificationController — REST surface for the Notification module.
 *
 * All routes sit behind the global JwtAuthGuard; `@TenantId()` supplies the
 * authenticated business id. Customer-facing dispatch is event-driven (see
 * NotificationEventListener) — these endpoints are for the operator dashboard:
 * sending ad-hoc notifications, managing templates/triggers/preferences, and
 * inspecting delivery history.
 */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationController {
  private readonly logger = new Logger(NotificationController.name);

  constructor(private readonly service: NotificationService) {}

  // ─── Dispatch ───

  @Post('dispatch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Dispatch a single notification' })
  @ApiResponse({ status: 202, description: 'Notification queued (or skipped via opt-out)' })
  async dispatch(@TenantId() tenantId: string, @Body() dto: DispatchNotificationDto) {
    return this.service.dispatch(tenantId, dto);
  }

  @Post('dispatch/batch')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Dispatch a bulk notification to many recipients' })
  @ApiResponse({ status: 202, description: 'Batch queued' })
  async dispatchBatch(@TenantId() tenantId: string, @Body() dto: DispatchBatchDto) {
    return this.service.dispatchBatch(tenantId, dto);
  }

  // ─── History & stats ───

  @Get()
  @ApiOperation({ summary: 'List notification history with filters' })
  async list(@TenantId() tenantId: string, @Query() query: ListNotificationsQueryDto) {
    return this.service.listNotifications(tenantId, query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Delivery stats (counts, delivery/failure rate)' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  async stats(
    @TenantId() tenantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.getStats(tenantId, from, to);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one notification by id' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async get(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.service.getNotification(tenantId, id);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Re-queue a failed notification' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async retry(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.service.retryNotification(tenantId, id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Apply a provider delivery receipt (delivered/read/failed)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async updateStatus(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateDeliveryStatusDto,
  ) {
    return this.service.updateDeliveryStatus(tenantId, id, dto);
  }

  // ─── Templates ───

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a notification template' })
  async createTemplate(@TenantId() tenantId: string, @Body() dto: CreateTemplateDto) {
    return this.service.createTemplate(tenantId, dto);
  }

  @Get('templates')
  @ApiOperation({ summary: 'List templates (optionally by channel)' })
  @ApiQuery({ name: 'channel', required: false, enum: NotificationTemplateChannel })
  async listTemplates(
    @TenantId() tenantId: string,
    @Query('channel') channel?: NotificationTemplateChannel,
  ) {
    return this.service.listTemplates(tenantId, channel);
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get one template' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async getTemplate(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    return this.service.getTemplate(tenantId, id);
  }

  @Put('templates/:id')
  @ApiOperation({ summary: 'Update a template' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async updateTemplate(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.service.updateTemplate(tenantId, id, dto);
  }

  @Post('templates/:id/preview')
  @ApiOperation({ summary: 'Render a template against sample data (no send)' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async previewTemplate(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: PreviewTemplateDto,
  ) {
    return this.service.previewTemplate(tenantId, id, dto.data);
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a template' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async deleteTemplate(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    await this.service.deleteTemplate(tenantId, id);
  }

  // ─── Preferences ───

  @Put('preferences')
  @ApiOperation({ summary: 'Set a client opt-in/opt-out preference' })
  async setPreference(@TenantId() tenantId: string, @Body() dto: SetPreferenceDto) {
    return this.service.setPreference(tenantId, dto);
  }

  @Get('preferences/:clientId')
  @ApiOperation({ summary: 'List a client preferences' })
  @ApiParam({ name: 'clientId', format: 'uuid' })
  async getPreferences(
    @TenantId() tenantId: string,
    @Param('clientId', UuidValidationPipe) clientId: string,
  ) {
    return this.service.getPreferences(tenantId, clientId);
  }

  // ─── Triggers ───

  @Post('triggers')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an event-driven trigger' })
  async createTrigger(@TenantId() tenantId: string, @Body() dto: CreateTriggerDto) {
    return this.service.createTrigger(tenantId, dto);
  }

  @Get('triggers')
  @ApiOperation({ summary: 'List triggers (optionally by event type)' })
  @ApiQuery({ name: 'eventType', required: false })
  async listTriggers(
    @TenantId() tenantId: string,
    @Query('eventType') eventType?: string,
  ) {
    return this.service.listTriggers(tenantId, eventType);
  }

  @Put('triggers/:id')
  @ApiOperation({ summary: 'Update a trigger' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async updateTrigger(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
    @Body() dto: UpdateTriggerDto,
  ) {
    return this.service.updateTrigger(tenantId, id, dto);
  }

  @Delete('triggers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a trigger' })
  @ApiParam({ name: 'id', format: 'uuid' })
  async deleteTrigger(
    @TenantId() tenantId: string,
    @Param('id', UuidValidationPipe) id: string,
  ) {
    await this.service.deleteTrigger(tenantId, id);
  }
}
