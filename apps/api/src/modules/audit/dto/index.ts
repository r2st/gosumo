import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '@gosumo/database';
import {
  MAX_PAGE_NUMBER,
  MAX_PAGE_SIZE,
} from '../../../common/validators/pagination.constants';
import { IsCalendarDateString } from '../../../common/validators/is-calendar-date.validator';
import {
  AUDIT_ACTOR_TYPES,
  DEFAULT_AUDIT_PAGE_SIZE,
  MAX_RESOURCE_TYPE_LENGTH,
  type AuditActorTypeFilter,
} from '../audit.constants';

/** Filters shared by the list, summary and export endpoints. */
export class AuditLogFilterDto {
  @ApiPropertyOptional({
    description: 'Window start (ISO 8601). Defaults to 30 days before `to`.',
  })
  @IsOptional()
  @IsCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Window end (ISO 8601). Defaults to now.' })
  @IsOptional()
  @IsCalendarDateString()
  to?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: AuditAction,
    description: 'Action types to include. Omit for all.',
  })
  @IsOptional()
  @Type(() => String)
  @IsArray()
  @ArrayMaxSize(Object.keys(AuditAction).length)
  @IsEnum(AuditAction, { each: true })
  actions?: AuditAction[];

  @ApiPropertyOptional({ enum: AUDIT_ACTOR_TYPES })
  @IsOptional()
  @IsIn(AUDIT_ACTOR_TYPES as readonly string[])
  actorType?: AuditActorTypeFilter;

  @ApiPropertyOptional({ description: 'Acting team member UUID' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ description: 'Resource type, e.g. "team_member"' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_RESOURCE_TYPE_LENGTH)
  resourceType?: string;

  @ApiPropertyOptional({ description: 'A specific record UUID' })
  @IsOptional()
  @IsUUID()
  resourceId?: string;
}

/** Filters plus paging, for the list endpoint. */
export class ListAuditLogsQueryDto extends AuditLogFilterDto {
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_NUMBER, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_AUDIT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

/** One audit row as the dashboard sees it. */
export class AuditLogDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) businessId!: string | null;
  @ApiProperty() actorType!: string;
  @ApiProperty({ nullable: true }) actorId!: string | null;
  @ApiProperty({ nullable: true }) actorEmail!: string | null;
  @ApiProperty({ enum: AuditAction }) action!: AuditAction;
  @ApiProperty() resourceType!: string;
  @ApiProperty({ nullable: true }) resourceId!: string | null;
  @ApiProperty({ nullable: true, type: Object }) before!: unknown;
  @ApiProperty({ nullable: true, type: Object }) after!: unknown;
  @ApiProperty({ nullable: true }) ipAddress!: string | null;
  @ApiProperty({ nullable: true }) userAgent!: string | null;
  @ApiProperty({ nullable: true }) requestId!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty() createdAt!: string;
}

/** A page of audit rows. */
export class PaginatedAuditLogsDto {
  @ApiProperty({ type: [AuditLogDto] }) data!: AuditLogDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty({ description: 'Window actually queried, after defaulting' })
  window!: { from: string; to: string };
}

/** Aggregate counts over the same window the list would return. */
export class AuditSummaryDto {
  @ApiProperty() total!: number;
  @ApiProperty({ description: 'Window actually queried, after defaulting' })
  window!: { from: string; to: string };
  @ApiProperty({ isArray: true, type: Object })
  byAction!: Array<{ action: string; count: number }>;
  @ApiProperty({ isArray: true, type: Object })
  byActor!: Array<{ actorId: string | null; actorEmail: string | null; count: number }>;
}
