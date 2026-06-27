import { Module, OnModuleInit, forwardRef } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ChannelAdapterService } from "./channel-adapter.service";
import { ChannelAdapterController } from "./channel-adapter.controller";
import { WebChatWidgetController } from "./webchat-widget";
import { WhatsAppAdapter } from "./adapters/whatsapp.adapter";
import { InstagramAdapter } from "./adapters/instagram.adapter";
import { SmsAdapter } from "./adapters/sms.adapter";
import { WebChatAdapter } from "./adapters/webchat.adapter";
import { EmailAdapter } from "./adapters/email.adapter";
import { WebChatGateway } from "./gateways/webchat.gateway";
import { PrismaService } from "../../common/services/prisma.service";
import { ChannelsModule } from "../channels/channels.module";

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => ChannelsModule),
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
    PrismaService,
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

  onModuleInit(): void {
    this.channelAdapterService.registerAdapter(this.whatsAppAdapter);
    this.channelAdapterService.registerAdapter(this.instagramAdapter);
    this.channelAdapterService.registerAdapter(this.smsAdapter);
    this.channelAdapterService.registerAdapter(this.webChatAdapter);
    this.channelAdapterService.registerAdapter(this.emailAdapter);
  }
}
