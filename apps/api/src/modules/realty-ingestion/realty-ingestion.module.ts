import { Module } from '@nestjs/common';
import { RealtyIngestionController } from './realty-ingestion.controller';
import { RealtyIngestionService } from './realty-ingestion.service';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';

/**
 * RealtyIngestionModule (GoSumo Realty, Phase 4) — the ingress for every
 * external lead source: Meta Leadgen webhooks, property-portal enquiry emails,
 * CSV bulk imports, and Click-to-WhatsApp context.
 *
 * Stateless — it owns no table. It parses source-specific payloads and delegates
 * to `RealtyLeadsService.ingestLead` (imported via RealtyLeadsModule) for the
 * E.164 identity-merge and the `realty.lead.ingested` event.
 */
@Module({
  imports: [RealtyLeadsModule],
  controllers: [RealtyIngestionController],
  providers: [RealtyIngestionService],
  exports: [RealtyIngestionService],
})
export class RealtyIngestionModule {}
