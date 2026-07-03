import { IsString, IsOptional, MaxLength, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Transcribe a voice note to text (utility endpoint). */
export class TranscribeVoiceDto {
  @ApiProperty({ description: 'Media reference — `whatsapp-media://<id>` or an https URL' })
  @IsString()
  @MaxLength(2048)
  mediaUrl!: string;

  @ApiPropertyOptional({ description: 'Audio MIME type, e.g. audio/ogg', default: 'audio/ogg' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  mimeType?: string;
}

/**
 * Route a broker voice command. Supply either a ready `transcription`, or a
 * `mediaUrl` (+ mimeType) to transcribe first.
 */
export class BrokerVoiceCommandDto {
  @ApiPropertyOptional({ description: 'Pre-transcribed command text' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  transcription?: string;

  @ApiPropertyOptional({ description: 'Voice-note media reference to transcribe' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  mediaUrl?: string;

  @ApiPropertyOptional({ description: 'Audio MIME type', default: 'audio/ogg' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  mimeType?: string;
}

/** History listing query. */
export class ListVoiceCommandsQueryDto {
  @ApiPropertyOptional({ description: 'Max rows (1–200)', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
