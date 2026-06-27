import {
  IsOptional,
  IsString,
  IsEmail,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';

/**
 * DTO for updating a business profile.
 * All fields are optional — only supplied fields are updated.
 */
export class UpdateBusinessDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^\+?[1-9]\d{1,14}$/, { message: 'phone must be a valid E.164 phone number' })
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  @MinLength(3)
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a valid ISO 4217 code (e.g. INR)' })
  currency?: string;
}
