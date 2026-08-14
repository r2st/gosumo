import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAGE_SIZE } from '../../../common/validators/pagination.constants';
import { DeadLetterStatus } from '@prisma/client';

/** Query filters for listing dead letters. */
export class ListDeadLettersQueryDto {
  @ApiPropertyOptional({ enum: DeadLetterStatus })
  @IsOptional()
  @IsEnum(DeadLetterStatus)
  status?: DeadLetterStatus;

  @ApiPropertyOptional({ description: 'Filter by originating module, e.g. "realty-cadence"' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  source?: string;

  @ApiPropertyOptional({ description: 'Filter by operation name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  operation?: string;

  @ApiPropertyOptional({ minimum: 1, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

/** Resolve a dead letter as handled (RESOLVED) or dropped (DISCARDED). */
export class ResolveDeadLetterDto {
  @ApiProperty({ enum: [DeadLetterStatus.RESOLVED, DeadLetterStatus.DISCARDED] })
  @IsIn([DeadLetterStatus.RESOLVED, DeadLetterStatus.DISCARDED])
  status!: DeadLetterStatus;

  @ApiPropertyOptional({ description: 'Operator note explaining the resolution' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** A BLTC profile to validate for internal consistency (paise for money). */
export class ValidateBltcDto {
  @ApiPropertyOptional({ description: 'Budget floor in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  budgetMinPaise?: number | null;

  @ApiPropertyOptional({ description: 'Budget ceiling in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  budgetMaxPaise?: number | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  localities?: string[];

  @ApiPropertyOptional({ description: 'Purchase horizon in months' })
  @IsOptional()
  @IsInt()
  timelineMonths?: number | null;

  @ApiPropertyOptional({ description: 'Unit configuration, e.g. "2BHK"' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  config?: string | null;

  @ApiPropertyOptional({ description: 'END_USE | INVEST' })
  @IsOptional()
  @IsString()
  purpose?: string | null;

  @ApiPropertyOptional({ description: 'CASH | PREAPPROVED | NEEDS_LOAN' })
  @IsOptional()
  @IsString()
  financing?: string | null;
}
