import { Injectable, Logger } from '@nestjs/common';
import {
  conversations,
  messages,
  businesses,
  clients,
  business_rules,
} from '@gosumo/database';
import { ChannelType, MessageContentType } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';
import { CONTEXT_MESSAGE_WINDOW } from '../ai-engine.constants';

/**
 * Everything the pipeline needs to reason about one inbound message. Any
 * component that fails to load is treated as empty rather than fatal — the
 * pipeline degrades gracefully (see AI_ENGINE_DESIGN.md §1, Stage 2).
 */
export interface EnrichedContext {
  conversation: conversations | null;
  triggerMessage: messages | null;
  history: messages[];
  business: businesses | null;
  client: clients | null;
  businessRules: business_rules[];
  /** Plain text extracted from the trigger message (for classification/prompt). */
  messageText: string;
  channel: ChannelType | null;
  channelAccountId: string | null;
  /** Channel-side recipient id to reply to (the customer's address). */
  recipientExternalId: string | null;
}

/**
 * ContextLoaderService — assembles {@link EnrichedContext} for the pipeline.
 *
 * All independent reads run in parallel via `Promise.allSettled`; a rejected
 * read degrades to `null`/`[]` so a missing catalog or profile never crashes
 * message processing.
 */
@Injectable()
export class ContextLoaderService {
  private readonly logger = new Logger(ContextLoaderService.name);

  constructor(private readonly prisma: PrismaService) {}

  async load(
    businessId: string,
    conversationId: string,
    messageId: string,
  ): Promise<EnrichedContext> {
    const [conversationR, triggerR, historyR, businessR, rulesR] = await Promise.allSettled([
      this.prisma.conversations.findFirst({
        where: { id: conversationId, business_id: businessId },
      }),
      this.prisma.messages.findFirst({
        where: { id: messageId, business_id: businessId },
      }),
      this.prisma.messages.findMany({
        where: { conversation_id: conversationId, business_id: businessId },
        orderBy: { created_at: 'desc' },
        take: CONTEXT_MESSAGE_WINDOW,
      }),
      this.prisma.businesses.findFirst({ where: { id: businessId } }),
      this.prisma.business_rules.findMany({
        where: { business_id: businessId, is_active: true, deleted_at: null },
        orderBy: { priority: 'desc' },
      }),
    ]);

    const conversation = settled(conversationR, null);
    const triggerMessage = settled(triggerR, null);
    const history = (settled(historyR, [] as messages[]) ?? []).slice().reverse();
    const business = settled(businessR, null);
    const businessRules = settled(rulesR, [] as business_rules[]) ?? [];

    // Client is loaded off the conversation's client_id (best-effort).
    let client: clients | null = null;
    if (conversation?.client_id) {
      const clientR = await Promise.allSettled([
        this.prisma.clients.findFirst({
          where: { id: conversation.client_id, business_id: businessId },
        }),
      ]);
      client = settled(clientR[0]!, null);
    }

    const messageText = this.extractText(triggerMessage);

    return {
      conversation,
      triggerMessage,
      history,
      business,
      client,
      businessRules,
      messageText,
      channel: (conversation?.channel as ChannelType | undefined) ?? null,
      channelAccountId: conversation?.channel_account_id ?? triggerMessage?.channel_account_id ?? null,
      recipientExternalId: this.extractSenderExternalId(triggerMessage),
    };
  }

  /**
   * Pull the searchable text out of a message. Prefers the denormalized
   * `text_content`, then a TEXT content payload, else an empty string.
   */
  private extractText(message: messages | null): string {
    if (!message) return '';
    if (message.text_content) return message.text_content;

    const content = message.content as Record<string, unknown> | null;
    if (content && content['type'] === MessageContentType.TEXT && typeof content['text'] === 'string') {
      return content['text'];
    }
    return '';
  }

  private extractSenderExternalId(message: messages | null): string | null {
    if (!message) return null;
    const metadata = message.metadata as Record<string, unknown> | null;
    if (metadata && typeof metadata['senderExternalId'] === 'string') {
      return metadata['senderExternalId'];
    }
    // sender_id holds the client UUID; the channel-side address lives in metadata.
    return null;
  }
}

/** Unwrap a settled promise result, falling back when it rejected. */
function settled<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}
