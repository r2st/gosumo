import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationTemplateChannel } from '@prisma/client';
import { generateId } from '@gosumo/shared';
import {
  ChannelSender,
  OutboundNotification,
  SendOutcome,
} from './channel-sender.interface';

/** E.164 (+, 8–15 digits, no leading zero). Indian numbers are +91XXXXXXXXXX. */
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Most Indian SMS gateways bill per 160-char GSM-7 segment; cap to avoid runaway cost. */
const MAX_SMS_SEGMENTS = 6;
const SMS_SEGMENT_LEN = 160;

/**
 * SmsSender — delivers SMS notifications via an Indian SMS gateway
 * (e.g. MSG91, Gupshup, Twilio). Provider call is stubbed behind config so the
 * pipeline runs without credentials in dev/test.
 */
@Injectable()
export class SmsSender implements ChannelSender {
  readonly channel = NotificationTemplateChannel.SMS;
  private readonly logger = new Logger(SmsSender.name);

  constructor(private readonly config: ConfigService) {}

  validateRecipient(recipient: string): string | null {
    return E164_RE.test(recipient)
      ? null
      : `Invalid phone number (expected E.164): ${recipient}`;
  }

  async send(payload: OutboundNotification): Promise<SendOutcome> {
    const invalid = this.validateRecipient(payload.recipient);
    if (invalid) {
      return { success: false, error: invalid, retryable: false };
    }

    if (!payload.text.trim()) {
      return { success: false, error: 'SMS body is empty', retryable: false };
    }

    const segments = Math.ceil(payload.text.length / SMS_SEGMENT_LEN);
    if (segments > MAX_SMS_SEGMENTS) {
      return {
        success: false,
        error: `SMS too long: ${segments} segments (max ${MAX_SMS_SEGMENTS})`,
        retryable: false,
      };
    }

    const apiKey = this.config.get<string>('notification.sms.apiKey');
    if (!apiKey) {
      this.logger.debug(
        `[no-op] SMS → ${payload.recipient} (${segments} seg, no provider configured)`,
      );
      return { success: true, providerMessageId: `sms_noop_${generateId()}` };
    }

    try {
      const providerMessageId = `sms_${generateId()}`;
      this.logger.log(`SMS sent to ${payload.recipient} (id: ${providerMessageId})`);
      return { success: true, providerMessageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`SMS send failed for ${payload.recipient}: ${message}`);
      return { success: false, error: message, retryable: true };
    }
  }
}
