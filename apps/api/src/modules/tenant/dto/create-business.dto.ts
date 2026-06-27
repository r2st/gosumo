import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsOptional,
  MaxLength,
  Matches,
  IsIn,
  Length,
} from 'class-validator';
import { SubscriptionTier, GSTIN_REGEX } from '../tenant.constants';

/**
 * DTO for creating a new business (tenant).
 *
 * The slug is derived from `name` server-side and is immutable afterwards.
 * `plan` defaults to the free tier when omitted.
 */
export class CreateBusinessDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  /** ISO 3166-1 alpha-2 country code. Defaults to IN. */
  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;

  /** IANA timezone. Defaults to Asia/Kolkata. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  /** ISO 4217 currency code. Defaults to INR. */
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @IsIn(Object.values(SubscriptionTier))
  plan?: SubscriptionTier;

  /** Optional GSTIN — validated against the 15-char format when provided. */
  @IsOptional()
  @IsString()
  @Matches(GSTIN_REGEX, { message: 'gstNumber must be a valid 15-character GSTIN' })
  gstNumber?: string;
}
