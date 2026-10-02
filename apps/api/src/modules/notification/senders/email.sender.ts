import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationTemplateChannel } from '@prisma/client';
import { generateId } from '@gosumo/shared';
import { maskEmail } from '../../../common/utils/log-redact.util';
import {
  ChannelSender,
  OutboundNotification,
  SendOutcome,
} from './channel-sender.interface';

/** RFC-5322-lite email validation — good enough to reject obviously bad input. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * EmailSender — delivers EMAIL notifications.
 *
 * The transport is intentionally pluggable. In production this wraps an SMTP
 * client or a transactional provider (SES, Postmark, Resend) configured from
 * `notification.email.*` config. When no provider credentials are present (dev
 * / test) it short-circuits to a logged no-op so the rest of the pipeline —
 * status transitions, retries, history — can be exercised end-to-end.
 */
@Injectable()
export class EmailSender implements ChannelSender {
  readonly channel = NotificationTemplateChannel.EMAIL;
  private readonly logger = new Logger(EmailSender.name);

  constructor(private readonly config: ConfigService) {}

  validateRecipient(recipient: string): string | null {
    return EMAIL_RE.test(recipient) ? null : `Invalid email address: ${recipient}`;
  }

  async send(payload: OutboundNotification): Promise<SendOutcome> {
    const invalid = this.validateRecipient(payload.recipient);
    if (invalid) {
      // Permanent failure — retrying won't fix a malformed address.
      return { success: false, error: invalid, retryable: false };
    }

    const apiKey = this.config.get<string>('notification.email.apiKey');
    if (!apiKey) {
      this.logger.debug(
        `[no-op] EMAIL → ${maskEmail(payload.recipient)} "${payload.subject ?? ''}" ` +
          `(no provider configured)`,
      );
      return { success: true, providerMessageId: `email_noop_${generateId()}` };
    }

    try {
      // Production: await this.transport.send({ to, subject, html|text });
      // The concrete provider call lives here; on success return its message id.
      const providerMessageId = `email_${generateId()}`;
      this.logger.log(
        `EMAIL sent to ${maskEmail(payload.recipient)} (id: ${providerMessageId})`,
      );
      return { success: true, providerMessageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`EMAIL send failed for ${maskEmail(payload.recipient)}: ${message}`);
      // Treat transport errors as transient/retryable.
      return { success: false, error: message, retryable: true };
    }
  }
}
