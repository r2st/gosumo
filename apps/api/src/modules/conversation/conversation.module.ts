import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';
import { ConversationProcessor } from './conversation.processor';
import { AuditLogService } from '../../common/services/audit-log.service';
import { TenantModule } from '../tenant/tenant.module';
import { CONVERSATION_QUEUE } from './conversation.constants';

/**
 * ConversationModule — registers the `conversation` Bull queue used for the
 * delayed snooze-wake job (the Redis connection is configured globally in
 * app.module.ts via BullModule.forRootAsync).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: CONVERSATION_QUEUE }),
    // Tenant-scoped team-member read for the assignee guard.
    TenantModule,
  ],
  controllers: [ConversationController],
  providers: [
    ConversationService,
    ConversationRepository,
    ConversationProcessor,
    // Provided locally rather than imported: the service is a stateless writer
    // over the globally-provided PrismaService, and `tenant` does the same.
    AuditLogService,
  ],
  exports: [ConversationService],
})
export class ConversationModule {}
