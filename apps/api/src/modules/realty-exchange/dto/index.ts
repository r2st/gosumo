import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsInt,
  IsNumber,
  IsBoolean,
  IsObject,
  IsNotEmpty,
  ValidateNested,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SyndicationState, ResaleListingStatus } from '@gosumo/shared';

// ─────────────────────────────────────────────
// SPLIT TERMS
// ─────────────────────────────────────────────

/** Commission split — integer percents that MUST sum to 100. */
export class SplitTermsDto {
  @ApiProperty({ description: "Originating broker's share (%)", example: 50 })
  @IsInt()
  @Min(0)
  @Max(100)
  originatorPct!: number;

  @ApiProperty({ description: "Counterparty's share (%)", example: 50 })
  @IsInt()
  @Min(0)
  @Max(100)
  counterpartyPct!: number;

  @ApiPropertyOptional({ description: 'Developer/channel-partner cut off the top (%)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  developerPct?: number;

  @ApiPropertyOptional({ description: 'Free-form note captured at offer time' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ─────────────────────────────────────────────
// SYNDICATION DTOs
// ─────────────────────────────────────────────

export class CreateSyndicationDto {
  @ApiProperty({ description: 'Lead UUID being syndicated' })
  @IsUUID()
  leadId!: string;

  @ApiProperty({ description: 'Counterparty business UUID (inventory/closing side)' })
  @IsUUID()
  toBusinessId!: string;

  @ApiPropertyOptional({ description: 'Optional developer/channel-partner UUID' })
  @IsOptional()
  @IsUUID()
  developerId?: string;

  @ApiProperty({ type: SplitTermsDto })
  @IsObject()
  @ValidateNested()
  @Type(() => SplitTermsDto)
  splitTerms!: SplitTermsDto;
}

export class CloseSyndicationDto {
  @ApiProperty({ description: 'Total commission pool in paise' })
  @IsInt()
  @Min(0)
  commissionPoolPaise!: number;

  @ApiPropertyOptional({
    description: 'Platform fee rate (0.05–0.08). Defaults to 0.06.',
    example: 0.06,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.05)
  @Max(0.08)
  platformFeeRate?: number;
}

export class DisputeSyndicationDto {
  @ApiProperty({ description: 'Why the syndication is being contested' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** Post-deal rating that feeds the counterparty's reliability score. */
export class RateSyndicationDto {
  @ApiPropertyOptional({ description: 'Minutes to first response on this deal' })
  @IsOptional()
  @IsInt()
  @Min(0)
  responseMinutes?: number;

  @ApiPropertyOptional({ description: 'Did the counterparty show up for the visit?' })
  @IsOptional()
  @IsBoolean()
  showedUp?: boolean;

  @ApiPropertyOptional({ description: 'Was the agreed split honoured?' })
  @IsOptional()
  @IsBoolean()
  splitHonored?: boolean;

  @ApiPropertyOptional({ description: 'Was the deal fully documented (agreement/KYC/RERA)?' })
  @IsOptional()
  @IsBoolean()
  documented?: boolean;
}

export class ListSyndicationsQueryDto {
  @ApiPropertyOptional({ enum: SyndicationState })
  @IsOptional()
  @IsEnum(SyndicationState)
  state?: SyndicationState;

  @ApiPropertyOptional({ enum: ['from', 'to'], description: 'Filter by the tenant’s side' })
  @IsOptional()
  @IsEnum(['from', 'to'] as unknown as object)
  role?: 'from' | 'to';
}

export class MatchLeadQueryDto {
  @ApiPropertyOptional({ description: 'Max matches to return', default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number;

  @ApiPropertyOptional({ description: 'Attach an AI-written rationale (OpenRouter)', default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  aiRationale?: boolean;
}

// ─────────────────────────────────────────────
// RESALE LISTING DTOs
// ─────────────────────────────────────────────

export class CreateResaleListingDto {
  @ApiPropertyOptional({ description: 'Optional link to a verified project' })
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @ApiProperty({ description: 'Locality / corridor', example: 'Baner' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(180)
  locality!: string;

  @ApiProperty({ description: 'Configuration, e.g. "2BHK"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  config!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  carpetSqft?: number;

  @ApiProperty({ description: 'Asking price in paise' })
  @IsInt()
  @Min(0)
  askingPricePaise!: number;

  @ApiProperty({ description: 'Seller contact (E.164). Private — never leaves the owner.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  sellerPhone!: string;
}

export class UpdateResaleListingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(180)
  locality?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  config?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  carpetSqft?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  askingPricePaise?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  sellerPhone?: string;

  @ApiPropertyOptional({ enum: ResaleListingStatus })
  @IsOptional()
  @IsEnum(ResaleListingStatus)
  status?: ResaleListingStatus;
}

export class ListResaleListingsQueryDto {
  @ApiPropertyOptional({ enum: ResaleListingStatus })
  @IsOptional()
  @IsEnum(ResaleListingStatus)
  status?: ResaleListingStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(180)
  locality?: string;
}
