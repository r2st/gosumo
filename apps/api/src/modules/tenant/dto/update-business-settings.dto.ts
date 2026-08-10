import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Business settings update.
 *
 * `PATCH /business/settings` previously took `@Body() body: Record<string, any>`
 * and spread it wholesale into the `businesses.profile.settings` JSON column.
 * An untyped body is invisible to the global ValidationPipe — `whitelist` has
 * no property metadata to whitelist against — so the endpoint accepted any key
 * of any size and persisted it verbatim: an authenticated caller could grow a
 * tenant's profile blob without bound, and any later reader of
 * `profile.settings` would find keys no writer in this codebase ever set.
 *
 * The properties below are exactly the ones `GET /business/settings` reads
 * back. Anything else is now dropped by the pipe rather than stored.
 */
export class UpdateBusinessSettingsDto {
  @ApiPropertyOptional({ description: 'Whether the AI replies without human review' })
  @IsOptional()
  @IsBoolean()
  aiAutoReplyEnabled?: boolean;

  @ApiPropertyOptional({
    enum: ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'],
    description: 'How readily the AI acts on its own',
  })
  @IsOptional()
  @IsEnum(['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE'])
  aiAutonomyLevel?: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';

  @ApiPropertyOptional({ description: 'Opening line prepended to AI replies' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  defaultGreeting?: string;

  @ApiPropertyOptional({ description: 'Closing line appended to AI replies' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  defaultSignoff?: string;

  @ApiPropertyOptional({ description: 'Whether office-hours gating is active' })
  @IsOptional()
  @IsBoolean()
  officeHoursEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Per-weekday open/close windows, keyed by day name',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  officeHours?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Auto-reply sent outside office hours' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  outsideHoursMessage?: string;
}
