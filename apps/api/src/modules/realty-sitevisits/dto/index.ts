import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  IsBoolean,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SiteVisitStatus, SiteVisitOutcome } from '@gosumo/shared';
import { IsCalendarDateString } from '../../../common/validators/is-calendar-date.validator';

// ─────────────────────────────────────────────
// BOOK
// ─────────────────────────────────────────────

export class BookVisitDto {
  @ApiProperty({ description: 'Lead UUID the visit is for' })
  @IsUUID()
  leadId!: string;

  @ApiProperty({ description: 'Project UUID being visited' })
  @IsUUID()
  projectId!: string;

  @ApiPropertyOptional({ description: 'Specific unit UUID, if any' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({ description: 'Scheduled start time (ISO-8601 UTC)', example: '2026-07-10T05:30:00.000Z' })
  @IsCalendarDateString()
  scheduledAt!: string;

  @ApiPropertyOptional({ description: 'Visit duration in minutes', default: 45 })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  durationMinutes?: number;

  @ApiPropertyOptional({ description: 'Owning agent (team member) UUID' })
  @IsOptional()
  @IsUUID()
  assignedAgentId?: string;

  @ApiPropertyOptional({ description: 'Calendar staff UUID to sync the event onto (defaults to business calendar)' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({ description: 'IANA timezone for the visit', example: 'Asia/Kolkata' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;

  @ApiPropertyOptional({ description: 'Free-form note (address, meeting point)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ─────────────────────────────────────────────
// RESCHEDULE / CANCEL / COMPLETE
// ─────────────────────────────────────────────

export class RescheduleVisitDto {
  @ApiProperty({ description: 'New scheduled start time (ISO-8601 UTC)' })
  @IsCalendarDateString()
  newScheduledAt!: string;

  @ApiPropertyOptional({ description: 'New duration in minutes' })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  durationMinutes?: number;
}

export class CancelVisitDto {
  @ApiPropertyOptional({ description: 'Reason the visit was cancelled' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CompleteVisitDto {
  @ApiProperty({ enum: SiteVisitOutcome, description: 'Post-visit outcome' })
  @IsEnum(SiteVisitOutcome)
  outcome!: SiteVisitOutcome;

  @ApiPropertyOptional({ description: 'Broker feedback captured after the visit' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  feedback?: string;
}

// ─────────────────────────────────────────────
// QUERY
// ─────────────────────────────────────────────

export class ListVisitsQueryDto {
  @ApiPropertyOptional({ enum: SiteVisitStatus })
  @IsOptional()
  @IsEnum(SiteVisitStatus)
  status?: SiteVisitStatus;

  @ApiPropertyOptional({ description: 'Filter by lead UUID' })
  @IsOptional()
  @IsUUID()
  leadId?: string;

  @ApiPropertyOptional({ description: 'Filter by owning agent UUID' })
  @IsOptional()
  @IsUUID()
  assignedAgentId?: string;

  @ApiPropertyOptional({ description: 'Range start (ISO-8601)' })
  @IsOptional()
  @IsCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Range end (ISO-8601)' })
  @IsOptional()
  @IsCalendarDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Only future, non-terminal visits', default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  upcoming?: boolean;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CalendarQueryDto {
  @ApiProperty({ description: 'Range start (ISO-8601)' })
  @IsCalendarDateString()
  from!: string;

  @ApiProperty({ description: 'Range end (ISO-8601)' })
  @IsCalendarDateString()
  to!: string;
}
