import {
  IsEnum,
  IsString,
  IsNotEmpty,
  MaxLength,
  IsObject,
  IsOptional,
} from 'class-validator';
import { ChannelType } from '@gosumo/shared';

/**
 * DTO for connecting a new messaging channel to a business.
 *
 * channelType: the channel being connected (WHATSAPP, INSTAGRAM, SMS, etc.)
 * name: human-friendly label, e.g. "Main WhatsApp"
 * externalId: provider-assigned account ID (phone number ID, IG account ID, etc.)
 * credentials: encrypted provider credentials (API keys, tokens, etc.)
 */
export class ConnectChannelDto {
  @IsEnum(ChannelType)
  channelType!: ChannelType;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  externalId!: string;

  @IsObject()
  credentials!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  externalAccount?: string;
}
