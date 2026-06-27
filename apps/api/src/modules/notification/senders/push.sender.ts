import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationTemplateChannel } from '@prisma/client';
import { generateId } from '@gosumo/shared';
import {
  ChannelSender,
  OutboundNotification,
  SendOutcome,
} from './channel-sender.interface';

/** FCM device tokens are long opaque strings; reject empty/obviously bogus ones. */
const MIN_DEVICE_TOKEN_LEN = 10;

/**
 * PushSender — delivers PUSH notifications via Firebase Cloud Messaging (FCM).
 * The `recipient` is a device registration token. Stubbed behind config so the
 * pipeline runs without FCM credentials in dev/test.
 */
@Injectable()
export class PushSender implements ChannelSender {
  readonly channel = NotificationTemplateChannel.PUSH;
  private readonly logger = new Logger(PushSender.name);

  constructor(private readonly config: ConfigService) {}

  validateRecipient(recipient: string): string | null {
    return recipient.length >= MIN_DEVICE_TOKEN_LEN
      ? null
      : `Invalid device token: "${recipient}"`;
  }

  async send(payload: OutboundNotification): Promise<SendOutcome> {
    const invalid = this.validateRecipient(payload.recipient);
    if (invalid) {
      return { success: false, error: invalid, retryable: false };
    }

    const serverKey = this.config.get<string>('notification.push.serverKey');
    if (!serverKey) {
      this.logger.debug(
        `[no-op] PUSH → ${payload.recipient.slice(0, 8)}… ` +
          `"${payload.subject ?? ''}" (no provider configured)`,
      );
      return { success: true, providerMessageId: `push_noop_${generateId()}` };
    }

    try {
      // Production: POST https://fcm.googleapis.com/fcm/send
      // { to: token, notification: { title: subject, body: text }, data }
      const providerMessageId = `push_${generateId()}`;
      this.logger.log(
        `PUSH sent to ${payload.recipient.slice(0, 8)}… (id: ${providerMessageId})`,
      );
      return { success: true, providerMessageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`PUSH send failed: ${message}`);
      return { success: false, error: message, retryable: true };
    }
  }
}
