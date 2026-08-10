import { IsOptional, IsString, IsBoolean, IsInt, Min, Max } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
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
