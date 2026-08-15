import { Global, Module } from '@nestjs/common';
import { ConversationLockService } from './conversation-lock.service';

/**
 * Global because the lock is only a lock if everyone shares one instance.
 *
 * The inbound path crosses modules — channel-adapter stores the message, then
 * ai-engine or the realty bridge reasons over it — and a per-module provider
 * would give each of them its own map of chains, so two holders of "the same"
 * key would never see each other. One instance, one map.
 */
@Global()
@Module({
  providers: [ConversationLockService],
  exports: [ConversationLockService],
})
export class ConversationLockModule {}
