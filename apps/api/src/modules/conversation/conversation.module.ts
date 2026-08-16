import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { ConversationRepository } from './conversation.repository';
import { ConversationProcessor } from './conversation.processor';
import { ConversationTaggingService } from './tagging/conversation-tagging.service';
import { ConversationTagRepository } from './tagging/conversation-tag.repository';
import { LlmClientService } from '../ai-engine/pipeline/llm-client.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { TenantModule } from '../tenant/tenant.module';
import { MessageModule } from '../message/message.module';
import { CONVERSATION_QUEUE } from './conversation.constants';

/**
 * ConversationModule — registers the `conversation` Bull queue used for the
 * delayed snooze-wake job (the Redis connection is configured globally in
 * app.module.ts via BullModule.forRootAsync).
 *
 * `MessageModule` is imported for the auto-tagger's transcript read, which goes
 * through `MessageService` rather than querying `messages` here. It has no
 * imports of its own, so this cannot cycle.
 *
 * `LlmClientService` is provided locally rather than importing AiEngineModule:
 * it is a stateless wrapper over `fetch` that needs only `ConfigService`, and
 * importing the whole engine to reach it would pull the RAG and pipeline graph
 * into a module that wants one completion call. `onboarding` does the same.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: CONVERSATION_QUEUE }),
    // Tenant-scoped team-member read for the assignee guard.
    TenantModule,
    MessageModule,
  ],
  controllers: [ConversationController],
  providers: [
    ConversationService,
    ConversationRepository,
    ConversationProcessor,
    ConversationTaggingService,
    ConversationTagRepository,
    LlmClientService,
    // Provided locally rather than imported: the service is a stateless writer
    // over the globally-provided PrismaService, and `tenant` does the same.
    AuditLogService,
  ],
  exports: [ConversationService, ConversationTaggingService],
})
export class ConversationModule {}
