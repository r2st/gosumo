import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule } from '@nestjs/config';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';
import { RealtyIntelligenceController } from './realty-intelligence.controller';
import { RealtyIntelligenceService } from './realty-intelligence.service';
import { RealtyIntelligenceRepository } from './realty-intelligence.repository';
import { RealtyIntelligenceProcessor } from './realty-intelligence.processor';
import { REALTY_INTELLIGENCE_QUEUE } from './realty-intelligence.constants';

/**
 * RealtyIntelligenceModule (GoSumo Realty — L1, blueprint §18).
 *
 * The consented micro-market intelligence layer: nightly corridor aggregates,
 * corridor priors for the grounded AI prompt, per-business source ROI, and opt-in
 * consent. Registers the `realty-intelligence` Bull queue for the nightly run
 * (Redis connection is configured globally in app.module.ts via BullModule).
 *
 * Reuses `RealtyLeadsService` (public API) to read leads for aggregation, and
 * `LlmClientService` (OpenRouter free-tier, provided locally + stateless) for the
 * optional corridor summarization. Exports the service so the realty AI loop can
 * inject corridor context into the grounded matching prompt.
 */
@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue({ name: REALTY_INTELLIGENCE_QUEUE }),
    RealtyLeadsModule,
  ],
  controllers: [RealtyIntelligenceController],
  providers: [
    RealtyIntelligenceService,
    RealtyIntelligenceRepository,
    RealtyIntelligenceProcessor,
    LlmClientService,
  ],
  exports: [RealtyIntelligenceService],
})
export class RealtyIntelligenceModule {}
