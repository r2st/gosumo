import {
  IsString,
  IsOptional,
  IsUUID,
  IsEnum,
  IsBoolean,
  IsInt,
  IsArray,
  IsNotEmpty,
  IsUrl,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ProjectStatus,
  UnitAvailability,
  NetworkVisibility,
  RealtyAssetType,
} from '@gosumo/shared';
import { MAX_PAGE_SIZE } from '../../../common/validators/pagination.constants';
import { IsCalendarDateString } from '../../../common/validators/is-calendar-date.validator';

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
  @IsCalendarDateString()
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
  @IsCalendarDateString()
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

/** Generous for a real CDN link, bounded for a `@db.Text` column. */
export const MAX_ASSET_URL_LENGTH = 2048;

export class CreateAssetDto {
  @ApiProperty({ enum: RealtyAssetType })
  @IsEnum(RealtyAssetType)
  type!: RealtyAssetType;

  /**
   * The scheme check is the point, not tidiness. This value is stored verbatim
   * and rendered by the dashboard as `<a href={asset.url}>Open</a>`, so a
   * brochure published as `javascript:…` is script that runs in an operator's
   * session the moment a colleague clicks it — a STAFF member reaching an OWNER
   * through a link the product told them to trust. `data:` and `file:` are the
   * same shape of problem. An asset is a document somewhere on the web; saying
   * so in the DTO is what keeps it one.
   */
  @ApiPropertyOptional({ description: 'Public/CDN URL of the asset (http/https only)' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_ASSET_URL_LENGTH)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
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
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

/** Match against a stored lead's BLTC profile by lead id. */
export class MatchForLeadDto {
  @ApiProperty({ description: 'Lead UUID whose BLTC profile to match' })
  @IsUUID()
  leadId!: string;

  @ApiPropertyOptional({ default: 3 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}

/**
 * Query for `POST /realty/inventory/leads/:leadId/match`.
 *
 * The lead id is a path parameter; only the match count comes from the query
 * string. It was read as a bare `@Query()` string and parsed with `parseInt`,
 * so `?limit=abc` handed the matcher NaN — and because this route also *writes*
 * the result via `setMatchedUnits`, a NaN limit did not just return nothing, it
 * overwrote the lead's stored matches with an empty set.
 */
export class MatchForLeadQueryDto {
  @ApiPropertyOptional({ description: 'Max matches to return', default: 3 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = 3;
}
