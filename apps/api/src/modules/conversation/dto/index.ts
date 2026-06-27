import {
  IsEnum,
  IsUUID,
  IsOptional,
  IsInt,
  Min,
  Max,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChannelType, ConversationStatus } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Query / Command DTOs
// ─────────────────────────────────────────────

/**
 * Query parameters for listing conversations with optional filters.
 */
export class ListConversationsQueryDto {
  @ApiPropertyOptional({ enum: ConversationStatus, description: 'Filter by conversation status' })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional({ enum: ChannelType, description: 'Filter by channel type' })
  @IsOptional()
  @IsEnum(ChannelType)
  channel?: ChannelType;

  @ApiPropertyOptional({ description: 'Filter by assigned team member UUID' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

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
}

/**
 * DTO for updating a conversation's status.
 */
export class UpdateConversationStatusDto {
  @ApiProperty({ enum: ConversationStatus, description: 'The new status for the conversation' })
  @IsEnum(ConversationStatus)
  @IsNotEmpty()
  newStatus!: ConversationStatus;

  @ApiPropertyOptional({ description: 'UUID of the actor triggering the status change' })
  @IsOptional()
  @IsUUID()
  actorId?: string;
}

/**
 * DTO for assigning a conversation to a team member.
 */
export class AssignConversationDto {
  @ApiProperty({ description: 'UUID of the team member to assign' })
  @IsUUID()
  @IsNotEmpty()
  assigneeId!: string;
}

// ─────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────

/**
 * Nested client summary in conversation responses.
 */
export class ConversationClientDto {
  @ApiProperty() id!: string;
  @ApiPropertyOptional() name?: string | null;
  @ApiPropertyOptional() phone?: string | null;
  @ApiPropertyOptional() email?: string | null;
}

/**
 * Nested channel account summary in conversation responses.
 */
export class ConversationChannelAccountDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ChannelType }) channel!: ChannelType;
}

/**
 * Full conversation response DTO returned by GET endpoints.
 */
export class ConversationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() business_id!: string;
  @ApiProperty() client_id!: string;
  @ApiProperty() channel_account_id!: string;
  @ApiProperty({ enum: ChannelType }) channel!: ChannelType;
  @ApiProperty({ enum: ConversationStatus }) status!: ConversationStatus;

  @ApiPropertyOptional() current_intent?: string | null;
  @ApiPropertyOptional() intent_confidence?: number | null;
  @ApiPropertyOptional() current_topic?: string | null;

  @ApiPropertyOptional() assigned_to?: string | null;
  @ApiPropertyOptional() subject?: string | null;
  @ApiPropertyOptional() external_thread_id?: string | null;

  @ApiPropertyOptional() first_message_at?: Date | null;
  @ApiPropertyOptional() last_message_at?: Date | null;
  @ApiPropertyOptional() resolved_at?: Date | null;
  @ApiPropertyOptional() snoozed_until?: Date | null;

  @ApiProperty() message_count!: number;
  @ApiProperty() unread_count!: number;
  @ApiProperty() human_message_count!: number;

  @ApiPropertyOptional() csat_score?: number | null;
  @ApiPropertyOptional() csat_submitted_at?: Date | null;

  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty() metadata!: Record<string, unknown>;

  @ApiProperty() created_at!: Date;
  @ApiProperty() updated_at!: Date;

  @ApiPropertyOptional({ type: ConversationClientDto })
  client?: ConversationClientDto | null;

  @ApiPropertyOptional({ type: ConversationChannelAccountDto })
  channelAccount?: ConversationChannelAccountDto | null;
}

/**
 * Message summary used in conversation context responses.
 */
export class ContextMessageDto {
  @ApiProperty() id!: string;
  @ApiProperty() direction!: string;
  @ApiProperty() type!: string;
  @ApiProperty() sender_type!: string;
  @ApiPropertyOptional() sender_id?: string | null;
  @ApiProperty() content!: Record<string, unknown>;
  @ApiPropertyOptional() text_content?: string | null;
  @ApiProperty() created_at!: Date;
}

/**
 * Conversation context response — includes conversation, recent messages,
 * and client profile. Used by the AI engine to build prompts.
 */
export class ConversationContextResponseDto {
  @ApiProperty({ type: ConversationResponseDto })
  conversation!: ConversationResponseDto;

  @ApiProperty({ type: [ContextMessageDto] })
  messages!: ContextMessageDto[];

  @ApiPropertyOptional({ type: ConversationClientDto })
  client?: ConversationClientDto | null;
}
