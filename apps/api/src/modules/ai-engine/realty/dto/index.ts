import {
  IsString,
  IsOptional,
  IsUUID,
  IsNotEmpty,
  IsBoolean,
  IsArray,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Drive one grounded realty AI turn for a known lead. The buyer's message is
 * untrusted; everything else is context the orchestrator uses for grounding.
 */
export class RealtyTurnDto {
  @ApiProperty({ description: 'The lead this turn belongs to' })
  @IsUUID()
  leadId!: string;

  @ApiProperty({ description: 'The buyer WhatsApp message (untrusted input)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  messageText!: string;

  @ApiPropertyOptional({ description: 'Bridge to the conversation for the transcript' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Whether the 24h WhatsApp service window is open', default: true })
  @IsOptional()
  @IsBoolean()
  serviceWindowOpen?: boolean;

  @ApiPropertyOptional({ description: 'Sales-playbook chunks (RAG) to ground tone/objection handling', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  playbookChunks?: string[];

  @ApiPropertyOptional({ description: 'Compact calendar snapshot of upcoming visit slots' })
  @IsOptional()
  @IsString()
  calendarSnapshot?: string;

  @ApiPropertyOptional({ description: 'Correlation id for tracing' })
  @IsOptional()
  @IsString()
  correlationId?: string;
}

/** Classify a single realty message (diagnostics / analytics). */
export class RealtyClassifyDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text!: string;
}
