import { Module } from '@nestjs/common';

import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeRepository } from './knowledge.repository';

/**
 * KnowledgeModule — PostgreSQL-backed FAQ and help articles.
 *
 * Exported because the AI engine injects `KnowledgeService` for the grounding
 * path: a synchronous read on the message hot path, which is the case the root
 * guidance says to use direct injection for rather than an event.
 */
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeRepository],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
