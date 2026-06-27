import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsBoolean,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Indian PIN code: 6 digits, first digit 1–9. */
export const INDIAN_PINCODE_REGEX = /^[1-9][0-9]{5}$/;

// ─────────────────────────────────────────────
// Command DTOs
// ─────────────────────────────────────────────

export class CreateAddressDto {
  @ApiProperty({ description: 'UUID of the client this address belongs to' })
  @IsUUID()
  clientId!: string;

  @ApiProperty({ description: 'Recipient full name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  recipientName!: string;

  @ApiProperty({ description: 'Address line 1' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  line1!: string;

  @ApiPropertyOptional({ description: 'Address line 2' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  line2?: string;

  @ApiProperty({ description: 'City' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @ApiProperty({ description: 'State' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state!: string;

  @ApiProperty({ description: '6-digit Indian PIN code', example: '560001' })
  @IsString()
  @Matches(INDIAN_PINCODE_REGEX, {
    message: 'pincode must be a valid 6-digit Indian PIN code',
  })
  pincode!: string;

  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2 country code', default: 'IN' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  @ApiPropertyOptional({ description: 'Contact phone for delivery' })
  @IsOptional()
  @IsString()
  @Matches(/^(\+91)?[6-9][0-9]{9}$/, {
    message: 'phone must be a valid Indian mobile number',
  })
  phone?: string;

  @ApiPropertyOptional({ description: 'Label such as "Home" or "Work"' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  label?: string;

  @ApiPropertyOptional({ description: 'Mark this address as the default' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  recipientName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  line1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  line2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @ApiPropertyOptional({ example: '560001' })
  @IsOptional()
  @IsString()
  @Matches(INDIAN_PINCODE_REGEX, {
    message: 'pincode must be a valid 6-digit Indian PIN code',
  })
  pincode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^(\+91)?[6-9][0-9]{9}$/, {
    message: 'phone must be a valid Indian mobile number',
  })
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/**
 * Standalone validation request — checks an address payload without persisting.
 */
export class ValidateAddressDto {
  @ApiProperty({ description: '6-digit Indian PIN code' })
  @IsString()
  pincode!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;
}

// ─────────────────────────────────────────────
// Response DTOs
// ─────────────────────────────────────────────

export interface AddressDto {
  id: string;
  businessId: string;
  clientId: string;
  label: string | null;
  isDefault: boolean;
  recipientName: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
  country: string;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddressValidationResult {
  valid: boolean;
  errors: string[];
}
