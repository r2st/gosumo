import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  IsNumber,
  IsArray,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChannelType } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Churn risk level enum (application layer)
// ─────────────────────────────────────────────

export enum ChurnRiskLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

// ─────────────────────────────────────────────
// Client segment enum (application layer)
// ─────────────────────────────────────────────

/**
 * Behavioural segment a client falls into, derived from RFM + recency.
 * Precedence (highest first): LOST → VIP → AT_RISK → DORMANT → NEW → ACTIVE.
 */
export enum ClientSegment {
  /** Recently acquired (tenure <= 30 days, <= 1 order). */
  NEW = 'NEW',
  /** High value (>= 10 orders or >= ₹50k spent) and still active. */
  VIP = 'VIP',
  /** Has ordered before but churn risk is HIGH/CRITICAL. */
  AT_RISK = 'AT_RISK',
  /** No interaction for 60–180 days. */
  DORMANT = 'DORMANT',
  /** No interaction for over 180 days. */
  LOST = 'LOST',
  /** Engaged client with orders, no risk flags — the default. */
  ACTIVE = 'ACTIVE',
}

// ─────────────────────────────────────────────
// Timeline event kinds
// ─────────────────────────────────────────────

export enum TimelineEventType {
  CONVERSATION = 'CONVERSATION',
  ORDER = 'ORDER',
  BOOKING = 'BOOKING',
  PAYMENT = 'PAYMENT',
}

// ─────────────────────────────────────────────
// Command DTOs
// ─────────────────────────────────────────────

/**
 * DTO for finding or creating a client by external ID and channel type.
 */
export class FindOrCreateClientDto {
  @ApiProperty({ description: 'Channel-specific external ID (phone, IG user ID, email, etc.)' })
  @IsString()
  @IsNotEmpty()
  externalId!: string;

  @ApiProperty({ enum: ChannelType, description: 'Channel type for this contact' })
  @IsEnum(ChannelType)
  channelType!: ChannelType;

  @ApiProperty({ description: 'Channel account ID this contact belongs to' })
  @IsUUID()
  channelAccountId!: string;

  @ApiPropertyOptional({ description: 'Client display name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'Client phone number (E.164)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: 'Client email address' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;
}

/**
 * DTO for updating a client profile.
 */
export class UpdateClientProfileDto {
  @ApiPropertyOptional({ description: 'Client display name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'Client email address' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ description: 'Client phone number (E.164)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: 'Avatar URL' })
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiPropertyOptional({ description: 'Additional profile metadata' })
  @IsOptional()
  profile?: Record<string, unknown>;
}

/**
 * DTO for merging two client records.
 */
export class MergeClientsDto {
  @ApiProperty({ description: 'UUID of the primary client (survives the merge)' })
  @IsUUID()
  primaryId!: string;

  @ApiProperty({ description: 'UUID of the secondary client (will be soft-deleted)' })
  @IsUUID()
  secondaryId!: string;
}

// ─────────────────────────────────────────────
// Query DTOs
// ─────────────────────────────────────────────

/**
 * Query parameters for listing clients with optional filters and pagination.
 */
export class ListClientsQueryDto {
  @ApiPropertyOptional({ description: 'Search across name, email, phone' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ChannelType, description: 'Filter by channel type' })
  @IsOptional()
  @IsEnum(ChannelType)
  channelType?: ChannelType;

  @ApiPropertyOptional({ enum: ChurnRiskLevel, description: 'Filter by churn risk level' })
  @IsOptional()
  @IsEnum(ChurnRiskLevel)
  churnRisk?: ChurnRiskLevel;

  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Include related data' })
  @IsOptional()
  @IsString()
  include?: string;

  @ApiPropertyOptional({ description: 'Filter by tags' })
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : value ? [value] : undefined))
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: ChurnRiskLevel })
  @IsOptional()
  @IsEnum(ChurnRiskLevel)
  churnRiskLevel?: ChurnRiskLevel;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  hasOrders?: boolean;

  @ApiPropertyOptional({ description: 'Search query' })
  @IsOptional()
  @IsString()
  q?: string;
}

/**
 * Query parameters for the client timeline endpoint.
 */
export class TimelineQueryDto {
  @ApiPropertyOptional({ description: 'Max number of timeline events to return', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;
}

/**
 * Query parameters for sentiment trend endpoint.
 */
export class SentimentTrendQueryDto {
  @ApiPropertyOptional({ description: 'Number of days to look back', default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number = 30;
}

// ─────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────

/**
 * Full client profile response.
 */
export class ClientProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty() businessId!: string;
  @ApiPropertyOptional() name?: string | null;
  @ApiPropertyOptional() email?: string | null;
  @ApiPropertyOptional() phone?: string | null;
  @ApiPropertyOptional() avatarUrl?: string | null;
  @ApiProperty() profile!: Record<string, unknown>;
  @ApiProperty() optOuts!: Record<string, unknown>;
  @ApiPropertyOptional() ltvScore?: number | null;
  @ApiPropertyOptional() churnRisk?: number | null;
  @ApiPropertyOptional() engagementScore?: number | null;
  @ApiProperty() totalOrders!: number;
  @ApiProperty() totalSpent!: number;
  @ApiPropertyOptional() lastInteractionAt?: Date | null;
  @ApiProperty() firstSeenAt!: Date;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional() channelContacts?: ChannelContactDto[];
}

/**
 * Channel contact mapping response.
 */
export class ChannelContactDto {
  @ApiProperty() id!: string;
  @ApiProperty() channel!: ChannelType;
  @ApiProperty() externalId!: string;
  @ApiPropertyOptional() displayName?: string | null;
  @ApiPropertyOptional() profilePicUrl?: string | null;
  @ApiProperty() isOptedIn!: boolean;
  @ApiProperty() firstSeenAt!: Date;
  @ApiProperty() lastSeenAt!: Date;
}

/**
 * Compact AI-injectable client summary (<=300 chars).
 */
export class ClientAISummaryDto {
  @ApiProperty({ description: 'Client UUID' })
  clientId!: string;

  @ApiProperty({ description: 'Compact summary text, max 300 chars' })
  summary!: string;
}

/**
 * Single sentiment data point.
 */
export class SentimentEntryDto {
  @ApiProperty() date!: string;
  @ApiProperty() score!: number;
}

/**
 * Sentiment trend over a time period.
 */
export class SentimentTrendDto {
  @ApiProperty() clientId!: string;
  @ApiProperty() days!: number;
  @ApiProperty({ type: [SentimentEntryDto] })
  entries!: SentimentEntryDto[];
  @ApiPropertyOptional() averageScore?: number;
}

/**
 * Churn risk score with risk level classification.
 */
export class ChurnScoreDto {
  @ApiProperty({ description: 'Churn score 0-100' })
  score!: number;

  @ApiProperty({ enum: ChurnRiskLevel, description: 'Risk level classification' })
  riskLevel!: ChurnRiskLevel;
}

/**
 * Lifetime value estimate for a client.
 */
export class LTVEstimateDto {
  @ApiProperty({ description: 'Total revenue in paise' })
  totalRevenuePaise!: number;

  @ApiProperty({ description: 'Number of completed orders' })
  orderCount!: number;

  @ApiProperty({ description: 'Average order value in paise' })
  avgOrderValuePaise!: number;
}

/**
 * A single fact extracted from a client message.
 */
export class ClientFactDto {
  @ApiProperty({ description: 'Type of fact (name, location, preference, etc.)' })
  factType!: string;

  @ApiProperty({ description: 'Extracted value' })
  value!: string;

  @ApiProperty({ description: 'Confidence score 0.0-1.0' })
  confidence!: number;
}

/**
 * Behavioural segment classification for a client, with the signals behind it.
 */
export class ClientSegmentDto {
  @ApiProperty({ description: 'Client UUID' })
  clientId!: string;

  @ApiProperty({ enum: ClientSegment, description: 'Computed behavioural segment' })
  segment!: ClientSegment;

  @ApiProperty({ description: 'Human-readable reason for the classification' })
  reason!: string;

  @ApiProperty({ description: 'Days since the most recent interaction/order' })
  daysSinceLastActivity!: number;

  @ApiProperty({ description: 'Completed order count used in the decision' })
  orderCount!: number;

  @ApiProperty({ description: 'Total spent (rupees) used in the decision' })
  totalSpent!: number;

  @ApiProperty({ enum: ChurnRiskLevel, description: 'Churn risk level used in the decision' })
  churnRiskLevel!: ChurnRiskLevel;
}

/**
 * A single chronological event in a client's history.
 */
export class TimelineEventDto {
  @ApiProperty({ enum: TimelineEventType, description: 'Kind of event' })
  type!: TimelineEventType;

  @ApiProperty({ description: 'Underlying record UUID' })
  id!: string;

  @ApiProperty({ description: 'When the event occurred (ISO-8601)' })
  timestamp!: string;

  @ApiProperty({ description: 'Short human-readable label' })
  title!: string;

  @ApiProperty({ description: 'Status of the underlying record' })
  status!: string;

  @ApiPropertyOptional({ description: 'Monetary amount in paise, where applicable' })
  amountPaise?: number;

  @ApiPropertyOptional({ description: 'Channel, where applicable' })
  channel?: ChannelType;
}

/**
 * Chronological timeline of all of a client's interactions.
 */
export class ClientTimelineDto {
  @ApiProperty({ description: 'Client UUID' })
  clientId!: string;

  @ApiProperty({ type: [TimelineEventDto], description: 'Events newest-first' })
  events!: TimelineEventDto[];

  @ApiProperty({ description: 'Number of events returned' })
  total!: number;
}

// ─────────────────────────────────────────────
// Paginated result
// ─────────────────────────────────────────────

export class PaginatedClients {
  @ApiProperty({ type: [ClientProfileDto] })
  data!: ClientProfileDto[];

  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() totalPages!: number;
}
