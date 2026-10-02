import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SaveCredentialsDto {
  @ApiProperty({ description: 'API key or client ID for the provider', maxLength: 512 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  apiKey!: string;

  @ApiProperty({ description: 'API secret or client secret', maxLength: 512, required: false })
  @IsString()
  @MaxLength(512)
  apiSecret?: string;
}
