import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OperatorAlertStatus } from '@gosumo/database';

import { MAX_PAGE_NUMBER, MAX_PAGE_SIZE } from '../../../../common/validators/pagination.constants';
import {
  ALERT_KINDS,
  ALERT_SEVERITIES,
  type AlertKind,
  type AlertSeverity,
} from '../../settings/notification-settings.constants';

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

export class ListOperatorAlertsQueryDto {
  @ApiPropertyOptional({ enum: ALERT_KINDS })
  @IsOptional()
  @IsEnum(ALERT_KINDS)
  kind?: AlertKind;

  @ApiPropertyOptional({ enum: ALERT_SEVERITIES })
  @IsOptional()
  @IsEnum(ALERT_SEVERITIES)
  severity?: AlertSeverity;

  @ApiPropertyOptional({ enum: OperatorAlertStatus })
  @IsOptional()
  @IsEnum(OperatorAlertStatus)
  status?: OperatorAlertStatus;

  @ApiPropertyOptional({
    description: 'true = unread only, false = read only, omitted = both',
  })
  @IsOptional()
  // Query strings carry `"true"`, not `true`. Anything that is not one of the
  // two recognised spellings is dropped rather than coerced, so `?unread=maybe`
  // returns the unfiltered inbox instead of silently meaning "read only".
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  unread?: boolean;

  @ApiPropertyOptional({ description: 'Only alerts raised about this conversation' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: MAX_PAGE_NUMBER })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

// ─────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────

export class OperatorAlertDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ALERT_KINDS, description: 'Unknown kinds are possible; see ALERT_KINDS' })
  kind!: string;
  @ApiProperty({ enum: ALERT_SEVERITIES }) severity!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true }) body!: string | null;
  @ApiProperty({ nullable: true }) sourceChannel!: string | null;
  @ApiProperty({ nullable: true }) conversationId!: string | null;
  @ApiProperty({ nullable: true }) entityType!: string | null;
  @ApiProperty({ nullable: true }) entityId!: string | null;
  @ApiProperty({ type: Object }) context!: Record<string, unknown>;
  @ApiProperty({ enum: OperatorAlertStatus }) status!: OperatorAlertStatus;
  @ApiProperty({ nullable: true, description: 'Why it was withheld, deferred, or failed' })
  reason!: string | null;
  @ApiProperty({ nullable: true }) deferredUntil!: Date | null;
  @ApiProperty({ nullable: true }) deliveredAt!: Date | null;
  @ApiProperty({ type: [String] }) deliveredTo!: string[];
  @ApiProperty({ nullable: true }) readAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedOperatorAlertsDto {
  @ApiProperty({ type: [OperatorAlertDto] }) data!: OperatorAlertDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() totalPages!: number;
}

export class OperatorAlertSeverityCountDto {
  @ApiProperty({ enum: ALERT_SEVERITIES }) severity!: string;
  @ApiProperty() count!: number;
}

export class OperatorAlertUnreadDto {
  @ApiProperty({ description: 'Unread alerts across every severity' }) total!: number;
  @ApiProperty({ type: [OperatorAlertSeverityCountDto] })
  bySeverity!: OperatorAlertSeverityCountDto[];
}

export class MarkAllReadResultDto {
  @ApiProperty({ description: 'How many alerts were still unread' }) marked!: number;
}
