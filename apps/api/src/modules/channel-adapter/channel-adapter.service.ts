import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Optional,
  OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  ChannelType,
  ChannelAdapter,
  ChannelCapabilities,
  NormalizedMessage,
  OutboundMessage,
  SendResult,
  TemplateMessage,
  InteractiveMessage,
  RawRequest,
  MessageReceivedEvent,
  MessageSentEvent,
  MessageFailedEvent,
  MessageDirection,
} from '@gosumo/shared';
import { generateId, generateCorrelationId, normalizeIndianPhone, PayloadParseError } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';
import { findOrCreateClientByIdentity } from '../../common/utils/client-identity.util';
import { WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import { ConversationLockService } from '../../common/services/conversation-lock.service';

/**
 * Adapters whose provider batches several messages into one webhook implement
 * this alongside `ChannelAdapter`. It is not on the base interface because
 * single-message channels (WebChat, SMS) have nothing to add.
 */
interface BatchParsingAdapter {
  parseInboundAll(req: RawRequest): NormalizedMessage[];
}

/** The `channel_accounts` row an inbound message resolves to, or its absence. */
type ResolvedChannelAccount = Prisma.channel_accountsGetPayload<object> | null;

/**
 * One webhook's worth of `channel_accounts` lookups, memoized.
 *
 * Every message in a batched payload resolves the same account, so a payload of
 * N messages was issuing N identical queries on the hottest write path in the
 * system. This collapses them to one per distinct (channel, external_id).
 *
 * Deliberately request-scoped rather than a service field: an account that is
 * deactivated, or re-pointed at another tenant, must be seen by the next
 * webhook. Caching across requests would keep serving the stale row — and this
 * row is what decides which tenant the message is written under, which is the
 * last thing that should go stale.
 *
 * A miss is cached too. `findFirst` returning null is the "unknown or inactive
 * account" answer, and re-asking it once per message in a junk payload is the
 * same N+1 wearing a different hat.
 *
 * The stored value is the in-flight promise, not its result, so messages are
 * memoized even if the loop that drives them ever stops being sequential.
 */
class ChannelAccountMemo {
  private readonly entries = new Map<string, Promise<ResolvedChannelAccount>>();

  async resolve(
    channelType: ChannelType,
    externalId: string,
    load: () => Promise<ResolvedChannelAccount>,
  ): Promise<ResolvedChannelAccount> {
    const key = `${channelType}:${externalId}`;
    let pending = this.entries.get(key);
    if (!pending) {
      // A rejected lookup must not be memoized — the caller dead-letters and
      // replays it, and a cached rejection would fail the replay for a reason
      // that no longer exists.
      pending = load().catch((err: unknown) => {
        this.entries.delete(key);
        throw err;
      });
      this.entries.set(key, pending);
    }
    return pending;
  }

  /** Distinct accounts resolved so far — asserted by the batch N+1 test. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * What a dead-lettered inbound delivery stores so a replay can re-run exactly
 * the one message that failed.
 *
 * The raw body is kept rather than the parsed `NormalizedMessage` so a replay
 * goes through the adapter's own parser — a parser fix shipped after the
 * capture is then picked up by the retry, which is the case that matters most.
 * `externalId` selects the message within a batched body; the other messages in
 * that body have their own `webhook_events` rows and their own outcomes.
 */
interface StoredInboundDelivery {
  channelType: ChannelType;
  businessId: string;
  externalId: string;
  body: unknown;
  headers: Record<string, string>;
  /** The `webhook_events` row to mark processed once the replay succeeds. */
  webhookEventId: string | null;
}

/** Outcome of recording a delivery in `webhook_events`. */
interface DeliveryRecord {
  duplicate: boolean;
  webhookEventId: string | null;
}

/**
 * Core service for the Channel Adapter module.
 *
 * Responsibilities:
 *  1. Maintain a runtime registry of ChannelAdapter implementations
 *     keyed by ChannelType.
 *  2. Validate and parse inbound webhooks, then emit `message.received`
 *     domain events.
 *  3. Route outbound messages to the correct adapter, then emit
 *     `message.sent` or `message.failed` domain events.
 *  4. Expose channel capabilities so the AI engine can pick the best
 *     response format.
 *
 * ## How to register a new channel adapter
 *
 * In your module's `onModuleInit()`, or by calling `registerAdapter()`:
 *
 * ```ts
 * constructor(
 *   private readonly channelAdapterService: ChannelAdapterService,
 *   private readonly whatsAppAdapter: WhatsAppAdapter,
 * ) {}
 *
 * onModuleInit() {
 *   this.channelAdapterService.registerAdapter(this.whatsAppAdapter);
 * }
 * ```
 */
@Injectable()
export class ChannelAdapterService implements OnModuleInit {
  private readonly logger = new Logger(ChannelAdapterService.name);

  /**
   * Registry of adapters keyed by ChannelType.
   * Populated at module init via registerAdapter().
   */
  private readonly registry = new Map<ChannelType, ChannelAdapter>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
    /**
     * Optional so the many unit suites that construct this service directly do
     * not each have to stand up a queue-backed DLQ. Wired in production by
     * {@link ChannelAdapterModule}; when it is absent a failed delivery is
     * logged at ERROR and lost, which is exactly the behaviour this replaces —
     * so an unwired deployment is no worse off, and a wired one recovers.
     */
    @Optional() private readonly webhookDlq?: WebhookDlqService,
    /** Optional for the same reason; without it turns are not serialized. */
    @Optional() private readonly conversationLock?: ConversationLockService,
  ) {}

  /**
   * Teach the webhook DLQ how to re-run a failed inbound delivery, one replayer
   * per channel — the DLQ keys its registry on the same `source` string that
   * was captured, and for channel webhooks that is the `ChannelType`.
   *
   * Like the payment replayers, these skip signature verification (the raw
   * bytes it needs are not stored, and the payload only reached the DLQ because
   * its signature already passed) and skip the `webhook_events` idempotency
   * write, which by definition already happened.
   */
  onModuleInit(): void {
    if (!this.webhookDlq) return;
    for (const channelType of Object.values(ChannelType)) {
      this.webhookDlq.registerReplayer(channelType, async (payload) => {
        await this.replayInboundDelivery(payload);
      });
    }
  }

  // ─────────────────────────────────────────────
  // Registry management
  // ─────────────────────────────────────────────

  /**
   * Register a channel adapter. Calling this twice for the same
   * ChannelType replaces the previous registration (useful in tests).
   */
  registerAdapter(adapter: ChannelAdapter): void {
    this.registry.set(adapter.channelType, adapter);
    this.logger.log(`Registered adapter for channel: ${adapter.channelType}`);
  }

  /**
   * Return the registered adapter for the given channel type.
   * Throws NotFoundException if no adapter is registered.
   */
  getAdapter(channelType: ChannelType): ChannelAdapter {
    const adapter = this.registry.get(channelType);
    if (!adapter) {
      throw new NotFoundException(
        `No adapter registered for channel type: ${channelType}. ` +
          `Registered channels: ${[...this.registry.keys()].join(', ') || 'none'}`,
      );
    }
    return adapter;
  }

  /**
   * Return all registered channel types.
   */
  getRegisteredChannels(): ChannelType[] {
    return [...this.registry.keys()];
  }

  // ─────────────────────────────────────────────
  // Inbound webhook processing
  // ─────────────────────────────────────────────

  /**
   * Full inbound webhook pipeline:
   *  1. Resolve the adapter for channelType
   *  2. Validate the webhook signature — throws UnauthorizedException on failure
   *  3. Parse the raw payload into NormalizedMessages
   *  4. Persist and emit `message.received` for each
   *
   * Returns every message the payload carried, in delivery order.
   *
   * Meta batches: one POST can carry several `entry` items, several `changes`
   * per entry, and several `messages` per change — which is exactly what
   * happens when a customer fires off two or three messages in a row, or when
   * Meta redelivers a backlog. `parseInbound` returns only the first of those,
   * so processing a batch through it silently dropped every message after the
   * first: no row stored, no event emitted, no error anywhere.
   *
   * @param channelType  Which channel this webhook came from
   * @param req          Raw HTTP request (headers + body + optional rawBody)
   * @param businessId   The tenant that owns this channel account
   * @param correlationId Optional pre-assigned trace ID (generated if omitted)
   */
  async handleInboundWebhookBatch(
    channelType: ChannelType,
    req: RawRequest,
    businessId: string,
    correlationId?: string,
  ): Promise<NormalizedMessage[]> {
    const adapter = this.getAdapter(channelType);
    const traceId = correlationId ?? generateCorrelationId();

    // Step 1: Signature validation — once per request, not once per message.
    const isValid = adapter.validateWebhook(req);
    if (!isValid) {
      this.logger.warn(
        `[${traceId}] Invalid webhook signature for channel ${channelType}`,
      );
      throw new UnauthorizedException('Webhook signature verification failed');
    }

    // Step 2: Parse
    const parsed = this.parseInboundBatch(adapter, req, traceId);

    if (parsed.length > 1) {
      this.logger.log(`[${traceId}] ${channelType} webhook carried ${parsed.length} messages`);
    }

    // Sequential on purpose: several messages from one sender share a client
    // and a conversation, and the find-or-create for both is a read followed by
    // a write. Running them concurrently races two creates for the same pair.
    //
    // The memo below is what keeps that loop from being an N+1. Every message
    // resolves the same `channel_accounts` row — a WhatsApp webhook carries the
    // messages for one business phone number, so all of them look up the same
    // (channel, external_id) pair — and each was issuing its own query. On the
    // busiest write path in the system, against a connection pool this box
    // shares with another service, a 30-message campaign reply burst spent 30
    // round trips answering one question. Scoped to this request so it cannot
    // serve a channel account that was deactivated between webhooks, and keyed
    // by external id rather than hoisted, because Meta may put more than one
    // `entry` in a payload and they need not name the same account.
    const accounts = new ChannelAccountMemo();

    const handled: NormalizedMessage[] = [];
    for (const normalized of parsed) {
      await this.processInboundMessage(
        channelType,
        normalized,
        req,
        businessId,
        traceId,
        accounts,
      );
      handled.push(normalized);
    }
    return handled;
  }

  /**
   * Single-message form of {@link handleInboundWebhookBatch}, kept for callers
   * that want one message back. Every message in the payload is still
   * processed; only the first is returned.
   */
  async handleInboundWebhook(
    channelType: ChannelType,
    req: RawRequest,
    businessId: string,
    correlationId?: string,
  ): Promise<NormalizedMessage> {
    const handled = await this.handleInboundWebhookBatch(
      channelType,
      req,
      businessId,
      correlationId,
    );
    return handled[0]!;
  }

  /**
   * Parse every message in the payload, preferring the adapter's batch parser
   * and falling back to the single-message one for adapters that have none.
   *
   * A payload that yields nothing is a parse failure, matching what
   * `parseInbound` did by throwing: the caller asked us to process a message
   * webhook and there was no message in it.
   */
  private parseInboundBatch(
    adapter: ChannelAdapter,
    req: RawRequest,
    traceId: string,
  ): NormalizedMessage[] {
    const batchParser = (adapter as Partial<BatchParsingAdapter>).parseInboundAll;

    try {
      const parsed = batchParser
        ? batchParser.call(adapter, req)
        : [adapter.parseInbound(req)];

      if (parsed.length === 0) {
        // `parseInboundAll` swallows per-message failures, so an empty result
        // can mean "status-only payload" or "every message was unparseable".
        // `parseInbound` distinguishes them by throwing with a reason; call it
        // for the message rather than reporting a bare "no messages".
        adapter.parseInbound(req);
        throw new PayloadParseError(adapter.channelType, 'payload carried no inbound message');
      }
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${traceId}] Failed to parse inbound webhook: ${message}`);
      throw new BadRequestException(`Could not parse inbound message: ${message}`);
    }
  }

  /** Dedupe, persist and announce one already-parsed inbound message. */
  private async processInboundMessage(
    channelType: ChannelType,
    normalized: NormalizedMessage,
    req: RawRequest,
    businessId: string,
    traceId: string,
    accounts: ChannelAccountMemo = new ChannelAccountMemo(),
  ): Promise<void> {
    this.logger.log(
      `[${traceId}] Parsed inbound ${channelType} message ${normalized.externalId} ` +
        `from ${normalized.sender.externalId} (type: ${normalized.content.type})`,
    );

    // Step 2.5: Idempotency — channel providers (WhatsApp/Instagram Cloud API
    // in particular) redeliver a webhook whenever our response is slow or
    // non-200, so the same externalId can arrive more than once. Dedupe via
    // the same `webhook_events` unique-constraint pattern the payment module
    // uses, keyed on (source, external_id). Adapters that don't have a stable
    // provider id (e.g. WebChat) generate a fresh one per call, so this is a
    // no-op for them rather than a false-positive risk.
    let webhookEventId: string | null = null;
    if (normalized.externalId) {
      const delivery = await this.recordWebhookDelivery(
        channelType,
        normalized.externalId,
        req.body,
        traceId,
      );
      if (delivery.duplicate) {
        this.logger.log(
          `[${traceId}] Duplicate ${channelType} webhook for external_id=${normalized.externalId} — skipping reprocessing`,
        );
        return;
      }
      webhookEventId = delivery.webhookEventId;
    }

    // Step 3+4: persist and announce. A failure here used to be logged and
    // swallowed, which lost the message for good: the delivery was already in
    // `webhook_events`, so the provider's own redelivery — the only retry
    // mechanism there was — came back and was discarded as a duplicate. Park
    // it in the DLQ instead, on the same retry schedule the payment module's
    // gateway webhooks use.
    // Serialized per sender: two webhook POSTs from the same buyer arriving
    // together each run find-or-create for the contact and the conversation —
    // a read followed by a write. Concurrently, both reads miss and both write,
    // producing two OPEN conversations for one buyer and splitting their
    // history. The batch loop above is already sequential for exactly this
    // reason; this extends the same guarantee across separate requests.
    const senderKey = ConversationLockService.conversationKey(
      businessId,
      `${normalized.channelAccountId}:${normalized.sender.externalId}`,
    );

    try {
      await this.withSenderLock(senderKey, async () => {
        await this.persistAndAnnounce(channelType, normalized, businessId, traceId, accounts);
      });
      await this.markWebhookProcessed(webhookEventId, traceId);
    } catch (err) {
      await this.deadLetterInbound(
        channelType,
        normalized,
        req,
        businessId,
        webhookEventId,
        traceId,
        err,
      );
    }
  }

  /** Run `fn` under the sender lock, or directly when no lock is wired. */
  private async withSenderLock(key: string, fn: () => Promise<void>): Promise<void> {
    if (!this.conversationLock) return fn();
    return this.conversationLock.runExclusive(key, fn);
  }

  /**
   * Resolve the message's context, store it, and emit `message.received`.
   *
   * Throws on failure — that is the point. The caller dead-letters what this
   * rejects with, so the delivery can be replayed from its stored payload.
   */
  private async persistAndAnnounce(
    channelType: ChannelType,
    normalized: NormalizedMessage,
    businessId: string,
    traceId: string,
    accounts: ChannelAccountMemo = new ChannelAccountMemo(),
  ): Promise<void> {
    // Step 3: Resolve channel_account, client, conversation, and store message
    let resolvedBusinessId = businessId;
    let resolvedClientId = '';
    let resolvedConversationId = '';
    let resolvedChannelAccountId = normalized.channelAccountId;
    // Set from the row `messages.create` actually wrote. `normalized.id` is a
    // UUID the adapter minted for the in-memory envelope; `messages.id` is
    // `uuid_generate_v4()` on the database side. They are never equal, so
    // publishing the former is publishing an id nothing can be joined on.
    let resolvedMessageId = normalized.id;
    // The sender's E.164 phone, for the consumers that match on a person rather
    // than on a channel address. Hoisted out of the try so it reaches the emit.
    let resolvedSenderPhone: string | undefined;

    try {
      // Look up the channel_account by channel type and external_id, once per
      // (channel, external_id) per webhook — see the memo in
      // `handleInboundWebhookBatch`.
      const channelAccount = await accounts.resolve(
        channelType,
        normalized.channelAccountId,
        () =>
          this.prisma.channel_accounts.findFirst({
            where: {
              channel: channelType,
              external_id: normalized.channelAccountId,
              is_active: true,
            },
          }),
      );

      if (channelAccount) {
        resolvedBusinessId = channelAccount.business_id;
        resolvedChannelAccountId = channelAccount.id;

        this.logger.log(
          `[${traceId}] Resolved channel_account ${channelAccount.id} ` +
            `(business: ${channelAccount.business_id})`,
        );

        // Find or create client via channel_contacts
        const senderExternalId = normalized.sender.externalId;

        // WhatsApp `wa_id` (e.g. `919876543210`) and SMS sender ids are both
        // phone identities, but neither arrives in E.164 — which is what
        // `clients.phone` is declared to hold. Normalize here so notification
        // recipient resolution, consent lookups, and lead matching (all keyed
        // on E.164) actually resolve. Fall back to the raw id when the number
        // is not a valid Indian mobile, so a non-normalizable sender still
        // keeps a usable identity rather than losing the phone entirely.
        const isPhoneChannel =
          channelType === ChannelType.WHATSAPP || channelType === ChannelType.SMS;
        const senderPhone = isPhoneChannel
          ? normalizeIndianPhone(senderExternalId) ?? senderExternalId
          : undefined;
        // Publish it too. Computing this only for `clients.phone` was the bug:
        // the event carried the raw `wa_id`, so every *other* E.164-keyed
        // consumer — lead capture, cadence stop-on-reply, the voice router —
        // matched `919876543210` against rows written `+919876543210` and found
        // nothing. Non-phone channels stay undefined rather than falling back to
        // the channel id, which is not a phone number in any format.
        resolvedSenderPhone = senderPhone;

        let channelContact = await this.prisma.channel_contacts.findFirst({
          where: {
            business_id: channelAccount.business_id,
            channel_account_id: channelAccount.id,
            external_id: senderExternalId,
          },
          include: { client: true },
        });

        if (!channelContact) {
          // No contact for *this* channel account does not mean a new person.
          // The same buyer who messaged on WhatsApp and now texts from the same
          // number — or reaches a second WhatsApp account this business runs —
          // already owns a client row holding that phone, and `clients` is
          // unique on (business, phone) and (business, email). Creating
          // unconditionally therefore did not make a duplicate: it raised
          // P2002, the catch below swallowed it, and the message was lost for
          // good, because step 2 had already written the delivery to
          // `webhook_events` and so deduped the provider's retry away.
          //
          // Resolving against the identity instead is also what this module has
          // always claimed to do: one client, one `channel_contacts` row per
          // channel they arrive on.
          const resolved = await findOrCreateClientByIdentity(
            this.prisma.clients,
            channelAccount.business_id,
            {
              phone: senderPhone,
              email: channelType === ChannelType.EMAIL ? senderExternalId : undefined,
            },
            normalized.sender.displayName || senderExternalId,
          );

          channelContact = await this.prisma.channel_contacts.create({
            data: {
              business_id: channelAccount.business_id,
              client_id: resolved.id,
              channel_account_id: channelAccount.id,
              channel: channelType,
              external_id: senderExternalId,
              display_name: normalized.sender.displayName || senderExternalId,
            },
            include: { client: true },
          });

          this.logger.log(
            `[${traceId}] ${resolved.created ? 'Created new' : 'Reused'} client ${resolved.id} ` +
              `and contact ${channelContact.id} for sender ${senderExternalId}`,
          );
        } else {
          // Update last_seen_at
          await this.prisma.channel_contacts.update({
            where: { id: channelContact.id, business_id: channelAccount.business_id },
            data: { last_seen_at: new Date() },
          });

          // Backfill the phone for contacts created before phone normalization
          // existed (WhatsApp senders were stored with no phone at all, which
          // left them unreachable for WHATSAPP/SMS notifications). Only fill a
          // blank — never overwrite a phone an operator may have corrected.
          if (senderPhone && !channelContact.client?.phone) {
            await this.prisma.clients.update({
              where: {
                id: channelContact.client_id,
                business_id: channelAccount.business_id,
              },
              data: { phone: senderPhone },
            });
            this.logger.log(
              `[${traceId}] Backfilled phone for client ${channelContact.client_id}`,
            );
          }
        }

        resolvedClientId = channelContact.client_id;

        // Find or create conversation
        let conversation = await this.prisma.conversations.findFirst({
          where: {
            business_id: channelAccount.business_id,
            client_id: channelContact.client_id,
            channel_account_id: channelAccount.id,
            status: { notIn: ['RESOLVED'] },
          },
          orderBy: { updated_at: 'desc' },
        });

        if (!conversation) {
          conversation = await this.prisma.conversations.create({
            data: {
              business_id: channelAccount.business_id,
              client_id: channelContact.client_id,
              channel_account_id: channelAccount.id,
              channel: channelType,
              status: 'OPEN',
              subject: channelType + ' conversation',
              last_message_at: new Date(),
            },
          });

          this.logger.log(
            `[${traceId}] Created new conversation ${conversation.id}`,
          );
        } else {
          await this.prisma.conversations.update({
            where: { id: conversation.id, business_id: channelAccount.business_id },
            data: { last_message_at: new Date() },
          });
        }

        resolvedConversationId = conversation.id;

        // Store message in DB
        const contentType = normalized.content.type || 'TEXT';
        // Extract text for denormalized text_content column used by previews
        const textContent =
          'text' in normalized.content && typeof normalized.content.text === 'string'
            ? normalized.content.text
            : undefined;
        const stored = await this.prisma.messages.create({
          data: {
            business_id: channelAccount.business_id,
            conversation_id: conversation.id,
            channel_account_id: channelAccount.id,
            direction: MessageDirection.INBOUND,
            type: contentType,
            status: 'DELIVERED',
            sender_type: 'CLIENT',
            sender_id: channelContact.client_id,
            content: normalized.content as object,
            text_content: textContent,
            external_id: normalized.externalId,
          },
        });
        resolvedMessageId = stored.id;

        this.logger.log(
          `[${traceId}] Stored inbound message ${stored.id} for conversation ${conversation.id}`,
        );
      } else {
        this.logger.warn(
          `[${traceId}] No channel_account found for ${channelType} ` +
            `external_id=${normalized.channelAccountId} — emitting partial event`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `[${traceId}] Failed to resolve context for inbound webhook: ${message}`,
      );
      // Rethrow rather than fall through to the emit. Announcing a message that
      // was never stored publishes ids nothing can be joined on — an event with
      // an empty conversationId that every downstream listener drops — and it
      // does so *quietly*, which is what made this loss invisible. The caller
      // parks the delivery for replay instead.
      throw err instanceof Error ? err : new Error(message);
    }

    // Step 4: Emit enriched domain event
    const event: MessageReceivedEvent = {
      id: generateId(),
      type: 'message.received',
      timestamp: new Date().toISOString(),
      businessId: resolvedBusinessId,
      correlationId: traceId,
      messageId: resolvedMessageId,
      conversationId: resolvedConversationId,
      channelAccountId: resolvedChannelAccountId,
      channel: normalized.channel,
      senderExternalId: normalized.sender.externalId,
      ...(resolvedSenderPhone ? { senderPhone: resolvedSenderPhone } : {}),
      clientId: resolvedClientId,
    };

    this.eventEmitter.emit('message.received', event);
  }

  /**
   * Record a channel webhook delivery in `webhook_events` and report whether
   * it's a duplicate, via the same unique-constraint-on-conflict pattern the
   * payment module uses for Razorpay/Stripe webhooks.
   *
   * Written `processed: false`. The row is the dedupe claim, not a receipt:
   * marking it processed *before* processing meant a delivery that then failed
   * was indistinguishable from one that succeeded, in the one table an operator
   * would check to find out. {@link markWebhookProcessed} stamps it once the
   * message is actually stored and announced.
   *
   * Fails open: if the insert fails for a reason other than the (source,
   * external_id) unique violation (e.g. a transient DB error), the message is
   * treated as new rather than silently dropped — losing a customer message
   * is worse than occasionally double-processing one.
   */
  private async recordWebhookDelivery(
    channelType: ChannelType,
    externalId: string,
    body: unknown,
    traceId: string,
  ): Promise<DeliveryRecord> {
    try {
      const row = await this.prisma.webhook_events.create({
        data: {
          source: channelType,
          event_type: 'message.received',
          external_id: externalId,
          payload: (body ?? {}) as Prisma.InputJsonValue,
          signature_valid: true,
          processed: false,
        },
        select: { id: true },
      });
      return { duplicate: false, webhookEventId: row?.id ?? null };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { duplicate: true, webhookEventId: null };
      }
      this.logger.error(
        `[${traceId}] Failed to record webhook_events for ${channelType}/${externalId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return { duplicate: false, webhookEventId: null };
    }
  }

  /**
   * Stamp the delivery as processed, now that the message is stored and
   * announced.
   *
   * Best-effort: the work is already done and committed, so failing to update
   * the audit flag must not turn a delivered message into a dead-lettered one.
   */
  private async markWebhookProcessed(
    webhookEventId: string | null,
    traceId: string,
  ): Promise<void> {
    if (!webhookEventId) return;
    try {
      await this.prisma.webhook_events.update({
        where: { id: webhookEventId },
        data: { processed: true, processed_at: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `[${traceId}] Could not mark webhook_event ${webhookEventId} processed: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Park an inbound delivery whose processing threw, so it can be retried on
   * our own schedule instead of relying on a provider redelivery that
   * `webhook_events` will discard.
   *
   * Never throws: this runs inside a catch, and a DLQ failure must not change
   * what the provider sees. A webhook endpoint that 500s here would be retried
   * straight into the dedupe wall — the exact loss being fixed.
   */
  private async deadLetterInbound(
    channelType: ChannelType,
    normalized: NormalizedMessage,
    req: RawRequest,
    businessId: string,
    webhookEventId: string | null,
    traceId: string,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);

    if (!this.webhookDlq) {
      this.logger.error(
        `[${traceId}] Inbound ${channelType} message ${normalized.externalId} failed and no ` +
          `webhook DLQ is wired — the message is lost: ${reason}`,
      );
      return;
    }

    const stored: StoredInboundDelivery = {
      channelType,
      businessId,
      externalId: normalized.externalId,
      body: req.body,
      headers: req.headers ?? {},
      webhookEventId,
    };

    try {
      await this.webhookDlq.capture(
        {
          businessId,
          webhookEventId,
          source: channelType,
          eventType: 'message.received',
          // The DLQ dedupes nothing, but this is the operator's handle on which
          // delivery is parked — keep it the provider's id.
          externalId: normalized.externalId || normalized.id,
          payload: stored as unknown as Record<string, unknown>,
          headers: req.headers ?? {},
          correlationId: traceId,
        },
        error,
      );
    } catch (dlqError) {
      this.logger.error(
        `[${traceId}] Failed to dead-letter inbound ${channelType} message ` +
          `${normalized.externalId}: ` +
          `${dlqError instanceof Error ? dlqError.message : String(dlqError)}`,
      );
    }
  }

  /**
   * Re-run one captured inbound delivery from its stored payload.
   *
   * Re-parses the original body so the replay picks up any parser fix shipped
   * since the capture, then re-runs only the message the entry was captured
   * for. Throws on failure, which is how the DLQ decides to reschedule or
   * discard.
   */
  private async replayInboundDelivery(payload: Record<string, unknown>): Promise<void> {
    const stored = payload as unknown as StoredInboundDelivery;

    if (!stored?.channelType || !stored.businessId) {
      throw new Error('Dead-lettered inbound delivery is missing its channel or tenant');
    }

    const traceId = generateCorrelationId();
    const adapter = this.getAdapter(stored.channelType);
    const req: RawRequest = { headers: stored.headers ?? {}, body: stored.body };

    const parsed = this.parseInboundBatch(adapter, req, traceId);
    // A batched body carries several messages, each captured separately. Pick
    // ours; replaying the whole batch would re-deliver siblings that succeeded.
    const target = stored.externalId
      ? parsed.find((m) => m.externalId === stored.externalId)
      : parsed[0];

    if (!target) {
      throw new Error(
        `Replayed ${stored.channelType} payload no longer contains message ${stored.externalId}`,
      );
    }

    await this.persistAndAnnounce(stored.channelType, target, stored.businessId, traceId);
    await this.markWebhookProcessed(stored.webhookEventId ?? null, traceId);
  }

  // ─────────────────────────────────────────────
  // Outbound message routing
  // ─────────────────────────────────────────────

  /**
   * Send an outbound message via the correct channel adapter.
   * Emits `message.sent` on success, `message.failed` on failure.
   *
   * @param channelType  Target channel
   * @param message      Outbound message payload
   * @param businessId   Tenant scope for the domain event
   * @param correlationId Optional trace ID
   */
  async sendMessage(
    channelType: ChannelType,
    message: OutboundMessage,
    businessId: string,
    correlationId?: string,
  ): Promise<SendResult> {
    const adapter = this.getAdapter(channelType);
    const traceId = correlationId ?? generateCorrelationId();
    const startMs = Date.now();

    const result = await adapter.sendMessage(message);

    if (result.success) {
      this.logger.log(
        `[${traceId}] Message sent via ${channelType} to ${message.recipientExternalId} ` +
          `(externalId: ${result.externalMessageId})`,
      );

      const event: MessageSentEvent = {
        id: generateId(),
        type: 'message.sent',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: traceId,
        messageId: message.correlationId ?? generateId(),
        conversationId: '',
        channelAccountId: message.channelAccountId,
        channel: channelType,
        externalMessageId: result.externalMessageId ?? '',
        recipientExternalId: message.recipientExternalId,
        latencyMs: Date.now() - startMs,
      };

      this.eventEmitter.emit('message.sent', event);
    } else {
      this.logger.error(
        `[${traceId}] Failed to send ${channelType} message to ` +
          `${message.recipientExternalId}: ${result.error}`,
      );

      const event: MessageFailedEvent = {
        id: generateId(),
        type: 'message.failed',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: traceId,
        messageId: message.correlationId ?? generateId(),
        conversationId: '',
        channelAccountId: message.channelAccountId,
        channel: channelType,
        recipientExternalId: message.recipientExternalId,
        reason: result.error ?? 'Unknown error',
        attempts: result.attempts ?? 1,
      };

      this.eventEmitter.emit('message.failed', event);
    }

    return result;
  }

  /**
   * Send a pre-approved template message.
   * Emits the same `message.sent` / `message.failed` events as sendMessage.
   */
  async sendTemplate(
    channelType: ChannelType,
    template: TemplateMessage,
    businessId: string,
    correlationId?: string,
  ): Promise<SendResult> {
    const adapter = this.getAdapter(channelType);
    const traceId = correlationId ?? generateCorrelationId();
    const startMs = Date.now();

    const result = await adapter.sendTemplate(template);

    if (result.success) {
      this.logger.log(
        `[${traceId}] Template "${template.templateName}" sent via ${channelType} ` +
          `to ${template.recipientExternalId}`,
      );

      const event: MessageSentEvent = {
        id: generateId(),
        type: 'message.sent',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: traceId,
        messageId: template.correlationId ?? generateId(),
        conversationId: '',
        channelAccountId: template.channelAccountId,
        channel: channelType,
        externalMessageId: result.externalMessageId ?? '',
        recipientExternalId: template.recipientExternalId,
        latencyMs: Date.now() - startMs,
      };

      this.eventEmitter.emit('message.sent', event);
    } else {
      const event: MessageFailedEvent = {
        id: generateId(),
        type: 'message.failed',
        timestamp: new Date().toISOString(),
        businessId,
        correlationId: traceId,
        messageId: template.correlationId ?? generateId(),
        conversationId: '',
        channelAccountId: template.channelAccountId,
        channel: channelType,
        recipientExternalId: template.recipientExternalId,
        reason: result.error ?? 'Unknown error',
        attempts: result.attempts ?? 1,
      };

      this.eventEmitter.emit('message.failed', event);
    }

    return result;
  }

  /**
   * Send an interactive message (buttons, list picker, etc.).
   */
  async sendInteractive(
    channelType: ChannelType,
    interactive: InteractiveMessage,
    businessId: string,
    correlationId?: string,
  ): Promise<SendResult> {
    const adapter = this.getAdapter(channelType);
    const traceId = correlationId ?? generateCorrelationId();

    const result = await adapter.sendInteractive(interactive);

    if (result.success) {
      this.logger.log(
        `[${traceId}] Interactive message sent via ${channelType} ` +
          `to ${interactive.recipientExternalId}`,
      );
    } else {
      this.logger.error(
        `[${traceId}] Failed to send interactive message via ${channelType}: ${result.error}`,
      );
    }

    return result;
  }

  // ─────────────────────────────────────────────
  // Media
  // ─────────────────────────────────────────────

  /**
   * Download a media asset (image, document, voice note) from a channel's CDN
   * by its channel-assigned media id. Delegates to the channel adapter, which
   * resolves the temporary download URL and streams the bytes. Used by the
   * voice-note transcription pipeline for `whatsapp-media://<id>` references.
   */
  async downloadMedia(channelType: ChannelType, mediaId: string): Promise<Buffer> {
    const adapter = this.getAdapter(channelType);
    return adapter.downloadMedia(mediaId);
  }

  // ─────────────────────────────────────────────
  // Capabilities
  // ─────────────────────────────────────────────

  /**
   * Return the capability set for a given channel.
   * The AI engine uses this to select the most appropriate response format.
   */
  getCapabilities(channelType: ChannelType): ChannelCapabilities {
    const adapter = this.getAdapter(channelType);
    return adapter.getCapabilities();
  }

  /**
   * Return capabilities for all registered channels.
   */
  getAllCapabilities(): Record<string, ChannelCapabilities> {
    const result: Record<string, ChannelCapabilities> = {};
    for (const [channelType, adapter] of this.registry) {
      result[channelType] = adapter.getCapabilities();
    }
    return result;
  }

  // ─────────────────────────────────────────────
  // Health / status
  // ─────────────────────────────────────────────

  getStatus(): Record<string, unknown> {
    return {
      module: 'ChannelAdapter',
      registeredChannels: this.getRegisteredChannels(),
      adapterCount: this.registry.size,
    };
  }
}
