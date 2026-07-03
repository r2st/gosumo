import { Module } from '@nestjs/common';
import { RealtyIngestionController } from './realty-ingestion.controller';
import { RealtyIngestionService } from './realty-ingestion.service';
import { RealtyIvrService } from './realty-ivr.service';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';
import { ChannelAdapterModule } from '../channel-adapter/channel-adapter.module';
import { PrismaService } from '../../common/services/prisma.service';

/**
 * RealtyIngestionModule (GoSumo Realty, Phase 4) — the ingress for every
 * external lead source: Meta Leadgen webhooks, property-portal enquiry emails,
 * CSV bulk imports, Click-to-WhatsApp context, and IVR missed-calls.
 *
 * Mostly stateless — it owns no table. It parses source-specific payloads and
 * delegates to `RealtyLeadsService.ingestLead` (imported via RealtyLeadsModule)
 * for the E.164 identity-merge and the `realty.lead.ingested` event. The IVR
 * bridge additionally sends the instant WhatsApp greeting via the channel
 * adapter (blueprint §5.1).
 */
@Module({
  imports: [RealtyLeadsModule, ChannelAdapterModule],
  controllers: [RealtyIngestionController],
  providers: [RealtyIngestionService, RealtyIvrService, PrismaService],
  exports: [RealtyIngestionService, RealtyIvrService],
})
export class RealtyIngestionModule {}
