import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../common/services/prisma.service';
import { RealtyLeadsModule } from '../realty-leads/realty-leads.module';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';
import { RealtyExchangeController } from './realty-exchange.controller';
import { RealtyExchangeService } from './realty-exchange.service';
import { RealtyExchangeRepository } from './realty-exchange.repository';

/**
 * RealtyExchangeModule — the L2 co-broking exchange (blueprint §19). Depends on
 * `realty-leads` for the buyer-consent gate and BLTC profile behind matching,
 * and reuses the stateless `LlmClientService` (OpenRouter) for optional AI match
 * rationales, provided locally per the ai-engine pattern.
 */
@Module({
  imports: [ConfigModule, RealtyLeadsModule],
  controllers: [RealtyExchangeController],
  providers: [RealtyExchangeService, RealtyExchangeRepository, LlmClientService, PrismaService],
  exports: [RealtyExchangeService],
})
export class RealtyExchangeModule {}
