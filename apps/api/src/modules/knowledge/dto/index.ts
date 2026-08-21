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
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KnowledgeArticleStatus } from '@gosumo/database';
import { IntentType } from '@gosumo/shared';

import { MAX_PAGE_NUMBER, MAX_PAGE_SIZE } from '../../../common/validators/pagination.constants';
import { SEARCH_TERM_MAX_LENGTH } from '../../../common/validators/search-term.constants';
import {
  MAX_ARTICLE_BODY_LENGTH,
  MAX_ARTICLE_KEYWORDS,
  MAX_ARTICLE_SUMMARY_LENGTH,
  MAX_ARTICLE_TAGS,
  MAX_AI_ARTICLES,
} from '../knowledge.constants';

// ─────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────

export class CreateKnowledgeArticleDto {
  @ApiProperty({ description: 'Article title. The slug is derived from it.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiProperty({ description: 'Full article text, shown to operators' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ARTICLE_BODY_LENGTH)
  body!: string;

  @ApiPropertyOptional({
    description:
      'The short answer the AI quotes. Falls back to a truncated body when omitted.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ARTICLE_SUMMARY_LENGTH)
  summary?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(MAX_ARTICLE_TAGS)
  @MaxLength(50, { each: true })
  tags?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Extra search terms customers might type that the body does not contain',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(MAX_ARTICLE_KEYWORDS)
  @MaxLength(80, { each: true })
  keywords?: string[];

  @ApiPropertyOptional({
    enum: IntentType,
    isArray: true,
    description: 'Restrict AI grounding to these intents. Empty means every intent.',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(IntentType, { each: true })
  @ArrayMaxSize(MAX_ARTICLE_TAGS)
  applicableIntents?: IntentType[];

  @ApiPropertyOptional({ enum: KnowledgeArticleStatus, default: KnowledgeArticleStatus.DRAFT })
  @IsOptional()
  @IsEnum(KnowledgeArticleStatus)
  status?: KnowledgeArticleStatus;

  @ApiPropertyOptional({
    default: true,
    description: 'Whether the AI may quote this article. Independent of `status`.',
  })
  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;
}

export class UpdateKnowledgeArticleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ARTICLE_BODY_LENGTH)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ARTICLE_SUMMARY_LENGTH)
  summary?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(MAX_ARTICLE_TAGS)
  @MaxLength(50, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(MAX_ARTICLE_KEYWORDS)
  @MaxLength(80, { each: true })
  keywords?: string[];

  @ApiPropertyOptional({ enum: IntentType, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(IntentType, { each: true })
  @ArrayMaxSize(MAX_ARTICLE_TAGS)
  applicableIntents?: IntentType[];

  @ApiPropertyOptional({ enum: KnowledgeArticleStatus })
  @IsOptional()
  @IsEnum(KnowledgeArticleStatus)
  status?: KnowledgeArticleStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean;
}

// ─────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────

export class ListKnowledgeArticlesQueryDto {
  @ApiPropertyOptional({ description: 'Full-text search over title, keywords, summary and body' })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_TERM_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  tag?: string;

  @ApiPropertyOptional({ enum: KnowledgeArticleStatus })
  @IsOptional()
  @IsEnum(KnowledgeArticleStatus)
  status?: KnowledgeArticleStatus;

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

export class SearchKnowledgeArticlesQueryDto {
  @ApiProperty({ description: 'Free-text query' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(SEARCH_TERM_MAX_LENGTH)
  q!: string;

  @ApiPropertyOptional({ default: MAX_AI_ARTICLES, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({
    enum: IntentType,
    description: 'Restrict to articles applicable to this intent',
  })
  @IsOptional()
  @IsEnum(IntentType)
  intent?: IntentType;
}

// ─────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────

export class KnowledgeArticleDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ nullable: true }) summary!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty({ nullable: true }) category!: string | null;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ type: [String] }) keywords!: string[];
  @ApiProperty({ type: [String] }) applicableIntents!: string[];
  @ApiProperty({ enum: KnowledgeArticleStatus }) status!: KnowledgeArticleStatus;
  @ApiProperty() aiEnabled!: boolean;
  @ApiProperty() useCount!: number;
  @ApiProperty({ nullable: true }) publishedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedKnowledgeArticlesDto {
  @ApiProperty({ type: [KnowledgeArticleDto] }) data!: KnowledgeArticleDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() totalPages!: number;
}

/** One search hit: the article plus the excerpt that would ground a prompt. */
export class KnowledgeSearchHitDto {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ description: 'Summary, or a truncated body when no summary is set' })
  excerpt!: string;
  @ApiProperty({ nullable: true }) category!: string | null;
  @ApiProperty({ description: 'Postgres ts_rank_cd score' }) score!: number;
}

export class KnowledgeStatsDto {
  @ApiProperty() total!: number;
  @ApiProperty() published!: number;
  @ApiProperty() draft!: number;
  @ApiProperty() archived!: number;
  @ApiProperty({ description: 'PUBLISHED articles the AI is allowed to quote' })
  aiEnabled!: number;
  @ApiProperty({ description: 'Total retrievals across all articles' })
  totalUses!: number;
  @ApiProperty({ type: [String] }) categories!: string[];
}
