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
  IsIn,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAGE_NUMBER, MAX_ROW_OFFSET } from '../../../common/validators/pagination.constants';
import { ChannelType } from '@gosumo/shared';
import { ContactMergeStrategy } from '@gosumo/database';
import { SEARCH_TERM_MAX_LENGTH } from '../../../common/validators/search-term.constants';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/**
 * The longest window a day-based segment criterion may name.
 *
 * Ten years, which is longer than any tenant's history and short enough that a
 * mistyped value cannot turn into a date arithmetic overflow. The bound exists
 * because these numbers are turned into `Date` objects — an unbounded one
 * produces an Invalid Date, and every comparison against it silently returns
 * false, so an over-large window reads as an empty segment rather than an error.
 */
export const SEGMENT_MAX_WINDOW_DAYS = 3650;

/** Mirrors the `SegmentRoutingMode` Prisma enum. */
export const SEGMENT_ROUTING_MODES = ['INHERIT', 'AI_ONLY', 'AI_FIRST', 'HUMAN_ONLY'] as const;

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

  // ── Purchase history ──────────────────────────

  @ApiPropertyOptional({ description: 'At least this many lifetime orders' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minTotalOrders?: number;

  @ApiPropertyOptional({ description: 'At most this many lifetime orders' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxTotalOrders?: number;

  @ApiPropertyOptional({ description: 'Minimum lifetime spend, in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minTotalSpentPaise?: number;

  @ApiPropertyOptional({ description: 'Maximum lifetime spend, in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxTotalSpentPaise?: number;

  // ── Behaviour ─────────────────────────────────

  @ApiPropertyOptional({ description: 'Interacted within the last N days' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(SEGMENT_MAX_WINDOW_DAYS)
  activeWithinDays?: number;

  @ApiPropertyOptional({
    description: 'No interaction for at least N days (contacts who never interacted qualify)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(SEGMENT_MAX_WINDOW_DAYS)
  inactiveForDays?: number;

  @ApiPropertyOptional({ description: 'Has ever opened a conversation' })
  @IsOptional()
  @IsBoolean()
  hasConversations?: boolean;

  @ApiPropertyOptional({ description: 'First seen within the last N days' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(SEGMENT_MAX_WINDOW_DAYS)
  newerThanDays?: number;

  @ApiPropertyOptional({ description: 'First seen more than N days ago' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(SEGMENT_MAX_WINDOW_DAYS)
  olderThanDays?: number;
}

/**
 * Routing rules attached to a segment: whether the AI may answer the contacts
 * it matches, and on what terms.
 */
export class SegmentRoutingDto {
  @ApiPropertyOptional({
    enum: SEGMENT_ROUTING_MODES,
    description:
      'INHERIT (default) leaves the decision to the tenant thresholds; HUMAN_ONLY escalates ' +
      'every turn from a matching contact regardless of AI confidence.',
  })
  @IsOptional()
  @IsIn(SEGMENT_ROUTING_MODES)
  mode?: (typeof SEGMENT_ROUTING_MODES)[number];

  @ApiPropertyOptional({
    description: 'Tie-break when a contact matches several routing segments — higher wins',
    minimum: 0,
    maximum: 1000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  priority?: number;

  @ApiPropertyOptional({
    description: 'Per-segment auto-execute confidence band (0-100). Null clears it.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(100)
  autoExecuteThreshold?: number | null;

  @ApiPropertyOptional({
    description: 'Per-segment draft-review confidence band (0-100). Null clears it.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(100)
  draftReviewThreshold?: number | null;

  @ApiPropertyOptional({ description: 'Team member matching conversations belong to. Null clears it.' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  assigneeId?: string | null;
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

  @ApiPropertyOptional({ type: SegmentRoutingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SegmentRoutingDto)
  routing?: SegmentRoutingDto;
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

  @ApiPropertyOptional({ type: SegmentRoutingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SegmentRoutingDto)
  routing?: SegmentRoutingDto;
}

export class SegmentMembersQueryDto {
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

export interface SegmentResponseDto {
  id: string;
  name: string;
  description: string | null;
  filter: SegmentFilterDto;
  isActive: boolean;
  memberCount: number;
  routing: {
    mode: (typeof SEGMENT_ROUTING_MODES)[number];
    priority: number;
    autoExecuteThreshold: number | null;
    draftReviewThreshold: number | null;
    assigneeId: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

/** What `GET /contacts/:id/routing` answers — see `SegmentRoutingService`. */
export interface ResolvedRoutingDto {
  clientId: string;
  mode: (typeof SEGMENT_ROUTING_MODES)[number];
  segmentId: string | null;
  segmentName: string | null;
  autoExecuteThreshold: number | null;
  draftReviewThreshold: number | null;
  assigneeId: string | null;
}

// ─────────────────────────────────────────────
// Merge & dedup
// ─────────────────────────────────────────────

export class FindDuplicatesQueryDto {
  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1,
    default: 0.6,
    description: 'Minimum match score. Lower surfaces more, and more false pairs.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * Explicit per-field values, used with the MANUAL strategy.
 *
 * Only the fields a merge has to choose between. Everything else on the
 * surviving row — scores, counters, timestamps — is derived by the merge
 * itself and is deliberately not settable here.
 */
export class MergeFieldOverridesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  avatar_url?: string | null;
}

export class PreviewMergeDto {
  @ApiProperty({ description: 'The contact that remains' })
  @IsUUID()
  survivorId!: string;

  @ApiProperty({ description: 'The contact that is retired' })
  @IsUUID()
  duplicateId!: string;

  @ApiPropertyOptional({
    enum: ContactMergeStrategy,
    default: ContactMergeStrategy.PREFER_SURVIVOR,
  })
  @IsOptional()
  @IsEnum(ContactMergeStrategy)
  strategy?: ContactMergeStrategy;

  @ApiPropertyOptional({ type: MergeFieldOverridesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MergeFieldOverridesDto)
  fields?: MergeFieldOverridesDto;
}

export class MergeContactsDto extends PreviewMergeDto {}

export class ListMergesQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_ROW_OFFSET, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_ROW_OFFSET)
  offset?: number;
}
