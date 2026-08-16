import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AiQualityBucket, ChannelType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { IsCalendarDateString } from '../../../../common/validators/is-calendar-date.validator';
import { MAX_QUALITY_WINDOW_DAYS } from '../ai-quality.constants';

export class QualityMetricsQueryDto {
  @ApiPropertyOptional({
    description: 'Window start (ISO 8601). Defaults to 7 days before `to`.',
  })
  @IsOptional()
  @IsCalendarDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Window end, exclusive (ISO 8601). Defaults to now.' })
  @IsOptional()
  @IsCalendarDateString()
  to?: string;

  @ApiPropertyOptional({ enum: AiQualityBucket, default: AiQualityBucket.HOUR })
  @IsOptional()
  @IsEnum(AiQualityBucket)
  bucket?: AiQualityBucket;

  @ApiPropertyOptional({ enum: ChannelType, description: 'Restrict to one channel.' })
  @IsOptional()
  @IsEnum(ChannelType)
  channel?: ChannelType;
}

export class RecomputeQualityDto {
  @ApiProperty({
    description:
      'Drop and rebuild every bucket at or after this instant (ISO 8601). ' +
      `At most ${MAX_QUALITY_WINDOW_DAYS} days back.`,
  })
  @IsCalendarDateString()
  from!: string;

  @ApiPropertyOptional({ enum: AiQualityBucket, default: AiQualityBucket.HOUR })
  @IsOptional()
  @IsEnum(AiQualityBucket)
  bucket?: AiQualityBucket;
}

export class LatencySummaryDto {
  @ApiProperty({ description: 'Mean end-to-end pipeline latency, ms.' })
  meanMs!: number;

  @ApiProperty({ description: 'Slowest single decision in the window, ms.' })
  maxMs!: number;

  @ApiPropertyOptional({
    description:
      'Median latency, ms. Exact when the window is one bucket; otherwise the ' +
      'largest per-bucket median, i.e. an upper bound. See `percentilesExact`.',
    nullable: true,
  })
  p50Ms!: number | null;

  @ApiPropertyOptional({
    description: '95th percentile latency, ms. Same caveat as `p50Ms`.',
    nullable: true,
  })
  p95Ms!: number | null;

  @ApiProperty({
    description:
      'True when exactly one bucket contributed, so the percentiles are the ' +
      'real ones. A percentile of percentiles is not a percentile, so across ' +
      'buckets they are reported as the worst bucket rather than recombined.',
  })
  percentilesExact!: boolean;

  @ApiProperty({ description: 'Decisions that recorded a latency at all.' })
  sampleCount!: number;
}

export class ChannelQualityDto {
  @ApiProperty({
    enum: ChannelType,
    nullable: true,
    description: 'Null on the `overall` block, which spans every channel.',
  })
  channel!: ChannelType | null;

  @ApiProperty() decisions!: number;
  @ApiProperty() autoExecuted!: number;
  @ApiProperty() sentForReview!: number;
  @ApiProperty() escalated!: number;
  @ApiProperty() expired!: number;

  @ApiProperty({ description: 'Decisions a human later corrected.' })
  humanOverrides!: number;

  @ApiProperty({ description: 'autoExecuted / decisions, 0–1.' })
  autoExecuteRate!: number;

  @ApiProperty({ description: 'sentForReview / decisions, 0–1.' })
  reviewRate!: number;

  @ApiProperty({ description: 'escalated / decisions, 0–1.' })
  escalationRate!: number;

  @ApiProperty({ description: 'humanOverrides / decisions, 0–1.' })
  overrideRate!: number;

  @ApiProperty({ description: 'Mean confidence, 0–1.' })
  meanConfidence!: number;

  @ApiProperty({ type: [Number], description: 'Confidence histogram, 10 deciles.' })
  confidenceDeciles!: number[];

  @ApiProperty({ type: LatencySummaryDto })
  latency!: LatencySummaryDto;

  @ApiProperty() promptTokens!: number;
  @ApiProperty() completionTokens!: number;
}

export class QualityPointDto {
  @ApiProperty({ description: 'Bucket start (ISO 8601, UTC).' })
  bucketStart!: string;

  @ApiProperty() decisions!: number;
  @ApiProperty() autoExecuteRate!: number;
  @ApiProperty() reviewRate!: number;
  @ApiProperty() escalationRate!: number;
  @ApiProperty() overrideRate!: number;
  @ApiProperty() meanConfidence!: number;
  @ApiProperty() meanLatencyMs!: number;
}

export class QualitySummaryDto {
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ enum: AiQualityBucket }) bucket!: AiQualityBucket;

  @ApiProperty({
    type: ChannelQualityDto,
    description: 'All channels combined. Rates are recomputed from the totals.',
  })
  overall!: ChannelQualityDto;

  @ApiProperty({ type: [ChannelQualityDto] })
  byChannel!: ChannelQualityDto[];

  @ApiProperty({ type: [QualityPointDto], description: 'Time series, oldest first.' })
  series!: QualityPointDto[];
}

export class RollupResultDto {
  @ApiProperty({ enum: AiQualityBucket }) bucket!: AiQualityBucket;
  @ApiProperty({ description: 'Buckets computed this run.' }) bucketsComputed!: number;
  @ApiProperty({ description: 'Rollup rows written across all tenants.' }) rowsWritten!: number;
  @ApiProperty({ description: 'Distinct tenants that appeared in the window.' }) businesses!: number;

  @ApiProperty({
    description:
      'True when closed buckets remained uncomputed — the per-run cap or the ' +
      'time budget stopped the catch-up before it reached the present.',
  })
  pending!: boolean;
}

export class RollupSummaryDto {
  @ApiProperty({ type: [RollupResultDto] })
  results!: RollupResultDto[];
}

export class QualityRecomputeResultDto {
  @ApiProperty({ description: 'Rollup rows deleted before the rebuild.' })
  deleted!: number;

  @ApiProperty({ description: 'Rollup rows written for this tenant.' })
  written!: number;

  @ApiProperty({ description: 'Buckets recomputed.' })
  buckets!: number;
}
