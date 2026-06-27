import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ChannelAdapterService } from './channel-adapter.service';
import { ChannelAdapterController } from './channel-adapter.controller';
import { WhatsAppAdapter } from './adapters/whatsapp.adapter';
import { InstagramAdapter } from './adapters/instagram.adapter';

/**
 * ChannelAdapterModule
 *
 * Wires together all channel adapters and exposes:
 *  - ChannelAdapterService  — the public API for other modules
 *  - Webhook controller     — /webhooks/* REST endpoints
 *
 * ## Adding a new channel adapter
 *
 * 1. Create `adapters/<channel>.adapter.ts` extending BaseChannelAdapter
 * 2. Add it to the `providers` array below
 * 3. Inject it into ChannelAdapterModuleInit and call
 *    `this.channelAdapterService.registerAdapter(adapter)` in onModuleInit()
 *
 * The controller's generic /:channel route picks it up automatically.
 */
@Module({
  imports: [
    // ConfigModule is global so we just list it here for documentation clarity
    ConfigModule,
    // EventEmitterModule is global (registered in AppModule) — no forRoot needed
  ],
  controllers: [ChannelAdapterController],
  providers: [
    ChannelAdapterService,
    WhatsAppAdapter,
    InstagramAdapter,
    // Add future adapters here:
    // SmsAdapter,
    // WebChatAdapter,
    // EmailAdapter,
  ],
  exports: [ChannelAdapterService],
})
export class ChannelAdapterModule implements OnModuleInit {
  constructor(
    private readonly channelAdapterService: ChannelAdapterService,
    private readonly whatsAppAdapter: WhatsAppAdapter,
    private readonly instagramAdapter: InstagramAdapter,
  ) {}

  /**
   * Register all channel adapters when the module initialises.
   * This runs after all providers are constructed, so adapters
   * have their dependencies injected before registration.
   */
  onModuleInit(): void {
    this.channelAdapterService.registerAdapter(this.whatsAppAdapter);
    this.channelAdapterService.registerAdapter(this.instagramAdapter);
    // Register additional adapters as they are implemented:
    // this.channelAdapterService.registerAdapter(this.smsAdapter);
  }
}
