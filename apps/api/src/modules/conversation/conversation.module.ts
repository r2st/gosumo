import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/services/prisma.service';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';

@Module({
  controllers: [ConversationController],
  providers: [ConversationService, ConversationRepository, PrismaService],
  exports: [ConversationService],
})
export class ConversationModule {}
