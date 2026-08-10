import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsBoolean,
  IsInt,
  IsArray,
  IsEmail,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  LeadSource,
  LeadStage,
  LeadTemperature,
  LeadPurpose,
  FinancingStatus,
} from '@gosumo/shared';

// ─────────────────────────────────────────────
// CREATE / UPDATE
// ─────────────────────────────────────────────

export class CreateLeadDto {
  @ApiProperty({ description: 'Buyer WhatsApp phone in E.164 format', example: '+919876543210' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  whatsappPhone!: string;

  @ApiProperty({ enum: LeadSource, description: 'Where the lead was born (attribution)' })
  @IsEnum(LeadSource)
  source!: LeadSource;

  @ApiPropertyOptional({ description: 'Buyer name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'Buyer email' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Alternate phone' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  altPhone?: string;

  @ApiPropertyOptional({ description: 'Preferred language', example: 'hinglish' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  languagePref?: string;

  @ApiPropertyOptional({ description: 'Fine-grained source, e.g. "99acres" or campaign name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subSource?: string;

  @ApiPropertyOptional({ description: 'The listing/ad the buyer enquired about' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  listingRef?: string;

  @ApiPropertyOptional({ description: 'Owning agent (team member) UUID' })
  @IsOptional()
  @IsUUID()
  assignedAgentId?: string;

  @ApiPropertyOptional({ description: 'Bridge to an existing conversation' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Bridge to an existing client record' })
  @IsOptional()
  @IsUUID()
  clientId?: string;
}

export class UpdateLeadDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  altPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  languagePref?: string;

  @ApiPropertyOptional({ description: 'Owning agent (team member) UUID' })
  @IsOptional()
  @IsUUID()
  assignedAgentId?: string;
}

// ─────────────────────────────────────────────
// BLTC QUALIFICATION
// ─────────────────────────────────────────────

/**
 * Partial BLTC update. Only the slots present are merged. By default a slot
 * that already holds a value is NOT overwritten — the mismatch is returned as
 * a contradiction for the broker to resolve. Set `force: true` to overwrite.
 */
export class BltcUpdateDto {
  @ApiPropertyOptional({ description: 'Budget floor in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  budgetMinPaise?: number;

  @ApiPropertyOptional({ description: 'Budget ceiling in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  budgetMaxPaise?: number;

  @ApiPropertyOptional({ description: 'Preferred localities', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  localities?: string[];

  @ApiPropertyOptional({ description: 'Purchase horizon in months' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  timelineMonths?: number;

  @ApiPropertyOptional({ description: 'Unit configuration, e.g. "2BHK"' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  config?: string;

  @ApiPropertyOptional({ enum: LeadPurpose })
  @IsOptional()
  @IsEnum(LeadPurpose)
  purpose?: LeadPurpose;

  @ApiPropertyOptional({ enum: FinancingStatus })
  @IsOptional()
  @IsEnum(FinancingStatus)
  financing?: FinancingStatus;

  @ApiPropertyOptional({ description: 'Number of buyer turns so far (engagement signal)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  engagementTurns?: number;

  @ApiPropertyOptional({ description: 'Overwrite already-filled slots instead of flagging contradictions', default: false })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

// ─────────────────────────────────────────────
// STAGE / MEMORY / ASSIGNMENT / OPT-OUT
// ─────────────────────────────────────────────

export class TransitionStageDto {
  @ApiProperty({ enum: LeadStage })
  @IsEnum(LeadStage)
  stage!: LeadStage;

  @ApiPropertyOptional({ description: 'Optional note recorded with the transition' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CaptureMemoryDto {
  @ApiPropertyOptional({ description: 'Extracted facts, e.g. "wife wants east-facing"', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  facts?: string[];

  @ApiPropertyOptional({ description: 'Objections raised', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  objections?: string[];

  @ApiPropertyOptional({ description: 'Promises made to the buyer', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  promises?: string[];

  @ApiPropertyOptional({ description: 'Source message id for provenance' })
  @IsOptional()
  @IsString()
  messageId?: string;
}

export class AssignAgentDto {
  @ApiProperty({ description: 'Team member UUID to own the lead' })
  @IsUUID()
  agentId!: string;
}

// ─────────────────────────────────────────────
// QUERY
// ─────────────────────────────────────────────

export class ListLeadsQueryDto {
  @ApiPropertyOptional({ enum: LeadStage })
  @IsOptional()
  @IsEnum(LeadStage)
  stage?: LeadStage;

  @ApiPropertyOptional({ enum: LeadTemperature })
  @IsOptional()
  @IsEnum(LeadTemperature)
  temperature?: LeadTemperature;

  @ApiPropertyOptional({ enum: LeadSource })
  @IsOptional()
  @IsEnum(LeadSource)
  source?: LeadSource;

  @ApiPropertyOptional({ description: 'Filter by owning agent UUID' })
  @IsOptional()
  @IsUUID()
  assignedAgentId?: string;

  @ApiPropertyOptional({ description: 'Search name / phone / email' })
  @IsOptional()
  @IsString()
  search?: string;

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
