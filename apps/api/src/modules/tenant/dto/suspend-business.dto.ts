import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * DTO for suspending a business. The reason is stored on the business profile
 * and surfaced in audit/analytics.
 */
export class SuspendBusinessDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
