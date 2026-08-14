import {
  IsOptional,
  IsString,
  IsEnum,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  Min,
  Max,
  MaxLength,
  ArrayMaxSize,
  ArrayNotEmpty,
  IsNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChannelType } from '@gosumo/shared';
import { SEARCH_TERM_MAX_LENGTH } from '../../../common/validators/search-term.constants';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Accepts a comma-separated string or a repeated query param as a string[]. */
function toStringArray({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return value;
}

// ─────────────────────────────────────────────
// Contacts
// ─────────────────────────────────────────────

export class ListContactsQueryDto {
  @ApiPropertyOptional({ description: 'Free-text search across name, email, phone' })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_TERM_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional({ description: 'Match contacts with any of these tags', type: [String] })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: ChannelType })
  @IsOptional()
  @IsEnum(ChannelType)
  channel?: ChannelType;

  @ApiPropertyOptional({ description: 'Minimum lifetime value score' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minLtv?: number;

  @ApiPropertyOptional({ description: 'Maximum churn-risk score (0-1)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  maxChurnRisk?: number;

  @ApiPropertyOptional({ description: 'Minimum engagement score (0-1)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  minEngagement?: number;

  @ApiPropertyOptional({ description: 'Only contacts with (or without) at least one order' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  hasOrders?: boolean;

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

export class UpdateContactDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ description: 'E.164 format' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}

export class TagsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  tags!: string[];
}

export interface ContactResponseDto {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  tags: string[];
  ltvScore: number | null;
  churnRisk: number | null;
  engagementScore: number | null;
  totalOrders: number;
  totalSpentPaise: number;
  lastInteractionAt: string | null;
  firstSeenAt: string;
  createdAt: string;
}

export interface PaginatedContactsDto {
  data: ContactResponseDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ─────────────────────────────────────────────
// Segments
// ─────────────────────────────────────────────

export class SegmentFilterDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: ChannelType, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(ChannelType, { each: true })
  channels?: ChannelType[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  minLtv?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  maxChurnRisk?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  minEngagement?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hasOrders?: boolean;
}

export class CreateSegmentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ type: SegmentFilterDto })
  @ValidateNested()
  @Type(() => SegmentFilterDto)
  filter!: SegmentFilterDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSegmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ type: SegmentFilterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SegmentFilterDto)
  filter?: SegmentFilterDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SegmentMembersQueryDto {
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

export interface SegmentResponseDto {
  id: string;
  name: string;
  description: string | null;
  filter: SegmentFilterDto;
  isActive: boolean;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}
