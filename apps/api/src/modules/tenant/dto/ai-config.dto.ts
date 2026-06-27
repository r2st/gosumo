import { IsInt, Min, Max, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * DTO for updating AI autonomy thresholds.
 *
 * autoExecuteThreshold: AI acts without human review when confidence >= this value.
 * reviewThreshold: AI creates a draft for human review when confidence >= this value
 *   but < autoExecuteThreshold. Below reviewThreshold the AI fully escalates.
 *
 * Both values must be between 50 and 100. autoExecuteThreshold must be
 * >= reviewThreshold (validated in the service layer).
 */
export class UpdateAIConfigDto {
  @IsInt()
  @Min(50)
  @Max(100)
  autoExecuteThreshold!: number;

  @IsInt()
  @Min(50)
  @Max(100)
  reviewThreshold!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  personalityPrompt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  responseLanguage?: string;
}

/**
 * Response shape for AI config.
 */
export interface AIConfigResponse {
  autoExecuteThreshold: number;
  reviewThreshold: number;
  personalityPrompt: string;
  responseLanguage: string;
}
