import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsInt,
  IsUUID,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApprovalStatus, AutonomyLevel } from '@gosumo/shared';

// ─────────────────────────────────────────────
// APPROVAL QUEUE
// ─────────────────────────────────────────────

export class CreateApprovalDto {
  @ApiProperty({ description: 'Lead the draft is for' })
  @IsUUID()
  leadId!: string;

  @ApiPropertyOptional({ description: 'Conversation the draft belongs to' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiProperty({ description: 'The AI-drafted reply awaiting review' })
  @IsString()
  @IsNotEmpty()
  draftText!: string;

  @ApiProperty({ description: '0–100 realty confidence that produced the draft' })
  @IsInt()
  @Min(0)
  @Max(100)
  confidence!: number;

  @ApiPropertyOptional({ description: 'Classified intent, for context' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  intent?: string;
}

/**
 * Resolve a queued draft. `status` must be one of APPROVED (send verbatim),
 * EDITED (send `editedText`), or REJECTED (discard).
 */
export class ResolveApprovalDto {
  @ApiProperty({ enum: [ApprovalStatus.APPROVED, ApprovalStatus.EDITED, ApprovalStatus.REJECTED] })
  @IsEnum(ApprovalStatus)
  status!: ApprovalStatus;

  @ApiPropertyOptional({ description: 'Required when status = EDITED' })
  @IsOptional()
  @IsString()
  editedText?: string;

  @ApiPropertyOptional({ description: 'Reason (useful on REJECTED)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ListApprovalsQueryDto {
  @ApiPropertyOptional({ enum: ApprovalStatus })
  @IsOptional()
  @IsEnum(ApprovalStatus)
  status?: ApprovalStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  leadId?: string;
}

// ─────────────────────────────────────────────
// ACCOUNT SETTINGS / AUTONOMY DIAL
// ─────────────────────────────────────────────

export class UpdateSettingsDto {
  @ApiPropertyOptional({ enum: AutonomyLevel })
  @IsOptional()
  @IsEnum(AutonomyLevel)
  autonomyLevel?: AutonomyLevel;

  @ApiPropertyOptional({ description: 'Confidence at/above which the AI may auto-send (0–100)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  autoApproveThreshold?: number;

  @ApiPropertyOptional({ description: 'Master off-switch for autonomous sends' })
  @IsOptional()
  @IsBoolean()
  killSwitch?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  briefingEnabled?: boolean;

  @ApiPropertyOptional({ description: 'IST hour the briefing is generated (0–23)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  briefingHour?: number;

  @ApiPropertyOptional({ description: 'IST minute (0–59)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(59)
  briefingMinute?: number;

  @ApiPropertyOptional({ description: 'WhatsApp number hot-lead alerts are pushed to (E.164)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  hotAlertWhatsapp?: string;
}

// ─────────────────────────────────────────────
// TAKEOVER
// ─────────────────────────────────────────────

export class TakeoverDto {
  @ApiProperty({ description: 'Conversation to take over from the AI' })
  @IsUUID()
  conversationId!: string;

  @ApiPropertyOptional({ description: 'The lead behind the conversation' })
  @IsOptional()
  @IsUUID()
  leadId?: string;
}

export class ReleaseDto {
  @ApiProperty({ description: 'Conversation to hand back to the AI' })
  @IsUUID()
  conversationId!: string;
}

// ─────────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────────

export class ListAlertsQueryDto {
  @ApiPropertyOptional({ description: 'Only unread alerts', type: Boolean })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional({ description: 'Filter by alert type' })
  @IsOptional()
  @IsString()
  type?: string;
}
