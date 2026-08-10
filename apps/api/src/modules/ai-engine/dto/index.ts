import {
  IsString,
  IsUUID,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsInt,
  IsNotEmpty,
  IsArray,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IntentType, ConfidenceMode } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Command / Query DTOs
// ─────────────────────────────────────────────

/** Input for processing a message through the AI pipeline. */
export class ProcessMessageDto {
  @ApiProperty({ description: 'UUID of the conversation the message belongs to' })
  @IsUUID()
  conversationId!: string;

  @ApiProperty({ description: 'UUID of the inbound message to process' })
  @IsUUID()
  messageId!: string;

  @ApiPropertyOptional({
    description: 'Force the full-escalation path regardless of confidence',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  forceEscalate?: boolean;

  @ApiPropertyOptional({ description: 'Correlation ID for distributed tracing' })
  @IsOptional()
  @IsString()
  correlationId?: string;
}

/** Input for standalone intent classification. */
export class ClassifyIntentDto {
  @ApiProperty({ description: 'Raw message text to classify' })
  @IsString()
  @IsNotEmpty()
  text!: string;
}

/** Query parameters for listing AI decisions on a conversation. */
export class ListDecisionsQueryDto {
  @ApiProperty({ description: 'UUID of the conversation to list decisions for' })
  @IsUUID()
  conversationId!: string;

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
// Intent classification
// ─────────────────────────────────────────────

/** An alternative intent candidate with its confidence. */
export class IntentAlternativeDto {
  @ApiProperty({ enum: IntentType, description: 'Alternative intent type' })
  intent!: IntentType;

  @ApiProperty({ description: 'Confidence for this alternative (0.0-1.0)' })
  confidence!: number;
}

/** Result of intent classification. */
export class IntentClassificationDto {
  @ApiProperty({ enum: IntentType, description: 'Primary classified intent' })
  intent!: IntentType;

  @ApiPropertyOptional({ enum: IntentType, description: 'Secondary intent for compound messages' })
  secondaryIntent?: IntentType | null;

  @ApiProperty({ description: 'Confidence in the primary intent (0.0-1.0)' })
  confidence!: number;

  @ApiProperty({ description: 'Cascade tier that resolved it (1=rules, 2=embeddings, 3=LLM)' })
  tier!: 1 | 2 | 3;

  @ApiProperty({ description: 'Named entities extracted from the message' })
  entities!: Record<string, unknown>;

  @ApiProperty({ description: 'One-sentence rationale for the classification' })
  reasoning!: string;

  @ApiPropertyOptional({ type: [IntentAlternativeDto], description: 'Alternative intents considered' })
  alternatives?: IntentAlternativeDto[];
}

// ─────────────────────────────────────────────
// Confidence scoring
// ─────────────────────────────────────────────

/** Explicit factors for standalone confidence scoring / threshold testing. */
export class ConfidenceScoringInputDto {
  @ApiProperty({ enum: IntentType })
  @IsEnum(IntentType)
  intent!: IntentType;

  @ApiProperty({ description: 'How many high-quality RAG chunks were retrieved' })
  @IsInt()
  @Min(0)
  ragChunkCount!: number;

  @ApiPropertyOptional({ description: 'A catalog item with a concrete price was matched' })
  @IsOptional()
  @IsBoolean()
  catalogMatch?: boolean;

  @ApiPropertyOptional({ description: 'The client has a known profile (not first contact)' })
  @IsOptional()
  @IsBoolean()
  clientKnown?: boolean;

  @ApiPropertyOptional({ description: 'An explicit business policy covers this situation' })
  @IsOptional()
  @IsBoolean()
  policyDefined?: boolean;

  @ApiPropertyOptional({ description: 'The applicable policy is ambiguous for this case' })
  @IsOptional()
  @IsBoolean()
  policyAmbiguous?: boolean;

  @ApiPropertyOptional({ description: 'Raw customer text, used to evaluate hard overrides' })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({ description: 'Refund amount requested (paise), if any' })
  @IsOptional()
  @IsInt()
  @Min(0)
  refundAmountPaise?: number;

  @ApiPropertyOptional({ description: 'Configured max auto-refund (paise)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxRefundAmountPaise?: number;

  @ApiPropertyOptional({ description: 'Sentiment score in range -1..1' })
  @IsOptional()
  @IsNumber()
  sentimentScore?: number;

  @ApiPropertyOptional({ description: 'Consecutive inbound exchanges with an unchanged intent' })
  @IsOptional()
  @IsInt()
  repeatedIntentCount?: number;
}

/** A single confidence override that penalised the score. */
export class ConfidenceOverrideDto {
  @ApiProperty({ description: 'Machine-readable override code' })
  code!: string;

  @ApiProperty({ description: 'Human-readable reason for the override' })
  reason!: string;

  @ApiProperty({ description: 'Score penalty applied (0.0-1.0)' })
  penalty!: number;
}

/** Confidence score breakdown returned by the AI engine (0.0–1.0 scale). */
export class ConfidenceScoreDto {
  @ApiProperty({ description: 'Final composite confidence (0.0-1.0)' })
  finalScore!: number;

  @ApiProperty({ enum: ConfidenceMode, description: 'Routing band determined by the final score' })
  mode!: ConfidenceMode;

  @ApiProperty({ description: 'Data availability factor (0.0-1.0)' })
  dataAvailability!: number;

  @ApiProperty({ description: 'Policy clarity factor (0.0-1.0)' })
  policyClarity!: number;

  @ApiProperty({ type: [ConfidenceOverrideDto], description: 'Hard overrides that penalised the score' })
  overrides!: ConfidenceOverrideDto[];

  @ApiProperty({ description: 'Whether a hard override forces human escalation' })
  requiresEscalation!: boolean;
}

// ─────────────────────────────────────────────
// Knowledge base
// ─────────────────────────────────────────────

export class IngestKnowledgeDto {
  @ApiProperty({ description: 'Raw document text to chunk, embed, and index' })
  @IsString()
  @IsNotEmpty()
  content!: string;

  @ApiProperty({ description: 'Source type, e.g. REFUND_POLICY, FAQ_ENTRY, PRICING_GUIDE' })
  @IsString()
  sourceType!: string;

  @ApiPropertyOptional({ description: 'Human-readable title' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ description: 'Free-form tags for filtering' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: IntentType, isArray: true, description: 'Intents this document is relevant to' })
  @IsOptional()
  @IsArray()
  @IsEnum(IntentType, { each: true })
  applicableIntents?: IntentType[];
}

export class IngestResultDto {
  @ApiProperty() entryId!: string;
  @ApiProperty() chunksIndexed!: number;
  @ApiProperty() collection!: string;
}

export class SearchKnowledgeQueryDto {
  @ApiProperty({ description: 'Search query text' })
  @IsString()
  @IsNotEmpty()
  q!: string;

  @ApiPropertyOptional({ description: 'Max results', default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number = 5;
}

export class KnowledgeEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() content!: string;
  @ApiProperty() similarity!: number;
  @ApiProperty() sourceType!: string;
  @ApiProperty({ type: [String] }) tags!: string[];
}

export class RegenerateDraftDto {
  @ApiPropertyOptional({ description: 'Reviewer feedback to steer regeneration' })
  @IsOptional()
  @IsString()
  feedback?: string;
}

// ─────────────────────────────────────────────
// AI decision response
// ─────────────────────────────────────────────

/** A suggested action the AI recommends executing. */
export class SuggestedActionDto {
  @ApiProperty({ description: 'Action type understood by the action executor' })
  type!: string;

  @ApiProperty({ description: 'Action-specific parameters' })
  parameters!: Record<string, unknown>;

  @ApiProperty({ description: 'Confidence in this specific action (0.0-1.0)' })
  confidence!: number;
}

/** Full AI decision response returned by the pipeline. */
export class AIDecisionDto {
  @ApiProperty({ description: 'Decision record UUID' })
  id!: string;

  @ApiProperty({ description: 'Conversation UUID' })
  conversationId!: string;

  @ApiPropertyOptional({ description: 'Message UUID that triggered this decision' })
  messageId!: string | null;

  @ApiProperty({ description: 'AI decision type (e.g. SEND_MESSAGE, ESCALATE)' })
  type!: string;

  @ApiProperty({ description: 'Decision outcome (e.g. AUTO_EXECUTED, SENT_FOR_REVIEW, ESCALATED)' })
  outcome!: string;

  @ApiProperty({ enum: IntentType, description: 'Classified intent' })
  intent!: IntentType;

  @ApiPropertyOptional({ description: 'Generated response text for the client' })
  responseText!: string | null;

  @ApiProperty({ type: ConfidenceScoreDto, description: 'Full confidence score breakdown' })
  confidence!: ConfidenceScoreDto;

  @ApiProperty({ type: [SuggestedActionDto], description: 'Actions the AI recommends executing' })
  suggestedActions!: SuggestedActionDto[];

  @ApiProperty({ description: 'Chain-of-thought reasoning' })
  reasoning!: string;

  @ApiPropertyOptional({ description: 'HITL task created for this decision (if any)' })
  taskId!: string | null;

  @ApiPropertyOptional({ description: 'Holding message sent to the customer (if escalated)' })
  holdingMessage!: string | null;

  @ApiPropertyOptional({ description: 'LLM model version used' })
  modelId!: string | null;

  @ApiPropertyOptional({ description: 'Prompt token count for cost tracking' })
  promptTokens!: number | null;

  @ApiPropertyOptional({ description: 'Completion token count for cost tracking' })
  completionTokens!: number | null;

  @ApiPropertyOptional({ description: 'End-to-end latency in milliseconds' })
  latencyMs!: number | null;

  @ApiProperty({ description: 'Timestamp when the decision was made' })
  decidedAt!: Date;

  @ApiPropertyOptional({ description: 'Timestamp when the decision was executed (null if pending)' })
  executedAt!: Date | null;
}

/**
 * Confidence-threshold update.
 *
 * These two numbers are the human-in-the-loop safety gate described in
 * CLAUDE.md: at or above `autoExecute` the AI acts on its own, between
 * `draftReview` and `autoExecute` a human approves the draft, and below
 * `draftReview` the conversation escalates. The endpoint previously took an
 * inline `{ autoExecute?: number; draftReview?: number }`, which the global
 * ValidationPipe cannot whitelist or bound — so any number was writable,
 * including a zero or negative `autoExecute` that makes every AI decision
 * auto-execute and silently removes human review from the whole tenant.
 */
export class UpdateConfidenceThresholdsDto {
  @ApiPropertyOptional({
    description: 'Confidence at or above which the AI acts without review (percent)',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  autoExecute?: number;

  @ApiPropertyOptional({
    description: 'Confidence at or above which the AI drafts for human review (percent)',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  draftReview?: number;
}
