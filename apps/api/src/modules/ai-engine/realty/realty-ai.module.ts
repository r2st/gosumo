import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../../common/services/prisma.service';
import { RealtyLeadsModule } from '../../realty-leads/realty-leads.module';
import { RealtyInventoryModule } from '../../realty-inventory/realty-inventory.module';
import { LlmClientService } from '../pipeline/llm-client.service';
import { GuardrailsService } from '../safety/guardrails.service';
import { RealtyAiController } from './realty-ai.controller';
import { RealtyAiService } from './realty-ai.service';
import { RealtyIntentClassifierService } from './realty-intent-classifier.service';
import { BltcExtractorService } from './bltc-extractor.service';
import { RealtyGuardrailsService } from './realty-guardrails.service';
import { RealtyResponseParserService } from './realty-response.parser';
import { RealtyAuditService } from './realty-audit.service';

/**
 * RealtyAiModule — the GoSumo Realty AI loop (blueprint §16), layered on top of
 * the general `ai-engine`. It grounds every turn in verified inventory
 * (`realty-inventory`) and lead state (`realty-leads`), and reuses the base
 * `LlmClientService` (Claude) + `GuardrailsService` (jailbreak/PII), which are
 * stateless and provided locally here.
 */
@Module({
  imports: [ConfigModule, RealtyLeadsModule, RealtyInventoryModule],
  controllers: [RealtyAiController],
  providers: [
    RealtyAiService,
    RealtyIntentClassifierService,
    BltcExtractorService,
    RealtyGuardrailsService,
    RealtyResponseParserService,
    RealtyAuditService,
    LlmClientService,
    GuardrailsService,
    PrismaService,
  ],
  exports: [RealtyAiService, RealtyIntentClassifierService, BltcExtractorService, RealtyGuardrailsService],
})
export class RealtyAiModule {}
