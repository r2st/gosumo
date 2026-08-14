import {
  IsString,
  IsOptional,
  IsArray,
  IsUUID,
  ValidateNested,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─────────────────────────────────────────────
// CSV IMPORT
// ─────────────────────────────────────────────

export class CsvImportRowDto {
  @ApiProperty({ description: 'Buyer phone (any Indian format; normalized to E.164)' })
  @IsString()
  @MaxLength(30)
  phone!: string;

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

  @ApiPropertyOptional({ description: 'LeadSource; defaults to CSV' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subSource?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  listingRef?: string;
}

export class CsvImportDto {
  @ApiProperty({ type: [CsvImportRowDto], description: 'Parsed CSV rows to import' })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => CsvImportRowDto)
  rows!: CsvImportRowDto[];
}

// ─────────────────────────────────────────────
// PORTAL EMAIL (webhook body from an inbound-email service)
// ─────────────────────────────────────────────

export class PortalEmailDto {
  @ApiPropertyOptional({ description: 'Sender address (used to detect the portal)' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  subject?: string;

  @ApiPropertyOptional({ description: 'Plain-text body' })
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({ description: 'HTML body (stripped if no text is given)' })
  @IsOptional()
  @IsString()
  html?: string;
}

// ─────────────────────────────────────────────
// CTWA (Click-to-WhatsApp) context
// ─────────────────────────────────────────────

export class CtwaReferralDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  headline?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ctwa_clid?: string;
}

export class CtwaContextDto {
  @ApiProperty({ description: 'Sender WhatsApp phone (any format; normalized to E.164)' })
  @IsString()
  @MaxLength(30)
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ type: CtwaReferralDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CtwaReferralDto)
  referral?: CtwaReferralDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  clientId?: string;
}

// ─────────────────────────────────────────────
// IVR MISSED-CALL (webhook body — generic/canonical shape)
// ─────────────────────────────────────────────

/**
 * The canonical IVR missed-call notification. Provider payloads (Exotel,
 * Knowlarity) are normalized to this shape by `parseIvrCallback` before the DTO
 * is validated, so the same endpoint accepts any supported provider.
 */
export class IvrCallbackDto {
  @ApiProperty({ description: 'Caller phone (any Indian format; normalized to E.164)' })
  @IsString()
  @MaxLength(30)
  phone!: string;

  @ApiPropertyOptional({ description: 'The business virtual/DID number that was dialled' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  calledNumber?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 time the call was placed' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  callTime?: string;

  @ApiPropertyOptional({ description: 'Call-flow / campaign id (recorded as lead sub_source)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  campaignId?: string;
}

/** The outcome of processing one IVR missed call. */
export interface IvrCallbackResult {
  leadId: string;
  /** True when folded into an existing lead (same phone); false when created. */
  merged: boolean;
  /** Whether the instant WhatsApp greeting was dispatched this call. */
  whatsappTriggered: boolean;
  /** True when suppressed by the 5-minute repeat-call de-dup window. */
  deduped: boolean;
}

// ─────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────

export interface IngestSummaryDto {
  total: number;
  created: number;
  merged: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}
