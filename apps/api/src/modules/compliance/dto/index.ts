import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** POST /compliance/correction — correct a buyer's personal data. */
export class CorrectionDto {
  @ApiProperty({ description: 'Buyer phone (any Indian format; normalized to E.164)' })
  @IsString()
  @MinLength(6)
  phone!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  altPhone?: string;
}

/** POST /compliance/erasure — anonymize all PII for a phone (right to erasure). */
export class ErasureDto {
  @ApiProperty({ description: 'Buyer phone (any Indian format; normalized to E.164)' })
  @IsString()
  @MinLength(6)
  phone!: string;
}

/** PUT /compliance/settings — retention window + data-processor agreement. */
export class UpdateComplianceSettingsDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 120, description: 'Retention window in months' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  retentionMonths?: number;

  @ApiPropertyOptional({ description: 'Broker has accepted the data-processor agreement' })
  @IsOptional()
  @IsBoolean()
  dataProcessorAgreement?: boolean;
}
