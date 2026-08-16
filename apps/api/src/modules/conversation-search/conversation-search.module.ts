import { Module } from '@nestjs/common';
import { ConversationSearchController } from './conversation-search.controller';
import { ConversationSearchService } from './conversation-search.service';
import { ConversationSearchRepository } from './conversation-search.repository';

/**
 * ConversationSearchModule — full-text search over conversation history.
 *
 * A module of its own rather than an endpoint on `conversation` or `message`,
 * because the query spans both tables and belongs to neither: it reads
 * `messages` for the match, `conversations` for the filters and context, and
 * `clients` for the name on the result row. Owning it here keeps the read-only
 * cross-table join in one place — the same arrangement `analytics` uses, and
 * for the same reason.
 *
 * It writes nothing and owns no table.
 */
@Module({
  controllers: [ConversationSearchController],
  providers: [ConversationSearchService, ConversationSearchRepository],
  exports: [ConversationSearchService],
})
export class ConversationSearchModule {}
