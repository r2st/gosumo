import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationTemplateChannel } from '@prisma/client';
import { ChannelSender } from './channel-sender.interface';
import { EmailSender } from './email.sender';
import { SmsSender } from './sms.sender';
import { WhatsAppSender } from './whatsapp.sender';
import { PushSender } from './push.sender';

/**
 * SenderRegistry — resolves a {@link ChannelSender} by channel.
 *
 * Mirrors the channel-adapter's registry pattern: the service stays
 * provider-agnostic and looks transports up here. All four built-in senders are
 * registered at construction; adding a channel means adding a sender and listing
 * it in the constructor.
 */
@Injectable()
export class SenderRegistry {
  private readonly logger = new Logger(SenderRegistry.name);
  private readonly registry = new Map<NotificationTemplateChannel, ChannelSender>();

  constructor(
    email: EmailSender,
    sms: SmsSender,
    whatsapp: WhatsAppSender,
    push: PushSender,
  ) {
    for (const sender of [email, sms, whatsapp, push]) {
      this.register(sender);
    }
  }

  register(sender: ChannelSender): void {
    this.registry.set(sender.channel, sender);
    this.logger.log(`Registered sender for channel: ${sender.channel}`);
  }

  /** Resolve the sender for a channel, or throw if none is registered. */
  get(channel: NotificationTemplateChannel): ChannelSender {
    const sender = this.registry.get(channel);
    if (!sender) {
      throw new NotFoundException(
        `No sender registered for channel: ${channel}. ` +
          `Registered: ${[...this.registry.keys()].join(', ') || 'none'}`,
      );
    }
    return sender;
  }

  has(channel: NotificationTemplateChannel): boolean {
    return this.registry.has(channel);
  }
}
