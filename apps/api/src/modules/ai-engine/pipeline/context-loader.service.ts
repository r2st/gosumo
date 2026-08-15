import { Injectable, Logger } from '@nestjs/common';
import {
  conversations,
  messages,
  businesses,
  clients,
  business_rules,
} from '@gosumo/database';
import { ChannelType, MessageContentType } from '@gosumo/shared';
import { PrismaService } from '../../../common/services/prisma.service';
import { isBlankText } from '../../../common/utils/blank-text.util';
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

/** One prior turn of a conversation, reduced to who spoke and what they said. */
export interface TranscriptEntry {
  direction: 'INBOUND' | 'OUTBOUND';
  text: string;
}

/**
 * When a message was *sent*, falling back to when we stored it.
 *
 * `created_at` is insert order, and insert order is not send order. A channel
 * provider redelivers a webhook whenever our response was slow or non-200, so a
 * message the buyer sent at 10:00 can be written at 10:04 — after the reply to
 * the message they sent at 10:02. Ordering the model's history by `created_at`
 * then hands it a transcript in which the answer precedes the question, and the
 * model reasons over that as though it were the real sequence.
 *
 * `sent_at` is the provider's own time, written by the channel adapter. It is
 * null for rows stored before that existed and for channels whose provider
 * reports no time, so the fallback is not a rare path and must stay total.
 */
export function effectiveMessageTime(row: Pick<messages, 'sent_at' | 'created_at'>): number {
  return (row.sent_at ?? row.created_at).getTime();
}

/**
 * Put a window of messages back into send order, oldest first.
 *
 * The window itself is still selected by `created_at` — that is what the
 * `(conversation_id, created_at)` index can answer, and a message delivered
 * late enough to fall outside the window is not recoverable by sorting. This
 * corrects the order *within* what was fetched, which covers the redelivery
 * case the ordering actually breaks on.
 *
 * The tie-break on `id` is not decoration: providers report whole-second
 * timestamps, so several messages in one burst share a `sent_at` exactly, and
 * without it their relative order varies between two loads of the same
 * conversation.
 */
export function inSendOrder<T extends Pick<messages, 'sent_at' | 'created_at' | 'id'>>(
  rows: readonly T[],
): T[] {
  return rows
    .slice()
    .sort((a, b) => effectiveMessageTime(a) - effectiveMessageTime(b) || a.id.localeCompare(b.id));
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
    // Selected newest-first by `created_at` so the index does the work, then put
    // back into send order rather than merely reversed — see `inSendOrder`.
    const history = inSendOrder(settled(historyR, [] as messages[]) ?? []);
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
   * The recent text turns of one conversation, oldest → newest.
   *
   * Split out from {@link load} because a caller can need the history without
   * a trigger message to anchor it: the realty loop is handed a `leadId` and a
   * `conversationId`, and the voice path has no message row at all. Both still
   * have to see what was already said.
   *
   * Messages with no extractable text (bare media, stickers) are dropped rather
   * than rendered as blank turns — an empty `[Buyer]` line in the prompt reads
   * as the buyer having said nothing, which is worse than the turn's absence.
   *
   * Best-effort: a failed read yields an empty history, matching how every
   * other component of {@link EnrichedContext} degrades.
   */
  async loadTranscript(
    businessId: string,
    conversationId: string,
    limit: number = CONTEXT_MESSAGE_WINDOW,
  ): Promise<TranscriptEntry[]> {
    let rows: messages[];
    try {
      rows = await this.prisma.messages.findMany({
        where: { conversation_id: conversationId, business_id: businessId },
        orderBy: { created_at: 'desc' },
        take: limit,
      });
    } catch (err) {
      this.logger.warn(
        `Transcript load failed for conversation ${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }

    return inSendOrder(rows)
      .map((row) => ({
        direction: row.direction === 'OUTBOUND' ? ('OUTBOUND' as const) : ('INBOUND' as const),
        text: this.extractText(row).trim(),
      }))
      .filter((turn) => turn.text.length > 0);
  }

  /**
   * Whether a stored message carries anything the pipeline can reason about.
   *
   * False for exactly one case: a **TEXT** message whose text is blank once
   * trimmed. A customer sends those by accident constantly — a stray space, a
   * widget that submits on Enter, a WhatsApp message that is one invisible
   * character — and each one used to run the full pipeline: an intent
   * classification and a generation, two billed LLM calls, over an empty
   * `<customer_message>`. Whatever the model invents from nothing is then sent
   * to the customer as a reply to a message they did not knowingly send.
   *
   * Media is the reason this is not simply "is the text empty". An image or a
   * voice note has no text and is very much a turn to answer, so only the TEXT
   * type is judged on its text. The message is still stored and still appears
   * in the operator's inbox either way — this decides whether the AI runs, not
   * whether the customer was heard.
   *
   * A message that cannot be read at all is treated as actionable: refusing to
   * process a turn because of a failed lookup is the more expensive mistake.
   */
  async hasActionableContent(businessId: string, messageId: string): Promise<boolean> {
    let message: messages | null;
    try {
      message = await this.prisma.messages.findFirst({
        where: { id: messageId, business_id: businessId },
      });
    } catch (err) {
      this.logger.warn(
        `Could not read message ${messageId} to check for content; processing it anyway: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return true;
    }
    if (!message) return true;
    // `messages.type` is the Prisma `MessageType` enum and this is the shared
    // `MessageContentType`; they carry the same string values but are distinct
    // TS types, so the comparison is made on the value.
    if (String(message.type) !== String(MessageContentType.TEXT)) return true;
    return !isBlankText(this.extractText(message));
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
