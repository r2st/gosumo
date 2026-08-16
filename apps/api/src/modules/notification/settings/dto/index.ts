import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ArrayMaxSize,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationDigestFrequency } from '@prisma/client';
import {
  ALERT_KINDS,
  ALERT_SEVERITIES,
  MAX_DIGEST_RECIPIENTS,
  MUTABLE_CHANNELS,
  type AlertKind,
  type AlertSeverity,
  type MutableChannel,
} from '../notification-settings.constants';

/**
 * Patch the operator notification settings for the authenticated business.
 *
 * Every field is optional — the endpoint is a partial update, so a dashboard
 * that only owns the quiet-hours card can PUT that card without having to send
 * back digest fields it never rendered and might have stale.
 */
export class UpdateNotificationSettingsDto {
  @ApiPropertyOptional({ description: 'Master switch for immediate alerts' })
  @IsOptional()
  @IsBoolean()
  realtimeEnabled?: boolean;

  @ApiPropertyOptional({
    isArray: true,
    enum: ALERT_KINDS,
    description:
      'Alert kinds to receive. An empty array means every kind — the master switch is realtimeEnabled.',
  })
  @IsOptional()
  @IsIn(ALERT_KINDS as readonly string[], { each: true })
  @ArrayMaxSize(ALERT_KINDS.length)
  realtimeAlerts?: AlertKind[];

  @ApiPropertyOptional({ enum: ALERT_SEVERITIES })
  @IsOptional()
  @IsIn(ALERT_SEVERITIES as readonly string[])
  realtimeMinSeverity?: AlertSeverity;

  @ApiPropertyOptional({
    isArray: true,
    enum: MUTABLE_CHANNELS,
    description: 'Conversation channels whose alerts are silenced',
  })
  @IsOptional()
  @IsIn(MUTABLE_CHANNELS as readonly string[], { each: true })
  @ArrayMaxSize(MUTABLE_CHANNELS.length)
  mutedChannels?: MutableChannel[];

  @ApiPropertyOptional({ enum: NotificationDigestFrequency })
  @IsOptional()
  @IsEnum(NotificationDigestFrequency)
  digestFrequency?: NotificationDigestFrequency;

  @ApiPropertyOptional({ minimum: 0, maximum: 23, description: 'Hour of day in `timezone`' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  digestHour?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 6, description: '0 = Sunday. WEEKLY only.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  digestDayOfWeek?: number;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description: 'Extra addresses beyond the business owners',
  })
  @IsOptional()
  @IsEmail({}, { each: true })
  @ArrayMaxSize(MAX_DIGEST_RECIPIENTS)
  digestRecipients?: string[];

  @ApiPropertyOptional({ description: 'Skip the digest when the window produced nothing' })
  @IsOptional()
  @IsBoolean()
  digestSkipWhenEmpty?: boolean;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1439,
    nullable: true,
    description: 'Quiet-hours start, minutes from local midnight. Null clears the window.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(1439)
  quietHoursStart?: number | null;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1439,
    nullable: true,
    description: 'Quiet-hours end, minutes from local midnight. Null clears the window.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(1439)
  quietHoursEnd?: number | null;

  @ApiPropertyOptional({
    enum: ALERT_SEVERITIES,
    nullable: true,
    description: 'Alerts at or above this severity page through quiet hours anyway',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(ALERT_SEVERITIES as readonly string[])
  quietHoursOverrideSeverity?: AlertSeverity | null;

  @ApiPropertyOptional({ description: 'IANA zone the hour fields are read in' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Where escalations go when nobody is assigned',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEmail()
  @MaxLength(320)
  fallbackEmail?: string | null;
}

/**
 * Ask what the current rules would do with one alert, without sending it.
 *
 * The rules compose four independent switches and a wrapping quiet window, so
 * "why did I not get paged" is not answerable by reading the settings page.
 * This endpoint answers it directly.
 */
export class PreviewAlertDto {
  @ApiProperty({ enum: ALERT_KINDS })
  @IsIn(ALERT_KINDS as readonly string[])
  kind!: AlertKind;

  @ApiProperty({ enum: ALERT_SEVERITIES })
  @IsIn(ALERT_SEVERITIES as readonly string[])
  severity!: AlertSeverity;

  @ApiPropertyOptional({ enum: MUTABLE_CHANNELS })
  @IsOptional()
  @IsIn(MUTABLE_CHANNELS as readonly string[])
  sourceChannel?: MutableChannel;

  @ApiPropertyOptional({
    description: 'Evaluate as at this instant instead of now (ISO 8601)',
  })
  @IsOptional()
  @IsString()
  at?: string;
}

/** The settings row as the dashboard sees it. */
export class NotificationSettingsDto {
  @ApiProperty() id!: string;
  @ApiProperty() businessId!: string;
  @ApiProperty() realtimeEnabled!: boolean;
  @ApiProperty({ isArray: true, type: String }) realtimeAlerts!: string[];
  @ApiProperty() realtimeMinSeverity!: string;
  @ApiProperty({ isArray: true, type: String }) mutedChannels!: string[];
  @ApiProperty({ enum: NotificationDigestFrequency })
  digestFrequency!: NotificationDigestFrequency;
  @ApiProperty() digestHour!: number;
  @ApiProperty() digestDayOfWeek!: number;
  @ApiProperty({ isArray: true, type: String }) digestRecipients!: string[];
  @ApiProperty() digestSkipWhenEmpty!: boolean;
  @ApiProperty({ nullable: true }) quietHoursStart!: number | null;
  @ApiProperty({ nullable: true }) quietHoursEnd!: number | null;
  @ApiProperty({ nullable: true }) quietHoursOverrideSeverity!: string | null;
  @ApiProperty() timezone!: string;
  @ApiProperty({ nullable: true }) fallbackEmail!: string | null;
  @ApiProperty({ nullable: true }) lastDigestSentAt!: string | null;
  @ApiProperty({ nullable: true }) nextDigestAt!: string | null;
  @ApiProperty() updatedAt!: string;
}

/** What the rules would do with the previewed alert. */
export class AlertPreviewDto {
  @ApiProperty({ description: 'Whether it would be sent at all' })
  deliver!: boolean;

  @ApiProperty({
    nullable: true,
    description: 'Set when the alert would be held to the end of quiet hours',
  })
  deferUntil!: string | null;

  @ApiProperty({ nullable: true, description: 'Why it was withheld or deferred' })
  reason!: string | null;
}
