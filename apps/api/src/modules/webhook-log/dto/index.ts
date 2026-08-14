import {
  IsOptional,
  IsString,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAGE_NUMBER } from '../../../common/validators/pagination.constants';
import { DeadLetterStatus } from '@prisma/client';
import { IsCalendarDateString } from '../../../common/validators/is-calendar-date.validator';

export class ListWebhookEventsQueryDto {
  @ApiPropertyOptional({ description: 'e.g. "WHATSAPP", "RAZORPAY"' })
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional({ description: 'e.g. "message.received", "payment.captured"' })
  @IsOptional()
  @IsString()
  eventType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  processed?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  signatureValid?: boolean;

  @ApiPropertyOptional({ description: 'Received-at lower bound (ISO-8601)' })
  @IsOptional()
  @IsCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Received-at upper bound (ISO-8601)' })
  @IsOptional()
  @IsCalendarDateString()
  to?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class WebhookStatsQueryDto {
  @ApiPropertyOptional({ description: 'Range start (ISO-8601). Defaults to 7 days ago.' })
  @IsOptional()
  @IsCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Range end (ISO-8601). Defaults to now.' })
  @IsOptional()
  @IsCalendarDateString()
  to?: string;
}

/** List-view row — excludes the raw payload/headers for size and privacy. */
export interface WebhookEventSummaryDto {
  id: string;
  source: string;
  eventType: string;
  externalId: string;
  processed: boolean;
  processedAt: string | null;
  attempts: number;
  error: string | null;
  signatureValid: boolean;
  receivedAt: string;
}

/** Detail view — includes the full stored payload and headers. */
export interface WebhookEventDetailDto extends WebhookEventSummaryDto {
  payload: unknown;
  headers: unknown;
}

export interface PaginatedWebhookEventsDto {
  data: WebhookEventSummaryDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface WebhookStatsDto {
  from: string;
  to: string;
  total: number;
  processed: number;
  unprocessed: number;
  invalidSignature: number;
  bySource: { source: string; count: number }[];
}

// ─────────────────────────────────────────────
// Dead-letter queue
// ─────────────────────────────────────────────

/** Query filters for listing dead-lettered webhook deliveries. */
export class ListWebhookDeadLettersQueryDto {
  @ApiPropertyOptional({ enum: DeadLetterStatus })
  @IsOptional()
  @IsEnum(DeadLetterStatus)
  status?: DeadLetterStatus;

  @ApiPropertyOptional({ description: 'e.g. "RAZORPAY", "STRIPE", "WHATSAPP"' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  source?: string;

  @ApiPropertyOptional({ description: 'e.g. "payment.captured"' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  eventType?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

/** Close a dead letter out by hand: handled (RESOLVED) or dropped (DISCARDED). */
export class ResolveWebhookDeadLetterDto {
  @ApiProperty({ enum: [DeadLetterStatus.RESOLVED, DeadLetterStatus.DISCARDED] })
  @IsIn([DeadLetterStatus.RESOLVED, DeadLetterStatus.DISCARDED])
  status!: DeadLetterStatus;

  @ApiPropertyOptional({ description: 'Operator note explaining the resolution' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** List-view row for a dead-lettered delivery — omits the raw payload. */
export interface WebhookDeadLetterSummaryDto {
  id: string;
  source: string;
  eventType: string;
  externalId: string;
  status: DeadLetterStatus;
  attempts: number;
  maxAttempts: number;
  errorMessage: string;
  nextRetryAt: string | null;
  lastAttemptAt: string | null;
  replayedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
}

/** Detail view — adds the stored payload an operator needs to judge a replay. */
export interface WebhookDeadLetterDetailDto extends WebhookDeadLetterSummaryDto {
  payload: unknown;
  headers: unknown;
  errorStack: string | null;
  webhookEventId: string | null;
}

export interface WebhookDeadLetterStatsDto {
  pending: number;
  replayed: number;
  resolved: number;
  discarded: number;
  /** Sources with a replayer registered — anything else cannot be retried. */
  sources: string[];
}

/** What a manual replay did, and the entry as it now stands. */
export interface WebhookReplayResultDto {
  status: 'REPLAYED' | 'RESCHEDULED' | 'DISCARDED' | 'SKIPPED';
  /** The failure that caused a RESCHEDULED/DISCARDED outcome; null on success. */
  error: string | null;
  entry: WebhookDeadLetterSummaryDto;
}
