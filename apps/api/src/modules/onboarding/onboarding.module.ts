import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingAssistantService } from './onboarding-assistant.service';
import { OnboardingRepository } from './onboarding.repository';
import { PrismaService } from '../../common/services/prisma.service';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';

/**
 * OnboardingModule — the guided onboarding wizard + AI assistant.
 *
 * Owns no tables of its own; onboarding state lives in
 * `businesses.onboarding_progress`. Reuses the ai-engine's `LlmClientService`
 * (a stateless Claude wrapper depending only on ConfigService) for the chat
 * assistant, so it does not pull in the full AI pipeline graph.
 */
@Module({
  imports: [ConfigModule],
  controllers: [OnboardingController],
  providers: [
    OnboardingService,
    OnboardingAssistantService,
    OnboardingRepository,
    PrismaService,
    LlmClientService,
  ],
  exports: [OnboardingService],
})
export class OnboardingModule {}
