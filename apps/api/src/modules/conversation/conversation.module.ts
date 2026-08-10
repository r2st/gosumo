import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PrismaService } from '../../common/services/prisma.service';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';
import { ConversationProcessor } from './conversation.processor';
import { CONVERSATION_QUEUE } from './conversation.constants';

/**
 * ConversationModule — registers the `conversation` Bull queue used for the
 * delayed snooze-wake job (the Redis connection is configured globally in
 * app.module.ts via BullModule.forRootAsync).
 */
@Module({
  imports: [BullModule.registerQueue({ name: CONVERSATION_QUEUE })],
  controllers: [ConversationController],
  providers: [
    ConversationService,
    ConversationRepository,
    ConversationProcessor,
    PrismaService,
  ],
  exports: [ConversationService],
})
export class ConversationModule {}
