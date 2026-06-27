import { IsEmail, IsString, MinLength, MaxLength, Matches, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Password policy (enforced here and on ChangePasswordDto):
 * min 8 chars, at least one uppercase letter, one number, and one special character.
 */
export const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
export const PASSWORD_MESSAGE =
  'Password must be at least 8 characters and include an uppercase letter, a number, and a special character';

export class RegisterDto {
  @ApiProperty({ example: 'owner@acme.in' })
  @IsEmail()
  @Transform(({ value }: { value: string }) => value.toLowerCase().trim())
  email!: string;

  @ApiProperty({ example: 'Str0ng!Pass', minLength: 8, maxLength: 128 })
  @IsString()
  @MaxLength(128)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MESSAGE })
  password!: string;

  @ApiProperty({ example: 'Acme Salon & Spa' })
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  businessName!: string;

  @ApiProperty({ example: 'Priya Sharma', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiProperty({ example: '+91 98765 43210', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;
}
