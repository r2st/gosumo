import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';
import { MessageRepository } from './message.repository';
import { PrismaService } from '../../common/services/prisma.service';

@Module({
  controllers: [MessageController],
  providers: [MessageService, MessageRepository, PrismaService],
  exports: [MessageService],
})
export class MessageModule {}
