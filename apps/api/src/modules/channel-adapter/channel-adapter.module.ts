import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChannelAdapterService } from './channel-adapter.service';
import { ChannelAdapterController } from './channel-adapter.controller';
import { WebChatWidgetController } from './webchat-widget';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';
import { SmsAdapter } from './adapters/sms.adapter';
import { WebChatAdapter } from './adapters/webchat.adapter';
import { EmailAdapter } from './adapters/email.adapter';
import { WebChatGateway } from './gateways/webchat.gateway';
import { WebChatThrottle } from './gateways/webchat-throttle';
import { ChannelsModule } from '../channels/channels.module';
import { WebhookLogModule } from '../webhook-log/webhook-log.module';

/**
 * ChannelAdapterModule
 *
 * Wires together all channel adapters and exposes:
 *  - ChannelAdapterService    — the public API for other modules
 *  - Webhook controller       — /webhooks/* REST endpoints
 *  - WebChat widget + gateway — Socket.IO entry point for web chat
 *
 * ## Adding a new channel adapter
 *
 * 1. Create `adapters/<channel>.adapter.ts` extending BaseChannelAdapter
 * 2. Add it to the `providers` array below and inject it into the constructor
 * 3. Register it in `onModuleInit()` via `registerAdapter()`
 *
 * The controller's generic /:channel route picks it up automatically.
 */
@Module({
  imports: [
    ConfigModule,
    forwardRef(() => ChannelsModule),
    // Supplies the dead-letter queue a failed inbound delivery is parked in.
    // Without it a message whose processing throws is lost: `webhook_events`
    // has already recorded the delivery, so the provider's redelivery — the
    // only retry there was — comes back and is discarded as a duplicate.
    WebhookLogModule,
  ],
  controllers: [ChannelAdapterController, WebChatWidgetController],
  providers: [
    ChannelAdapterService,
    WhatsAppAdapter,
    InstagramAdapter,
    SmsAdapter,
    WebChatAdapter,
    EmailAdapter,
    WebChatGateway,
    WebChatThrottle,
  ],
  exports: [ChannelAdapterService],
})
export class ChannelAdapterModule implements OnModuleInit {
  constructor(
    private readonly channelAdapterService: ChannelAdapterService,
    private readonly whatsAppAdapter: WhatsAppAdapter,
    private readonly instagramAdapter: InstagramAdapter,
    private readonly smsAdapter: SmsAdapter,
    private readonly webChatAdapter: WebChatAdapter,
    private readonly emailAdapter: EmailAdapter,
  ) {}

  /**
   * Register all channel adapters when the module initialises.
   * This runs after all providers are constructed, so adapters
   * have their dependencies injected before registration.
   */
  onModuleInit(): void {
    this.channelAdapterService.registerAdapter(this.whatsAppAdapter);
    this.channelAdapterService.registerAdapter(this.instagramAdapter);
    this.channelAdapterService.registerAdapter(this.smsAdapter);
    this.channelAdapterService.registerAdapter(this.webChatAdapter);
    this.channelAdapterService.registerAdapter(this.emailAdapter);
  }
}
