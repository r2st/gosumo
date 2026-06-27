import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  IsBoolean,
  IsObject,
  IsArray,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaskStatus, TaskType, TaskPriority } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Command DTOs
// ─────────────────────────────────────────────

/**
 * DTO for creating a new HITL task.
 */
export class CreateTaskDto {
  @ApiProperty({ description: 'UUID of the conversation this task belongs to' })
  @IsUUID()
  conversationId!: string;

  @ApiProperty({ enum: TaskType, description: 'Type of task to create' })
  @IsEnum(TaskType)
  type!: TaskType;

  @ApiPropertyOptional({ enum: TaskPriority, description: 'Task priority level' })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiProperty({ description: 'Task title', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  @ApiPropertyOptional({ description: 'Detailed task description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'UUID of the AI decision that triggered this task' })
  @IsOptional()
  @IsUUID()
  aiDecisionId?: string;

  @ApiPropertyOptional({ description: 'AI-generated draft response JSON' })
  @IsOptional()
  @IsObject()
  draftResponse?: Record<string, unknown>;
}

/**
 * DTO for assigning a task to a team member.
 */
export class AssignTaskDto {
  @ApiProperty({ description: 'UUID of the team member to assign' })
  @IsUUID()
  @IsNotEmpty()
  assigneeId!: string;
}

/**
 * DTO for resolving a task.
 */
export class ResolveTaskDto {
  @ApiProperty({ description: 'Resolution data JSON' })
  @IsObject()
  resolution!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Optional note about the resolution' })
  @IsOptional()
  @IsString()
  note?: string;
}

/**
 * DTO for approving an AI-generated draft response.
 */
export class ApproveDraftDto {
  @ApiPropertyOptional({ description: 'Whether to send the approved draft immediately', default: true })
  @IsOptional()
  @IsBoolean()
  sendImmediately?: boolean = true;
}

/**
 * DTO for rejecting an AI-generated draft response.
 */
export class RejectDraftDto {
  @ApiProperty({ description: 'Reason for rejecting the draft' })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiPropertyOptional({ description: 'Additional feedback for the AI' })
  @IsOptional()
  @IsString()
  feedback?: string;
}

/**
 * DTO for editing an AI-generated draft response.
 */
export class EditDraftDto {
  @ApiProperty({ description: 'The edited response content' })
  @IsString()
  @IsNotEmpty()
  editedResponse!: string;
}

/**
 * DTO for sending a manual response in a conversation.
 */
export class SendManualResponseDto {
  @ApiProperty({ description: 'UUID of the conversation to respond in' })
  @IsUUID()
  conversationId!: string;

  @ApiProperty({ description: 'Polymorphic message content JSON' })
  @IsObject()
  content!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Channel type for the response' })
  @IsOptional()
  @IsString()
  channelType?: string;
}

/**
 * DTO for posting an internal note on a task.
 */
export class PostInternalNoteDto {
  @ApiProperty({ description: 'Note text content' })
  @IsString()
  @IsNotEmpty()
  text!: string;

  @ApiPropertyOptional({ description: 'UUIDs of mentioned users', type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID(4, { each: true })
  mentionedUserIds?: string[];
}

/**
 * DTO for escalating a task.
 */
export class EscalateTaskDto {
  @ApiProperty({ description: 'Reason for escalation' })
  @IsString()
  @IsNotEmpty()
  reason!: string;

  @ApiPropertyOptional({ enum: TaskPriority, description: 'New priority after escalation' })
  @IsOptional()
  @IsEnum(TaskPriority)
  newPriority?: TaskPriority;
}

// ─────────────────────────────────────────────
// Query DTOs
// ─────────────────────────────────────────────

/**
 * Query parameters for listing HITL tasks with optional filters and pagination.
 */
export class ListTasksQueryDto {
  @ApiPropertyOptional({ enum: TaskStatus, description: 'Filter by task status' })
  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @ApiPropertyOptional({ enum: TaskType, description: 'Filter by task type' })
  @IsOptional()
  @IsEnum(TaskType)
  type?: TaskType;

  @ApiPropertyOptional({ description: 'Filter by assigned team member UUID' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional({ enum: TaskPriority, description: 'Filter by task priority' })
  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @ApiPropertyOptional({ description: 'Filter by conversation UUID' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

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

// ─────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────

/**
 * Aggregate task statistics for the HITL dashboard.
 */
export class TaskStatsResponseDto {
  @ApiProperty() pending!: number;
  @ApiProperty() inProgress!: number;
  @ApiProperty() resolved!: number;
  @ApiProperty() escalated!: number;
  @ApiProperty() expired!: number;
  @ApiProperty() breached!: number;
  @ApiProperty() avgResolutionMs!: number;
}
