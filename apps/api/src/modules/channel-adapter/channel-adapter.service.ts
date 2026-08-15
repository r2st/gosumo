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
import { createSequencedMessage } from '../../common/utils/message-sequence';
import { ReplayDeferredError, WebhookDlqService } from '../webhook-log/webhook-dlq.service';
import { ConversationLockService } from '../../common/services/conversation-lock.service';
import { CircuitBreakerRegistry } from '../../common/resilience/circuit-breaker.registry';
import { CircuitOpenError } from '../../common/resilience/circuit-breaker';
import { channelInboundBreaker } from '../../common/resilience/circuit-breaker.constants';
import { ChannelHealthService, type ChannelHealthSnapshot } from './channel-health.service';

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

/**
 * The provider's own send time, reduced to something safe to store.
 *
 * `NormalizedMessage.timestamp` is typed `Date`, but it is built from whatever
 * the provider put in the payload — Meta sends a unix-seconds *string*, Twilio
 * omits it entirely — so an adapter fed a junk field produces `new Date(NaN)`,
 * which Prisma rejects at write time. That would fail the whole message insert
 * over a field nobody reads synchronously, turning a cosmetic ordering hint
 * into lost customer messages, so an unusable value degrades to null and the
 * row falls back to `created_at`.
 *
 * A timestamp far in the future is refused for the same reason it would be
 * believed: it sorts above everything and would pin a message to the top of the
 * thread forever. One hour of slack absorbs ordinary clock skew between the
 * provider's clock and ours. Old timestamps are kept as-is — a genuinely late
 * redelivery is the case this field exists to describe.
 */
export function normalizedSentAt(value: unknown, now: Date = new Date()): Date | null {
  // `null` is refused before it reaches the Date constructor, which coerces it
  // to 0 and hands back a perfectly valid 1970 — the one bad value that would
  // pass the NaN check below and then sort the message to the top of every
  // thread it appears in, forever.
  if (value === null || value === undefined || value === '') return null;

  const at = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(at.getTime())) return null;
  if (at.getTime() > now.getTime() + SENT_AT_MAX_SKEW_MS) return null;
  return at;
}

/** How far ahead of our own clock a provider timestamp may be and still be believed. */
export const SENT_AT_MAX_SKEW_MS = 60 * 60 * 1000;

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
    /**
     * Optional for the same reason again. Absent, nothing is tracked and every
     * path behaves exactly as it did — this observes, it never decides.
     */
    @Optional() private readonly channelHealth?: ChannelHealthService,
    /**
     * Supplies the per-channel inbound breaker used by the DLQ replay path.
     * Optional because a breaker is process-global state and a unit suite that
     * drives five consecutive failures to assert the retry schedule is
     * indistinguishable, to a shared breaker, from a real outage — the same
     * reasoning `BaseChannelAdapter` documents for its own.
     */
    @Optional() private readonly breakers?: CircuitBreakerRegistry,
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
      // Counted. A misconfigured secret rejects *every* delivery on one channel
      // while the process looks entirely healthy from the outside — we answer
      // the provider, no outbound call is made, so no circuit breaker ever
      // sees it. A run of these is the signal that says which channel.
      const rejected = new UnauthorizedException('Webhook signature verification failed');
      this.channelHealth?.recordInboundFailure(channelType, rejected);
      throw rejected;
    }

    // Step 2: Parse
    let parsed: NormalizedMessage[];
    try {
      parsed = this.parseInboundBatch(adapter, req, traceId);
    } catch (err) {
      // Same reasoning: a parser that throws on a payload shape the provider
      // has started sending fails silently and completely.
      this.channelHealth?.recordInboundFailure(channelType, err);
      throw err;
    }

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
      this.channelHealth?.recordInboundSuccess(channelType);
      await this.markWebhookProcessed(webhookEventId, traceId);
    } catch (err) {
      this.channelHealth?.recordInboundFailure(channelType, err);
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
    // Whether the row we ended up with was already there. Hoisted for the same
    // reason, and read at the emit below.
    let alreadyStored = false;

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
        const { message: stored, duplicate } = await createSequencedMessage(
          this.prisma,
          {
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
            // When the *sender* sent it, as the provider reported it — not when
            // we happened to write the row. Every adapter parses this and it was
            // then dropped, leaving `created_at` as the only time on the record,
            // which is delivery order rather than send order. Those diverge
            // exactly when it matters: Meta redelivers a webhook minutes after
            // the fact, and a retried delivery then sorts *after* replies that
            // were written while it was in flight. See
            // `effectiveMessageTime` in the AI context loader, which is what
            // reads this back.
            sent_at: normalizedSentAt(normalized.timestamp),
            // The customer's channel-side address, and deliberately nothing
            // else. The AI pipeline resolves the reply recipient from here
            // (`ContextLoaderService.extractSenderExternalId`), and until this
            // was written that read returned null for every message the adapter
            // stored — so `AiEngineService.deliver` bailed on the missing
            // recipient and the generic assistant's replies were never sent at
            // all. Realty tenants take the reply address off the event instead,
            // which is why the floor was only missing under one of the two
            // pipelines.
            //
            // `normalized.metadata` — the raw channel-specific extras — is
            // pointedly *not* spread in here. It carries provider-shaped keys
            // (Instagram story context, Meta signature headers, Twilio segment
            // counts) whose meaning is channel-local, and one client can hold
            // conversations on several channels. Anything downstream that reads
            // a key off a message must be able to trust it means the same thing
            // whichever channel the message arrived on, so a field earns its
            // place here one at a time, by name.
            metadata: { senderExternalId: normalized.sender.externalId },
          },
        );
        resolvedMessageId = stored.id;
        alreadyStored = duplicate;

        this.logger.log(
          duplicate
            ? `[${traceId}] Inbound message ${normalized.externalId} was already stored as ` +
                `${stored.id} — not re-announcing it`
            : `[${traceId}] Stored inbound message ${stored.id} for conversation ${conversation.id}`,
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

    // Step 4: Emit enriched domain event — unless this delivery turned out to
    // be one we had already stored.
    //
    // Announcing it again is not a harmless repeat. `message.received` is what
    // drives the AI pipeline, lead capture, and cadence stop-on-reply, so a
    // re-announcement answers the customer a second time with a second LLM call
    // behind it. The row-level constraint stopped the duplicate *row*; this
    // stops the duplicate *reply*. Returning here still marks the delivery
    // processed, which is right: the work it describes is done.
    if (alreadyStored) return;

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
   *
   * Runs under a per-channel breaker. `webhook-dlq` is one queue shared by
   * every channel and both payment gateways, so a channel whose inbound path is
   * broken produces a dead letter per message and then spends a worker slot per
   * doomed retry — and a captured payment queues behind ten thousand of them.
   * Once the breaker opens the refusals cost microseconds, the queue drains,
   * and the entries come back as {@link ReplayDeferredError} so the outage
   * cannot spend their retry budgets.
   */
  private async replayInboundDelivery(payload: Record<string, unknown>): Promise<void> {
    const stored = payload as unknown as StoredInboundDelivery;

    if (!stored?.channelType || !stored.businessId) {
      throw new Error('Dead-lettered inbound delivery is missing its channel or tenant');
    }

    const breaker = this.breakers?.get({
      ...channelInboundBreaker(stored.channelType),
      // Every failure counts, not just outage-shaped ones. A parser that throws
      // deterministically is exactly what should stop being retried in a shared
      // queue, and the taxonomy calls that non-retryable — the opposite verdict
      // to the one this breaker needs.
      isOutage: () => true,
    });

    const attempt = () => this.runInboundReplay(stored);

    try {
      await (breaker ? breaker.run(attempt) : attempt());
      this.channelHealth?.recordInboundSuccess(stored.channelType);
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Not counted: nothing was attempted, so this is not evidence about the
        // channel. Counting refusals would drive the health grade from the
        // mitigation rather than from the fault, and would keep the channel
        // reading "failing" for as long as the breaker kept it cheap.
        throw new ReplayDeferredError(
          `${stored.channelType} inbound circuit is open — not attempting this replay`,
        );
      }
      this.channelHealth?.recordInboundFailure(stored.channelType, err);
      throw err;
    }
  }

  /** The replay itself, with no breaker or accounting around it. */
  private async runInboundReplay(stored: StoredInboundDelivery): Promise<void> {
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

    // The adapters have always declared their channel's ceiling and nothing has
    // ever checked it, so an over-length body went to the provider and came
    // back as a 400 whose text varies per channel — the one shape of failure
    // that is both entirely predictable and expensive to diagnose. Refusing it
    // here produces the same `message.failed` event with a reason that names
    // the actual problem, and it does so without spending the API call.
    //
    // Refused rather than truncated: cutting a reply at 1000 characters ends it
    // mid-sentence, and half an answer sent confidently is worse than an answer
    // that visibly failed and can be retried by a human.
    const overLimit = this.lengthOverrun(adapter, message);
    if (overLimit) {
      this.logger.error(`[${traceId}] Refusing to send ${channelType} message: ${overLimit}`);
      // Not recorded against the channel's health. This send never left the
      // process and says nothing about whether the provider is up — charging it
      // would let one caller's over-long body grade a working channel as
      // failing, and hide a real outage behind a caller's bug.
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
        reason: overLimit,
        attempts: 0,
      };
      this.eventEmitter.emit('message.failed', event);
      return { success: false, error: overLimit, attempts: 0 };
    }

    const result = await adapter.sendMessage(message);

    if (result.success) {
      this.channelHealth?.recordOutboundSuccess(channelType);
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
      this.channelHealth?.recordOutboundFailure(
        channelType,
        result.error ?? 'Unknown error',
      );
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
   * Describe how an outbound body overruns its channel's declared ceiling, or
   * `null` when it fits.
   *
   * Only text-bearing content is measured — a caption on an image is what the
   * limit applies to there, and a payload with no text at all (a location, a
   * bare document) has nothing this can bound. An adapter that declares no
   * usable limit is left alone rather than given a made-up one.
   */
  private lengthOverrun(adapter: ChannelAdapter, message: OutboundMessage): string | null {
    let limit: number;
    try {
      limit = adapter.getCapabilities().maxMessageLength;
    } catch {
      return null;
    }
    if (!Number.isFinite(limit) || limit <= 0) return null;

    const content = message.content as { text?: unknown; caption?: unknown };
    const body =
      typeof content.text === 'string'
        ? content.text
        : typeof content.caption === 'string'
          ? content.caption
          : null;
    if (body === null || body.length <= limit) return null;

    return `message body is ${body.length} characters, over the ${adapter.channelType} limit of ${limit}`;
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
      this.channelHealth?.recordOutboundSuccess(channelType);
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
      this.channelHealth?.recordOutboundFailure(
        channelType,
        result.error ?? 'Unknown error',
      );
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
      this.channelHealth?.recordOutboundSuccess(channelType);
      this.logger.log(
        `[${traceId}] Interactive message sent via ${channelType} ` +
          `to ${interactive.recipientExternalId}`,
      );
    } else {
      this.channelHealth?.recordOutboundFailure(
        channelType,
        result.error ?? 'Unknown error',
      );
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
   *
   * One adapter that throws is skipped, not fatal. This is the map the AI
   * engine reads to choose a response format, and it is asked for *all*
   * channels: letting a misconfigured Instagram adapter's throw propagate would
   * stop WhatsApp replies being formatted — one channel's fault taking out
   * every channel, in a method whose whole job is to describe them
   * independently.
   */
  getAllCapabilities(): Record<string, ChannelCapabilities> {
    const result: Record<string, ChannelCapabilities> = {};
    for (const [channelType, adapter] of this.registry) {
      try {
        result[channelType] = adapter.getCapabilities();
      } catch (err) {
        this.logger.error(
          `Could not read capabilities for ${channelType}, omitting it: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return result;
  }

  // ─────────────────────────────────────────────
  // Health / status
  // ─────────────────────────────────────────────

  /**
   * Per-channel health, or an empty list when no tracker is wired.
   *
   * Carries the last error message, so it belongs behind authentication — see
   * {@link ChannelHealthService.publicSnapshots} for what the public readiness
   * probe gets instead.
   */
  getChannelHealth(): ChannelHealthSnapshot[] {
    return this.channelHealth?.snapshots() ?? [];
  }

  getStatus(): Record<string, unknown> {
    return {
      module: 'ChannelAdapter',
      registeredChannels: this.getRegisteredChannels(),
      adapterCount: this.registry.size,
      // "Five adapters are registered" is also true of a process where
      // Instagram has rejected every webhook for an hour.
      channels: this.getChannelHealth(),
    };
  }
}
