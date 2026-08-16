import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BullModule } from '@nestjs/bull';
import appConfig from './config/app.config';
import { QueueTelemetryModule } from './common/queue/queue-telemetry.module';
import { ConversationLockModule } from './common/services/conversation-lock.module';
import { PrismaModule } from './common/services/prisma.module';
import { ResilienceModule } from './common/resilience/resilience.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { VersioningModule } from './common/versioning/versioning.module';
import { JOB_TIMEOUT_MS } from './common/queue/queue.constants';

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
import { AuditModule } from './modules/audit/audit.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AdminModule } from './modules/admin/admin.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { RealtyLeadsModule } from './modules/realty-leads/realty-leads.module';
import { RealtyInventoryModule } from './modules/realty-inventory/realty-inventory.module';
import { RealtyAiModule } from './modules/ai-engine/realty/realty-ai.module';
import { RealtyVoiceModule } from './modules/ai-engine/realty/voice/realty-voice.module';
import { RealtyVisitsModule } from './modules/realty-sitevisits/realty-sitevisits.module';
import { RealtyIngestionModule } from './modules/realty-ingestion/realty-ingestion.module';
import { RealtyCadenceModule } from './modules/realty-cadence/realty-cadence.module';
import { RealtyBrokerModule } from './modules/realty-broker/realty-broker.module';
import { RealtyHardeningModule } from './modules/realty-hardening/realty-hardening.module';
import { RealtyPilotModule } from './modules/realty-pilot/realty-pilot.module';
import { RealtyExchangeModule } from './modules/realty-exchange/realty-exchange.module';
import { RealtyIntelligenceModule } from './modules/realty-intelligence/realty-intelligence.module';
import { BillingModule } from './modules/billing/billing.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { RealtyIntegrationsModule } from './modules/realty-integrations/realty-integrations.module';
import { ContactModule } from './modules/contact/contact.module';
import { CannedResponseModule } from './modules/canned-response/canned-response.module';
import { SlaModule } from './modules/sla/sla.module';
import { AgentPerformanceModule } from './modules/agent-performance/agent-performance.module';
import { WebhookLogModule } from './modules/webhook-log/webhook-log.module';
import { ConversationSearchModule } from './modules/conversation-search/conversation-search.module';
import { DataExportModule } from './modules/data-export/data-export.module';
import { HealthModule } from './modules/health/health.module';

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
          host: configService.get<string>('app.redis.host', 'localhost'),
          port: configService.get<number>('app.redis.port', 6379),
          password: configService.get<string>('app.redis.password'),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
          // A job with no timeout that hangs never fails, and a job that never
          // fails never retries: it holds its concurrency slot until the
          // process restarts, and the queue quietly loses throughput with
          // nothing in the logs. Outbound HTTP is separately bounded, so this
          // is the backstop for everything else (a stuck Prisma call, an
          // unresolved promise) and is set high enough that no legitimate job
          // is cut short — anything genuinely running for five minutes in a
          // worker is a problem worth surfacing rather than waiting out.
          timeout: JOB_TIMEOUT_MS,
          removeOnComplete: 100,
          removeOnFail: 50,
        },
      }),
      inject: [ConfigService],
    }),

    // Watches every registered queue for failed / stalled / errored jobs.
    // Global, and imported before the feature modules that register queues —
    // discovery runs at onApplicationBootstrap, by which point they all exist.
    QueueTelemetryModule,

    // Serializes work per conversation across the whole inbound path. Global,
    // and imported before the feature modules that take the lock.
    ConversationLockModule,

    // The one Prisma client. Global, and imported before anything that injects
    // it — a feature module must never provide its own, which would give it a
    // private connection pool. See PrismaModule.
    PrismaModule,

    // The circuit breakers guarding every external dependency. Global, and
    // imported before the feature modules that resolve breakers from it —
    // two registries means two independent breakers per provider, and
    // neither would protect the other. See ResilienceModule.
    ResilienceModule,

    // Health probes — first so /v1/health stays answerable even while a
    // later module is still warming up.
    HealthModule,

    // Feature modules
    AuthModule,
    // Immediately after AuthModule, and not before it: global APP_GUARDs run
    // in declaration order, and the per-tenant limiter needs the user
    // JwtAuthGuard attaches to know which business to charge.
    RateLimitModule,
    // Deprecation signalling. Opt-in per route, so registering it changes
    // nothing until a route carries @ApiDeprecated().
    VersioningModule,
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
    AuditModule,
    AnalyticsModule,
    AdminModule,
    ChannelsModule,
    IntegrationsModule,
    OnboardingModule,

    // GoSumo Realty
    RealtyLeadsModule,
    RealtyInventoryModule,
    RealtyAiModule,
    RealtyVoiceModule,
    RealtyVisitsModule,
    RealtyIngestionModule,
    RealtyCadenceModule,
    RealtyBrokerModule,
    RealtyHardeningModule,
    RealtyPilotModule,
    RealtyExchangeModule,
    RealtyIntelligenceModule,
    BillingModule,
    ComplianceModule,
    RealtyIntegrationsModule,

    // Operations: contacts, canned responses, SLA, agent performance, webhook log
    ContactModule,
    CannedResponseModule,
    SlaModule,
    AgentPerformanceModule,
    WebhookLogModule,
    ConversationSearchModule,
    DataExportModule,
  ],
})
export class AppModule {}
