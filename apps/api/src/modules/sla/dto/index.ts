import {
  IsOptional,
  IsString,
  IsEnum,
  IsArray,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChannelType } from '@gosumo/shared';

export class SlaConditionsDto {
  @ApiPropertyOptional({ enum: ChannelType, isArray: true, description: 'Empty/omitted matches every channel' })
  @IsOptional()
  @IsArray()
  @IsEnum(ChannelType, { each: true })
  channels?: ChannelType[];

  @ApiPropertyOptional({ type: [String], description: 'Matches if the conversation has any of these tags' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class SlaEscalationActionDto {
  @ApiProperty({ enum: ['NOTIFY', 'REASSIGN', 'CREATE_TASK'] })
  @IsEnum(['NOTIFY', 'REASSIGN', 'CREATE_TASK'])
  type!: 'NOTIFY' | 'REASSIGN' | 'CREATE_TASK';

  @ApiPropertyOptional({ description: 'Team-member UUID or role name, depending on action type' })
  @IsOptional()
  @IsString()
  target?: string;
}

export class CreateSlaPolicyDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ default: 0, description: 'Higher = evaluated first' })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ type: SlaConditionsDto })
  @ValidateNested()
  @Type(() => SlaConditionsDto)
  conditions!: SlaConditionsDto;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  firstResponseTargetMinutes!: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  resolutionTargetMinutes!: number;

  @ApiPropertyOptional({ type: [SlaEscalationActionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlaEscalationActionDto)
  escalationActions?: SlaEscalationActionDto[];
}

export class UpdateSlaPolicyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: SlaConditionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SlaConditionsDto)
  conditions?: SlaConditionsDto;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  firstResponseTargetMinutes?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  resolutionTargetMinutes?: number;

  @ApiPropertyOptional({ type: [SlaEscalationActionDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlaEscalationActionDto)
  escalationActions?: SlaEscalationActionDto[];
}

export class ListBreachesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  breached?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  escalated?: boolean;

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

export class ComplianceQueryDto {
  @ApiPropertyOptional({ description: 'Range start (ISO-8601). Defaults to 30 days ago.' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'Range end (ISO-8601). Defaults to now.' })
  @IsOptional()
  @IsString()
  to?: string;
}

export interface SlaPolicyDto {
  id: string;
  name: string;
  description: string | null;
  priority: number;
  isActive: boolean;
  conditions: SlaConditionsDto;
  firstResponseTargetMinutes: number;
  resolutionTargetMinutes: number;
  escalationActions: SlaEscalationActionDto[];
  createdAt: string;
  updatedAt: string;
}

export interface SlaBreachDto {
  id: string;
  conversationId: string;
  policyId: string;
  breachType: 'FIRST_RESPONSE' | 'RESOLUTION';
  targetMinutes: number;
  dueAt: string;
  metAt: string | null;
  breached: boolean;
  breachedAt: string | null;
  escalated: boolean;
  escalatedAt: string | null;
}

export interface PaginatedBreachesDto {
  data: SlaBreachDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface SlaComplianceDto {
  from: string;
  to: string;
  totalTargets: number;
  metTargets: number;
  breachedTargets: number;
  complianceRate: number;
}
