import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for updating a connected channel's status.
 *
 * Currently the only mutable status is the active/paused flag. Setting
 * `isActive: false` pauses inbound/outbound routing for the channel without
 * disconnecting (soft-deleting) it; `true` resumes it.
 */
export class UpdateChannelDto {
  @ApiProperty({
    description: 'Whether the channel is active. false pauses routing, true resumes it.',
    example: false,
  })
  @IsBoolean()
  isActive!: boolean;
}
