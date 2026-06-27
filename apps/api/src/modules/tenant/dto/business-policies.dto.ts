import { IsOptional, IsInt, Min, Max } from 'class-validator';

/**
 * DTO for updating business policies stored in the `businesses.profile` JSON.
 *
 * These policies are consumed by the AI engine when making autonomy decisions
 * (e.g. whether to auto-approve a refund, what SLA targets to enforce).
 *
 * All monetary values are in paise (smallest INR unit).
 */
export class UpdateBusinessPoliciesDto {
  /** Number of days after purchase within which refunds are accepted */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  refundWindowDays?: number;

  /** Maximum refund amount in paise that AI can auto-approve */
  @IsOptional()
  @IsInt()
  @Min(0)
  maxRefundAmountPaise?: number;

  /** SLA target: maximum minutes until first human/AI response */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10080) // 7 days in minutes
  slaFirstResponseMinutes?: number;

  /** SLA target: maximum minutes until full resolution */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(43200) // 30 days in minutes
  slaResolutionMinutes?: number;

  /** Maximum discount percentage AI can auto-apply */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxAutoDiscountPercent?: number;
}

/**
 * Response shape for business policies with defaults applied.
 */
export interface BusinessPoliciesResponse {
  refundWindowDays: number;
  maxRefundAmountPaise: number;
  slaFirstResponseMinutes: number;
  slaResolutionMinutes: number;
  maxAutoDiscountPercent: number;
}
