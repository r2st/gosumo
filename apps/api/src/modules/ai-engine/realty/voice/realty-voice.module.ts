import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RealtyAiModule } from '../realty-ai.module';
import { RealtyLeadsModule } from '../../../realty-leads/realty-leads.module';
import { RealtyInventoryModule } from '../../../realty-inventory/realty-inventory.module';
import { RealtyCadenceModule } from '../../../realty-cadence/realty-cadence.module';
import { RealtyVisitsModule } from '../../../realty-sitevisits/realty-sitevisits.module';
import { ChannelAdapterModule } from '../../../channel-adapter/channel-adapter.module';
import { RealtyVoiceController } from './realty-voice.controller';
import { VoiceNoteProcessorService } from './voice-note-processor.service';
import { TranscriptionService } from './transcription.service';
import { VoiceCommandHistoryService } from './voice-command-history.service';
import { VoiceMessageRouter } from './voice-message.router';

/**
 * RealtyVoiceModule (GoSumo Realty — voice, blueprint §5.3).
 *
 * Speech-to-text plus two flows on top of it: buyer voice notes (auto-routed
 * off `message.received` into the realty AI turn) and broker voice commands
 * (dictated from the field, parsed and routed to cadence / inventory / lead
 * assignment / site visits). Reuses the realty AI loop, lead/inventory/cadence/
 * visit services, and the channel adapter (for media download).
 */
@Module({
  imports: [
    ConfigModule,
    RealtyAiModule,
    RealtyLeadsModule,
    RealtyInventoryModule,
    RealtyCadenceModule,
    RealtyVisitsModule,
    ChannelAdapterModule,
  ],
  controllers: [RealtyVoiceController],
  providers: [
    VoiceNoteProcessorService,
    TranscriptionService,
    VoiceCommandHistoryService,
    VoiceMessageRouter,
  ],
  exports: [VoiceNoteProcessorService, TranscriptionService],
})
export class RealtyVoiceModule {}
