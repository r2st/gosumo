import { IsInt, Min, IsIn, IsOptional } from 'class-validator';
import { UsageMetric } from '../tenant.constants';

/**
 * DTO for recording usage against a metered quota (internal/admin use).
 */
export class RecordUsageDto {
  @IsIn(Object.values(UsageMetric))
  metric!: UsageMetric;

  @IsOptional()
  @IsInt()
  @Min(1)
  amount?: number;
}

/** Per-metric usage line. */
export interface UsageMetricStatus {
  metric: UsageMetric;
  /** Current usage — live row count for resource metrics, monthly counter otherwise. */
  used: number;
  /** Plan limit (-1 = unlimited). */
  limit: number;
  /** Remaining headroom; null when unlimited. */
  remaining: number | null;
  /** 0–100 percentage of limit used; 0 when unlimited. */
  percentUsed: number;
  /** True when usage has reached or exceeded the limit. */
  overLimit: boolean;
}

/** Aggregate usage snapshot for a business. */
export interface UsageSnapshotResponse {
  plan: string;
  /** Monthly period these counters belong to, e.g. "2026-06". */
  period: string;
  metrics: UsageMetricStatus[];
}
