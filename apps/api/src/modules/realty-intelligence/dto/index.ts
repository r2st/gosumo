import { IsString, IsOptional, IsEnum, IsArray, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IntelligenceMetricType } from '@gosumo/shared';

// ─────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────

export class ListAggregatesQueryDto {
  @ApiPropertyOptional({ description: 'Filter to a single corridor (locality key)' })
  @IsOptional()
  @IsString()
  @MaxLength(180)
  corridor?: string;

  @ApiPropertyOptional({ enum: IntelligenceMetricType, description: 'Filter to a single metric' })
  @IsOptional()
  @IsEnum(IntelligenceMetricType)
  metricType?: IntelligenceMetricType;
}

export class CorridorPriorsQueryDto {
  @ApiProperty({ description: 'Corridor (locality key) to fetch priors for' })
  @IsString()
  @MaxLength(180)
  corridor!: string;

  @ApiPropertyOptional({
    enum: IntelligenceMetricType,
    isArray: true,
    description: 'Restrict to these metric types (default: all)',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(IntelligenceMetricType, { each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]).filter(Boolean))
  metricTypes?: IntelligenceMetricType[];
}

// ─────────────────────────────────────────────
// Responses (shapes documented for Swagger)
// ─────────────────────────────────────────────

export class AggregateDto {
  @ApiProperty() id!: string;
  @ApiProperty() corridor!: string;
  @ApiProperty({ enum: IntelligenceMetricType }) metricType!: IntelligenceMetricType;
  @ApiProperty({ description: 'Metric-specific aggregate payload (JSON)' })
  metricValue!: unknown;
  @ApiProperty() sampleSize!: number;
  @ApiProperty() minNThreshold!: number;
  @ApiProperty() periodStart!: string;
  @ApiProperty() periodEnd!: string;
  @ApiProperty() updatedAt!: string;
}

export class OptInStatusDto {
  @ApiProperty({ description: 'Whether this business contributes to the intelligence layer' })
  optIn!: boolean;
}
