import { ApiProperty } from '@nestjs/swagger';

export class AuthTokensDto {
  @ApiProperty({ description: 'Short-lived JWT (15 min) for the Authorization header' })
  accessToken!: string;

  @ApiProperty({ description: 'Long-lived JWT (7 days) used to mint new access tokens' })
  refreshToken!: string;

  @ApiProperty({ description: 'Access-token lifetime in seconds', example: 900 })
  expiresIn!: number;
}
