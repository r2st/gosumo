import { ConversationProcessor } from './conversation.processor';
import { ConversationService } from './conversation.service';
import { CONVERSATION_JOBS } from './conversation.constants';

describe('ConversationProcessor', () => {
  it('delegates snooze-wake jobs to wakeSnoozedConversations for the job business', async () => {
    const conversationService = {
      wakeSnoozedConversations: jest.fn().mockResolvedValue(2),
    } as unknown as ConversationService;
    const processor = new ConversationProcessor(conversationService);

    const job = {
      data: { businessId: 'biz-1', conversationId: 'conv-1' },
      name: CONVERSATION_JOBS.SNOOZE_WAKE,
    } as never;

    await processor.handleSnoozeWake(job);

    expect(conversationService.wakeSnoozedConversations).toHaveBeenCalledWith('biz-1');
  });

  /**
   * The processor's error boundary is Bull, not a `try`. A handler that
   * swallowed would resolve, Bull would mark the job complete, and the
   * conversation would stay snoozed forever with nothing logged — the failure
   * mode a background job has that a request does not. Rejecting is what buys
   * the three attempts and the exhausted-retry ERROR line from
   * `QueueTelemetryService`.
   */
  it('lets a failure reach Bull so the wake is retried rather than lost', async () => {
    const conversationService = {
      wakeSnoozedConversations: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as ConversationService;
    const processor = new ConversationProcessor(conversationService);

    const job = {
      data: { businessId: 'biz-1', conversationId: 'conv-1' },
      name: CONVERSATION_JOBS.SNOOZE_WAKE,
    } as never;

    await expect(processor.handleSnoozeWake(job)).rejects.toThrow('db down');
  });
});
