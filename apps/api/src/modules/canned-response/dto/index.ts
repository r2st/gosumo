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
  Matches,
  ArrayMaxSize,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAGE_NUMBER } from '../../../common/validators/pagination.constants';
import { ChannelType } from '@gosumo/shared';
import { SEARCH_TERM_MAX_LENGTH } from '../../../common/validators/search-term.constants';
import { CannedResponseApprovalStatus } from '@gosumo/database';
import { ValidateNested, IsObject } from 'class-validator';
import type { TemplateVariableSpec } from '../template-variables.util';

const SHORTCUT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/**
 * Caller-supplied metadata for one `{{ variable }}`.
 *
 * Metadata only — the set of variables comes from the body. A spec naming a
 * variable the content does not contain is dropped on write, so this cannot
 * declare a placeholder into existence.
 */
export class TemplateVariableDto {
  @ApiProperty({ description: 'The name between the braces, e.g. "customerName"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Human label for the insert dialog' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Required variables block rendering when unsupplied',
  })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ description: 'Used when the agent supplies nothing' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  defaultValue?: string;
}

export class CreateCannedResponseDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiProperty({ description: 'Slash-command style trigger, e.g. "refund-policy"' })
  @IsString()
  @Matches(SHORTCUT_PATTERN, {
    message: 'shortcut must be lowercase alphanumeric with hyphens, e.g. "refund-policy"',
  })
  @MaxLength(100)
  shortcut!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  content!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ enum: ChannelType, description: 'Omit to allow every channel' })
  @IsOptional()
  @IsEnum(ChannelType)
  channel?: ChannelType;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [TemplateVariableDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateVariableDto)
  @ArrayMaxSize(50)
  variables?: TemplateVariableDto[];
}

export class UpdateCannedResponseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ enum: ChannelType })
  @IsOptional()
  @IsEnum(ChannelType)
  channel?: ChannelType;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [TemplateVariableDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateVariableDto)
  @ArrayMaxSize(50)
  variables?: TemplateVariableDto[];
}

export class ListCannedResponsesQueryDto {
  @ApiPropertyOptional({ description: 'Free-text search across title, content, shortcut' })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_TERM_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ enum: ChannelType })
  @IsOptional()
  @IsEnum(ChannelType)
  channel?: ChannelType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    enum: CannedResponseApprovalStatus,
    description: 'Filter by review state — PENDING is the reviewer’s queue',
  })
  @IsOptional()
  @IsEnum(CannedResponseApprovalStatus)
  approvalStatus?: CannedResponseApprovalStatus;

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

export class RecordUsageDto {
  @ApiPropertyOptional({ description: 'Conversation the canned response was used in' })
  @IsOptional()
  @IsString()
  conversationId?: string;
}

export interface CannedResponseDto {
  id: string;
  title: string;
  shortcut: string;
  content: string;
  category: string | null;
  channel: ChannelType | null;
  tags: string[];
  isActive: boolean;
  usageCount: number;
  createdBy: string | null;
  variables: TemplateVariableSpec[];
  approvalStatus: CannedResponseApprovalStatus;
  submittedBy: string | null;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedCannedResponsesDto {
  data: CannedResponseDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}


/** Values an agent supplies when inserting a template. */
export class RenderTemplateDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Variable name → value',
  })
  @IsOptional()
  @IsObject()
  values?: Record<string, string>;
}

/** Reviewer's verdict. */
export class ReviewTemplateDto {
  @ApiPropertyOptional({ description: 'Optional note on an approval; required on a rejection' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
