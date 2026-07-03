import {
  IsString,
  IsOptional,
  IsUUID,
  IsInt,
  IsEnum,
  IsObject,
  IsNotEmpty,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RealtyIntegrationProvider } from '@prisma/client';

// ─────────────────────────────────────────────
// CRM connection
// ─────────────────────────────────────────────

export class ConnectCrmDto {
  @ApiProperty({
    enum: [
      RealtyIntegrationProvider.SELLDO,
      RealtyIntegrationProvider.LEADSQUARED,
      RealtyIntegrationProvider.PRIVYR,
    ],
    description: 'Which Indian CRM to push leads into',
  })
  @IsEnum(RealtyIntegrationProvider)
  provider!: RealtyIntegrationProvider;

  @ApiProperty({
    description:
      'Provider credentials/settings. Sell.Do: {apiKey}. LeadSquared: {accessKey, secretKey, host?}. Privyr: {webhookUrl}.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  config!: Record<string, unknown>;
}

// ─────────────────────────────────────────────
// EOI (Expression of Interest / टोकन) payment
// ─────────────────────────────────────────────

export class RequestEoiDto {
  @ApiProperty({ description: 'The qualified lead this token is for', format: 'uuid' })
  @IsUUID()
  leadId!: string;

  @ApiProperty({ description: 'Token amount in paise (integer)', example: 2500000 })
  @IsInt()
  @Min(100)
  amountPaise!: number;

  @ApiPropertyOptional({ description: 'The unit being booked', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({
    description: 'Buyer-facing label for the token',
    example: 'बुकिंग टोकन',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  tokenLabel?: string;

  @ApiPropertyOptional({ description: 'Free-form note shown to the approving broker' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApproveEoiDto {
  @ApiPropertyOptional({
    description: 'Payment-link validity in minutes (default 2880 = 48h)',
    example: 2880,
  })
  @IsOptional()
  @IsInt()
  @Min(15)
  expiryMinutes?: number;
}

export class RejectEoiDto {
  @ApiProperty({ description: 'Why the broker declined the token request' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
