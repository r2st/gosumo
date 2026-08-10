import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  IsArray,
  IsNotEmpty,
  IsUUID,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  TemplateCategory,
  TemplateApprovalStatus,
  CadenceTrigger,
  CadenceStopOn,
} from '@gosumo/shared';

// ─────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────

export class CreateTemplateDto {
  @ApiProperty({ description: 'Stable template key referenced by cadence steps', example: 'followup_d3' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ enum: TemplateCategory })
  @IsEnum(TemplateCategory)
  category!: TemplateCategory;

  @ApiProperty({ description: 'Language tag', example: 'en' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  language!: string;

  @ApiProperty({ description: 'Template body with {{1}}, {{2}} placeholders' })
  @IsString()
  @IsNotEmpty()
  body!: string;

  @ApiPropertyOptional({ description: 'Ordered placeholder variable names', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  variables?: string[];
}

export class UpdateTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ enum: TemplateCategory })
  @IsOptional()
  @IsEnum(TemplateCategory)
  category?: TemplateCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  variables?: string[];
}

export class SetTemplateApprovalDto {
  @ApiProperty({ enum: TemplateApprovalStatus })
  @IsEnum(TemplateApprovalStatus)
  approvalStatus!: TemplateApprovalStatus;
}

export class ListTemplatesQueryDto {
  @ApiPropertyOptional({ enum: TemplateCategory })
  @IsOptional()
  @IsEnum(TemplateCategory)
  category?: TemplateCategory;

  @ApiPropertyOptional({ enum: TemplateApprovalStatus })
  @IsOptional()
  @IsEnum(TemplateApprovalStatus)
  approvalStatus?: TemplateApprovalStatus;
}

// ─────────────────────────────────────────────
// CADENCES + STEPS
// ─────────────────────────────────────────────

export class CadenceStepDto {
  @ApiProperty({ description: '0-based execution order within the cadence' })
  @IsInt()
  @Min(0)
  order!: number;

  @ApiProperty({ description: 'Days after enrolment to fire this step' })
  @IsInt()
  @Min(0)
  @Max(365)
  dayOffset!: number;

  @ApiProperty({ description: 'Template UUID to send at this step' })
  @IsUUID()
  templateId!: string;

  @ApiPropertyOptional({ enum: CadenceStopOn, isArray: true, description: 'Signals that abort the cadence' })
  @IsOptional()
  @IsArray()
  @IsEnum(CadenceStopOn, { each: true })
  stopOn?: CadenceStopOn[];
}

export class CreateCadenceDto {
  @ApiProperty({ example: 'No-response follow-up (D1 / D3 / D7)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: CadenceTrigger })
  @IsEnum(CadenceTrigger)
  trigger!: CadenceTrigger;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ type: [CadenceStepDto], description: 'Ordered steps' })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CadenceStepDto)
  steps!: CadenceStepDto[];
}

export class UpdateCadenceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [CadenceStepDto], description: 'Replaces the full step list when present' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CadenceStepDto)
  steps?: CadenceStepDto[];
}

export class ListCadencesQueryDto {
  @ApiPropertyOptional({ enum: CadenceTrigger })
  @IsOptional()
  @IsEnum(CadenceTrigger)
  trigger?: CadenceTrigger;
}

// ─────────────────────────────────────────────
// ENROLLMENT (manual)
// ─────────────────────────────────────────────

export class EnrollLeadDto {
  @ApiProperty({ description: 'Lead UUID to enrol' })
  @IsUUID()
  leadId!: string;

  @ApiProperty({ enum: CadenceTrigger, description: 'Which trigger cadence to enrol into' })
  @IsEnum(CadenceTrigger)
  trigger!: CadenceTrigger;
}

export class ListEnrollmentsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by lead UUID' })
  @IsOptional()
  @IsUUID()
  leadId?: string;

  @ApiPropertyOptional({ description: 'ACTIVE | COMPLETED | STOPPED' })
  @IsOptional()
  @IsString()
  status?: string;
}
