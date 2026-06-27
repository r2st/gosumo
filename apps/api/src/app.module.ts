import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bull';
import appConfig from './config/app.config';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { TenantModule } from './modules/tenant/tenant.module';
import { ChannelAdapterModule } from './modules/channel-adapter/channel-adapter.module';
import { ConversationModule } from './modules/conversation/conversation.module';
import { MessageModule } from './modules/message/message.module';
import { AiEngineModule } from './modules/ai-engine/ai-engine.module';
import { ClientIntelligenceModule } from './modules/client-intelligence/client-intelligence.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { BookingModule } from './modules/booking/booking.module';
import { PaymentModule } from './modules/payment/payment.module';
import { OrderModule } from './modules/order/order.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { CampaignModule } from './modules/campaign/campaign.module';
import { HitlModule } from './modules/hitl/hitl.module';
import { NotificationModule } from './modules/notification/notification.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    // Configuration — global so all modules can inject ConfigService
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: ['.env.local', '.env'],
      cache: true,
    }),

    // Event emitter for domain events
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),

    // Bull queue backed by Redis
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get<string>('redis.host', 'localhost'),
          port: configService.get<number>('redis.port', 6379),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      }),
      inject: [ConfigService],
    }),

    // Feature modules
    AuthModule,
    TenantModule,
    ChannelAdapterModule,
    ConversationModule,
    MessageModule,
    AiEngineModule,
    ClientIntelligenceModule,
    CatalogModule,
    BookingModule,
    PaymentModule,
    OrderModule,
    ShippingModule,
    CampaignModule,
    HitlModule,
    NotificationModule,
    AnalyticsModule,
    AdminModule,
  ],
})
export class AppModule {}
