import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  IsArray,
  IsBoolean,
  IsObject,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAGE_NUMBER } from '../../../common/validators/pagination.constants';
import {
  NotificationTemplateChannel,
  NotificationCategory,
  NotificationStatus,
} from '@prisma/client';
import { IsCalendarDateString } from '../../../common/validators/is-calendar-date.validator';

// ─────────────────────────────────────────────
// Template content (matches TemplateContent in template-renderer.ts)
// ─────────────────────────────────────────────

export class TemplateContentDto {
  @ApiPropertyOptional({ description: 'Email subject / preview line' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @ApiPropertyOptional({ description: 'Push title' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ description: 'Plain-text body (primary field)' })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  text?: string;

  @ApiPropertyOptional({ description: 'Rich HTML body (email only)' })
  @IsOptional()
  @IsString()
  html?: string;
}

// ─────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────

export class DispatchNotificationDto {
  @ApiPropertyOptional({ description: 'End-client recipient id (resolves address from profile)' })
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiProperty({ enum: NotificationTemplateChannel })
  @IsEnum(NotificationTemplateChannel)
  channel!: NotificationTemplateChannel;

  @ApiPropertyOptional({ enum: NotificationCategory, default: NotificationCategory.TRANSACTIONAL })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiPropertyOptional({ description: 'Per-tenant template name to render' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  templateName?: string;

  @ApiPropertyOptional({ description: 'Ad-hoc body when no template is used' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateContentDto)
  body?: TemplateContentDto;

  @ApiPropertyOptional({
    description: 'Explicit destination address; overrides client lookup',
  })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  recipient?: string;

  @ApiPropertyOptional({ description: 'Variables interpolated into the template' })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'ISO-8601 time to deliver (future = scheduled)' })
  @IsOptional()
  @IsCalendarDateString()
  scheduledAt?: string;

  @ApiPropertyOptional({ description: 'Idempotency key; a repeat send is skipped' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  dedupeKey?: string;

  @ApiPropertyOptional({ description: 'Domain event that triggered this, for audit' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  eventType?: string;

  @ApiPropertyOptional({ description: 'Override max delivery attempts', minimum: 1, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxAttempts?: number;
}

export class BatchRecipientDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(320)
  recipient?: string;

  @ApiPropertyOptional({ description: 'Per-recipient template variables' })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export class DispatchBatchDto {
  @ApiProperty({ enum: NotificationTemplateChannel })
  @IsEnum(NotificationTemplateChannel)
  channel!: NotificationTemplateChannel;

  @ApiPropertyOptional({ enum: NotificationCategory })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  templateName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateContentDto)
  body?: TemplateContentDto;

  @ApiProperty({ type: [BatchRecipientDto], description: 'Up to 5000 recipients' })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => BatchRecipientDto)
  recipients!: BatchRecipientDto[];

  @ApiPropertyOptional({ description: 'Shared variables merged under per-recipient data' })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsCalendarDateString()
  scheduledAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  campaignId?: string;
}

// ─────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────

export class CreateTemplateDto {
  @ApiProperty({ enum: NotificationTemplateChannel })
  @IsEnum(NotificationTemplateChannel)
  channel!: NotificationTemplateChannel;

  @ApiProperty({ description: 'Unique (per business+channel) template name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ description: 'Approved WhatsApp template name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalName?: string;

  @ApiProperty({ type: TemplateContentDto })
  @ValidateNested()
  @Type(() => TemplateContentDto)
  content!: TemplateContentDto;

  @ApiPropertyOptional({ type: [String], description: 'Declared variable names' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  variables?: string[];

  @ApiPropertyOptional({ description: 'MARKETING | UTILITY | AUTHENTICATION' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({ default: 'en' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @ApiPropertyOptional({ description: 'Restrict to a single channel account' })
  @IsOptional()
  @IsUUID()
  channelAccountId?: string;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional({ type: TemplateContentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TemplateContentDto)
  content?: TemplateContentDto;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  variables?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;
}

export class PreviewTemplateDto {
  @ApiProperty({ description: 'Sample data to render the template against' })
  @IsObject()
  data!: Record<string, unknown>;
}

export class RejectTemplateDto {
  @ApiProperty({ description: 'Why the template was rejected (e.g. Meta review feedback)' })
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

// ─────────────────────────────────────────────
// Preferences (opt-in/opt-out)
// ─────────────────────────────────────────────

export class SetPreferenceDto {
  @ApiProperty()
  @IsUUID()
  clientId!: string;

  @ApiProperty({ enum: NotificationTemplateChannel })
  @IsEnum(NotificationTemplateChannel)
  channel!: NotificationTemplateChannel;

  @ApiPropertyOptional({
    enum: NotificationCategory,
    description: 'Omit for a channel-wide default',
  })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiProperty({ description: 'true = opt-in, false = opt-out' })
  @IsBoolean()
  isEnabled!: boolean;

  @ApiPropertyOptional({ description: 'Quiet-hours start, minutes from IST midnight', minimum: 0, maximum: 1439 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  quietHoursStart?: number;

  @ApiPropertyOptional({ description: 'Quiet-hours end, minutes from IST midnight', minimum: 0, maximum: 1439 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  quietHoursEnd?: number;
}

// ─────────────────────────────────────────────
// Triggers
// ─────────────────────────────────────────────

export class TriggerConditionDto {
  @ApiProperty({ description: 'Dot-path into the event payload, e.g. "totalPaise"' })
  @IsString()
  @IsNotEmpty()
  path!: string;

  @ApiProperty({ description: 'eq | ne | gt | gte | lt | lte | exists | in' })
  @IsString()
  @IsNotEmpty()
  op!: string;

  @ApiPropertyOptional({ description: 'Comparison value (not needed for "exists")' })
  @IsOptional()
  value?: unknown;
}

export class CreateTriggerDto {
  @ApiProperty({ description: 'Domain event name, e.g. "order.confirmed"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  eventType!: string;

  @ApiProperty({ enum: NotificationTemplateChannel })
  @IsEnum(NotificationTemplateChannel)
  channel!: NotificationTemplateChannel;

  @ApiPropertyOptional({ enum: NotificationCategory })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiPropertyOptional({ description: 'Template to render; falls back to a built-in body' })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'Delay before sending, minutes (0 = immediate)', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  delayMinutes?: number;

  @ApiPropertyOptional({ type: [TriggerConditionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TriggerConditionDto)
  conditions?: TriggerConditionDto[];
}

export class UpdateTriggerDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({ enum: NotificationCategory })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  delayMinutes?: number;

  @ApiPropertyOptional({ type: [TriggerConditionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TriggerConditionDto)
  conditions?: TriggerConditionDto[];
}

// ─────────────────────────────────────────────
// Queries & delivery receipts
// ─────────────────────────────────────────────

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ enum: NotificationStatus })
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @ApiPropertyOptional({ enum: NotificationTemplateChannel })
  @IsOptional()
  @IsEnum(NotificationTemplateChannel)
  channel?: NotificationTemplateChannel;

  @ApiPropertyOptional({ enum: NotificationCategory })
  @IsOptional()
  @IsEnum(NotificationCategory)
  category?: NotificationCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  eventType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsCalendarDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsCalendarDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class UpdateDeliveryStatusDto {
  @ApiProperty({ enum: NotificationStatus })
  @IsEnum(NotificationStatus)
  status!: NotificationStatus;

  @ApiPropertyOptional({ description: 'Provider message id from the receipt' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  providerMessageId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  failureReason?: string;
}

// ─────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────

export interface NotificationDto {
  id: string;
  businessId: string;
  clientId: string | null;
  channel: NotificationTemplateChannel;
  category: NotificationCategory;
  status: NotificationStatus;
  templateId: string | null;
  eventType: string | null;
  recipient: string;
  subject: string | null;
  content: Record<string, unknown>;
  data: Record<string, unknown>;
  dedupeKey: string | null;
  batchId: string | null;
  campaignId: string | null;
  attempts: number;
  maxAttempts: number;
  providerMessageId: string | null;
  failureReason: string | null;
  scheduledAt: string | null;
  queuedAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDto {
  id: string;
  businessId: string;
  channelAccountId: string | null;
  channel: NotificationTemplateChannel;
  name: string;
  externalName: string | null;
  content: Record<string, unknown>;
  variables: string[];
  isApproved: boolean;
  approvalStatus: string | null;
  category: string | null;
  language: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PreferenceDto {
  id: string;
  businessId: string;
  clientId: string;
  channel: NotificationTemplateChannel;
  category: NotificationCategory | null;
  isEnabled: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
}

export interface TriggerDto {
  id: string;
  businessId: string;
  eventType: string;
  channel: NotificationTemplateChannel;
  category: NotificationCategory;
  templateId: string | null;
  isActive: boolean;
  delayMinutes: number;
  conditions: unknown[];
}

export interface NotificationStatsDto {
  total: number;
  byStatus: Record<string, number>;
  byChannel: Record<string, number>;
  deliveryRate: number;
  failureRate: number;
}

export interface DispatchResultDto {
  notification: NotificationDto;
  /** True when a preference/opt-out caused the notification to be SKIPPED. */
  skipped: boolean;
  skipReason?: string;
}

export interface BatchResultDto {
  batchId: string;
  total: number;
  queued: number;
  skipped: number;
}
