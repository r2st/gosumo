import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsBoolean,
  IsInt,
  IsArray,
  IsNotEmpty,
  Min,
  MaxLength,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ProjectStatus,
  UnitAvailability,
  NetworkVisibility,
  RealtyAssetType,
} from '@gosumo/shared';

// ─────────────────────────────────────────────
// PROJECT DTOs
// ─────────────────────────────────────────────

export class CreateProjectDto {
  @ApiProperty({ description: 'Project name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiProperty({ description: 'Locality / corridor', example: 'Baner' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(180)
  locality!: string;

  @ApiPropertyOptional({ description: 'Developer name' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  developer?: string;

  @ApiPropertyOptional({ description: 'RERA registration number' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reraNumber?: string;

  @ApiPropertyOptional({ description: 'Possession date (ISO-8601)' })
  @IsOptional()
  @IsDateString()
  possessionDate?: string;

  @ApiPropertyOptional({ enum: ProjectStatus, default: ProjectStatus.UC })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  amenities?: string[];

  @ApiPropertyOptional({ description: 'Price band floor in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceBandMinPaise?: number;

  @ApiPropertyOptional({ description: 'Price band ceiling in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceBandMaxPaise?: number;

  @ApiPropertyOptional({ description: 'FK to the uploaded RERA fact sheet' })
  @IsOptional()
  @IsUUID()
  factSheetDocId?: string;

  @ApiPropertyOptional({ enum: NetworkVisibility, default: NetworkVisibility.PRIVATE })
  @IsOptional()
  @IsEnum(NetworkVisibility)
  networkVisibility?: NetworkVisibility;
}

export class UpdateProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(180)
  locality?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  developer?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reraNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  possessionDate?: string;

  @ApiPropertyOptional({ enum: ProjectStatus })
  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  amenities?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  priceBandMinPaise?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  priceBandMaxPaise?: number;

  @ApiPropertyOptional({ enum: NetworkVisibility })
  @IsOptional()
  @IsEnum(NetworkVisibility)
  networkVisibility?: NetworkVisibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─────────────────────────────────────────────
// UNIT DTOs
// ─────────────────────────────────────────────

export class CreateUnitDto {
  @ApiProperty({ description: 'Configuration, e.g. "2BHK"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  config!: string;

  @ApiProperty({ description: 'All-inclusive price in paise' })
  @IsInt()
  @Min(0)
  allInPricePaise!: number;

  @ApiPropertyOptional({ description: 'Base price in paise' })
  @IsOptional()
  @IsInt()
  @Min(0)
  basePricePaise?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  carpetSqft?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  builtupSqft?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  floor?: number;

  @ApiPropertyOptional({ example: 'East' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  facing?: string;

  @ApiPropertyOptional({ enum: UnitAvailability, default: UnitAvailability.UNVERIFIED })
  @IsOptional()
  @IsEnum(UnitAvailability)
  availability?: UnitAvailability;

  @ApiPropertyOptional({ enum: NetworkVisibility })
  @IsOptional()
  @IsEnum(NetworkVisibility)
  networkVisibility?: NetworkVisibility;
}

export class UpdateUnitDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  config?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  allInPricePaise?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  basePricePaise?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  carpetSqft?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  builtupSqft?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  floor?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  facing?: string;

  @ApiPropertyOptional({ enum: NetworkVisibility })
  @IsOptional()
  @IsEnum(NetworkVisibility)
  networkVisibility?: NetworkVisibility;
}

/**
 * Set a unit's availability. Doing so re-stamps `verified_at` to now, which
 * satisfies the 24h freshness rule the AI relies on before asserting availability.
 */
export class SetAvailabilityDto {
  @ApiProperty({ enum: UnitAvailability })
  @IsEnum(UnitAvailability)
  availability!: UnitAvailability;
}

// ─────────────────────────────────────────────
// ASSET DTOs
// ─────────────────────────────────────────────

export class CreateAssetDto {
  @ApiProperty({ enum: RealtyAssetType })
  @IsEnum(RealtyAssetType)
  type!: RealtyAssetType;

  @ApiPropertyOptional({ description: 'Public/CDN URL of the asset' })
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional({ description: 'WhatsApp media id for instant re-send' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  waMediaId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}

// ─────────────────────────────────────────────
// MATCHING
// ─────────────────────────────────────────────

/** Match a BLTC requirement profile against verified AVAILABLE inventory. */
export class MatchQueryDto {
  @ApiPropertyOptional({ description: 'Budget floor in paise' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetMinPaise?: number;

  @ApiPropertyOptional({ description: 'Budget ceiling in paise' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  budgetMaxPaise?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  localities?: string[];

  @ApiPropertyOptional({ example: '2BHK' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  config?: string;

  @ApiPropertyOptional({ description: 'Max matches to return', default: 3 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

/** Match against a stored lead's BLTC profile by lead id. */
export class MatchForLeadDto {
  @ApiProperty({ description: 'Lead UUID whose BLTC profile to match' })
  @IsUUID()
  leadId!: string;

  @ApiPropertyOptional({ default: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}
