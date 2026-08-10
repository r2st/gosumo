import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ConversationService } from './conversation.service';
import { CONVERSATION_QUEUE, CONVERSATION_JOBS, SnoozeWakeJobData } from './conversation.constants';

/**
 * ConversationProcessor — consumes the delayed snooze-wake Bull job scheduled
 * by `ConversationService.snoozeConversation`.
 *
 * Delegates to `wakeSnoozedConversations(businessId)` rather than reopening
 * only the job's own conversation: that query re-checks status === SNOOZED
 * and snoozed_until <= now at fire time, so it's a safe no-op for any
 * conversation already reopened (e.g. by a customer reply) and also sweeps up
 * any other due conversation for the same business as a self-healing side
 * effect.
 */
@Processor(CONVERSATION_QUEUE)
export class ConversationProcessor {
  private readonly logger = new Logger(ConversationProcessor.name);

  constructor(private readonly conversationService: ConversationService) {}

  @Process(CONVERSATION_JOBS.SNOOZE_WAKE)
  async handleSnoozeWake(job: Job<SnoozeWakeJobData>): Promise<void> {
    const { businessId, conversationId } = job.data;
    this.logger.debug(
      `Processing snooze-wake job for conversation ${conversationId}`,
    );
    await this.conversationService.wakeSnoozedConversations(businessId);
  }
}
