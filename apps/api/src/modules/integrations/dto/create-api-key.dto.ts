import { IsInt, IsOptional, IsString, IsNotEmpty, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * API-key creation.
 *
 * `POST /api-keys` previously took `@Body() body: { name: string; expiresInDays?: number }`
 * — an inline type, invisible to the ValidationPipe. Two concrete faults
 * followed: `name` was unbounded, and `expiresInDays` was multiplied into a
 * timestamp without being a number at all, so a string produced
 * `Invalid Date` and a large value produced a key that never expires.
 */
export class CreateApiKeyDto {
  @ApiProperty({ description: 'Human-readable label for the key' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({
    description: 'Days until the key expires; omit for a non-expiring key',
    minimum: 1,
    maximum: 3650,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  expiresInDays?: number;
}
