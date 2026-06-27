import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─────────────────────────────────────────────
// WhatsApp Verification (GET challenge)
// ─────────────────────────────────────────────

/**
 * Query parameters sent by Meta during the webhook verification handshake.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#configure-webhooks-product
 */
export class WhatsAppVerifyQueryDto {
  @ApiProperty({
    description: "Meta's hub mode — always 'subscribe' during verification",
    example: 'subscribe',
  })
  @IsString()
  @IsNotEmpty()
  'hub.mode'!: string;

  @ApiProperty({
    description: 'Random string Meta sends; must be echoed back in the response',
    example: '1158201444',
  })
  @IsString()
  @IsNotEmpty()
  'hub.challenge'!: string;

  @ApiPropertyOptional({
    description: 'Must match WHATSAPP_VERIFY_TOKEN env var',
    example: 'gosumo-wa-verify-token',
  })
  @IsString()
  'hub.verify_token'?: string;
}

// ─────────────────────────────────────────────
// Generic inbound webhook body
// ─────────────────────────────────────────────

/**
 * Minimal shape validation for generic channel webhook bodies.
 * Full payload validation is delegated to the channel adapter's
 * parseInbound() implementation.
 */
export class GenericWebhookDto {
  // Intentionally loose — body shape is channel-specific and validated
  // by the adapter. We keep the DTO here as a marker for Swagger docs.
  [key: string]: unknown;
}
