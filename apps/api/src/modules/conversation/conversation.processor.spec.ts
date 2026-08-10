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
});
