import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { MessageTemplateController } from './message-template.controller';
import { MessageService } from './message.service';
import { MessageTemplateService } from './message-template.service';
import { MessageRepository } from './message.repository';
import { PrismaService } from '../../common/services/prisma.service';

@Module({
  controllers: [MessageController, MessageTemplateController],
  providers: [
    MessageService,
    MessageTemplateService,
    MessageRepository,
    PrismaService,
  ],
  exports: [MessageService, MessageTemplateService],
})
export class MessageModule {}
