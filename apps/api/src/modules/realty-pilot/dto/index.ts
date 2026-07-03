import {
  IsString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsUUID,
  IsInt,
  IsNumber,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MigrationKind, NoShipKind } from '@gosumo/shared';
import { CsvImportRowDto } from '../../realty-ingestion/dto';

// ─────────────────────────────────────────────
// MIGRATION — LEADS / CONTACTS
// ─────────────────────────────────────────────

export class ImportLeadsDto {
  @ApiProperty({ type: [CsvImportRowDto], description: 'Parsed lead/contact rows to import' })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => CsvImportRowDto)
  rows!: CsvImportRowDto[];

  @ApiPropertyOptional({ description: 'Validate only — nothing is written', default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    enum: [MigrationKind.LEADS, MigrationKind.CONTACTS],
    description: 'Whether this is a leads or a plain-contacts import (record-keeping only)',
  })
  @IsOptional()
  @IsEnum(MigrationKind)
  kind?: MigrationKind;
}

// ─────────────────────────────────────────────
// MIGRATION — INVENTORY
// ─────────────────────────────────────────────

export class InventoryImportRowDto {
  @ApiProperty({ description: 'Project name (groups the units under one project)' })
  @IsString()
  @MaxLength(255)
  projectName!: string;

  @ApiProperty({ description: 'Locality — part of the project identity' })
  @IsString()
  @MaxLength(180)
  locality!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  developer?: string;

  @ApiPropertyOptional({ description: 'RERA registration number (verbatim)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reraNumber?: string;

  @ApiPropertyOptional({ description: 'Possession date (ISO / parseable date)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  possessionDate?: string;

  @ApiPropertyOptional({ description: 'PRELAUNCH | UC | RTM' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  projectStatus?: string;

  @ApiPropertyOptional({ description: 'Project price band min in rupees (plain, comma-grouped, or 85L / 1.2Cr)' })
  @IsOptional()
  priceBandMin?: string | number;

  @ApiPropertyOptional({ description: 'Project price band max in rupees' })
  @IsOptional()
  priceBandMax?: string | number;

  @ApiPropertyOptional({ description: 'Unit config, e.g. 2BHK (a row with a config is a unit row)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  config?: string;

  @ApiPropertyOptional({ description: 'Carpet area (sqft)' })
  @IsOptional()
  carpetSqft?: string | number;

  @ApiPropertyOptional()
  @IsOptional()
  floor?: string | number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  facing?: string;

  @ApiPropertyOptional({ description: 'Unit all-in price in rupees' })
  @IsOptional()
  allInPrice?: string | number;

  @ApiPropertyOptional({ description: 'AVAILABLE | HOLD | SOLD | UNVERIFIED (defaults to UNVERIFIED)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  availability?: string;
}

export class ImportInventoryDto {
  @ApiProperty({ type: [InventoryImportRowDto], description: 'Inventory rows (one row per unit)' })
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => InventoryImportRowDto)
  rows!: InventoryImportRowDto[];

  @ApiPropertyOptional({ description: 'Validate only — nothing is written', default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class ListMigrationsQueryDto {
  @ApiPropertyOptional({ enum: MigrationKind })
  @IsOptional()
  @IsEnum(MigrationKind)
  kind?: MigrationKind;
}

// ─────────────────────────────────────────────
// AUTONOMY DIAL
// ─────────────────────────────────────────────

export class AdvanceAutonomyDto {
  @ApiPropertyOptional({
    description: 'Apply the recommendation (OPEN/CLOSE writes settings + ledger). Default true.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  apply?: boolean;
}

// ─────────────────────────────────────────────
// NO-SHIP LEDGER
// ─────────────────────────────────────────────

export class RecordNoShipDto {
  @ApiProperty({ enum: NoShipKind })
  @IsEnum(NoShipKind)
  kind!: NoShipKind;

  @ApiProperty({ description: 'What was detected' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  detail!: string;

  @ApiPropertyOptional({ description: 'Where it was detected, e.g. "soak-drill"' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  leadId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

// ─────────────────────────────────────────────
// LAUNCH GATE
// ─────────────────────────────────────────────

export class EvaluateLaunchGateDto {
  @ApiPropertyOptional({
    description: 'Measured response P95 in seconds (from observability — not derivable from realty tables)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  responseP95Seconds?: number;

  @ApiPropertyOptional({ description: 'Restrict no-ship + hot-alert windows to the last N days' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  windowDays?: number;
}
