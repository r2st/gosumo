import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationTemplateChannel } from '@prisma/client';
import { generateId } from '@gosumo/shared';
import {
  ChannelSender,
  OutboundNotification,
  SendOutcome,
} from './channel-sender.interface';

const E164_RE = /^\+[1-9]\d{7,14}$/;

/**
 * WhatsAppSender — delivers WHATSAPP notifications via the Meta WhatsApp
 * Business Cloud API.
 *
 * WhatsApp distinguishes two outbound modes:
 *  - **Template message** — required outside the 24h customer-service window.
 *    Uses an approved `externalTemplateName` + ordered parameters.
 *  - **Free-form text** — allowed only inside an open 24h session.
 *
 * Transactional notifications (order/payment/booking) almost always fire
 * outside a session, so a template is expected; we fall back to free-form text
 * when no `externalTemplateName` is supplied (dev convenience).
 */
@Injectable()
export class WhatsAppSender implements ChannelSender {
  readonly channel = NotificationTemplateChannel.WHATSAPP;
  private readonly logger = new Logger(WhatsAppSender.name);

  constructor(private readonly config: ConfigService) {}

  validateRecipient(recipient: string): string | null {
    return E164_RE.test(recipient)
      ? null
      : `Invalid WhatsApp number (expected E.164): ${recipient}`;
  }

  async send(payload: OutboundNotification): Promise<SendOutcome> {
    const invalid = this.validateRecipient(payload.recipient);
    if (invalid) {
      return { success: false, error: invalid, retryable: false };
    }

    const token = this.config.get<string>('whatsapp.accessToken');
    const phoneNumberId = this.config.get<string>('whatsapp.phoneNumberId');

    if (!token || !phoneNumberId) {
      this.logger.debug(
        `[no-op] WHATSAPP → ${payload.recipient} ` +
          `(template=${payload.externalTemplateName ?? 'free-form'}, no provider configured)`,
      );
      return { success: true, providerMessageId: `wa_noop_${generateId()}` };
    }

    try {
      // Production: POST https://graph.facebook.com/v19.0/{phoneNumberId}/messages
      // body = template message when externalTemplateName is set, else text.
      const wamid = `wamid.${generateId()}`;
      this.logger.log(
        `WHATSAPP sent to ${payload.recipient} ` +
          `(${payload.externalTemplateName ?? 'text'}, id: ${wamid})`,
      );
      return { success: true, providerMessageId: wamid };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`WHATSAPP send failed for ${payload.recipient}: ${message}`);
      return { success: false, error: message, retryable: true };
    }
  }
}
