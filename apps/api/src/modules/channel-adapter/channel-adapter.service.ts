import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
import { generateId, generateCorrelationId } from '@gosumo/shared';
import { PrismaService } from '../../common/services/prisma.service';

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
export class ChannelAdapterService {
  private readonly logger = new Logger(ChannelAdapterService.name);

  /**
   * Registry of adapters keyed by ChannelType.
   * Populated at module init via registerAdapter().
   */
  private readonly registry = new Map<ChannelType, ChannelAdapter>();

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

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
   *  3. Parse the raw payload into a NormalizedMessage
   *  4. Emit `message.received` domain event
   *
   * Returns the normalized message so callers (e.g. the controller) can
   * return it in an audit log or for testing purposes.
   *
   * @param channelType  Which channel this webhook came from
   * @param req          Raw HTTP request (headers + body + optional rawBody)
   * @param businessId   The tenant that owns this channel account
   * @param correlationId Optional pre-assigned trace ID (generated if omitted)
   */
  async handleInboundWebhook(
    channelType: ChannelType,
    req: RawRequest,
    businessId: string,
    correlationId?: string,
  ): Promise<NormalizedMessage> {
    const adapter = this.getAdapter(channelType);
    const traceId = correlationId ?? generateCorrelationId();

    // Step 1: Signature validation
    const isValid = adapter.validateWebhook(req);
    if (!isValid) {
      this.logger.warn(
        `[${traceId}] Invalid webhook signature for channel ${channelType}`,
      );
      throw new UnauthorizedException('Webhook signature verification failed');
    }

    // Step 2: Parse
    let normalized: NormalizedMessage;
    try {
      normalized = adapter.parseInbound(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${traceId}] Failed to parse inbound webhook: ${message}`);
      throw new BadRequestException(`Could not parse inbound message: ${message}`);
    }

    this.logger.log(
      `[${traceId}] Parsed inbound ${channelType} message ${normalized.externalId} ` +
        `from ${normalized.sender.externalId} (type: ${normalized.content.type})`,
    );

    // Step 3: Resolve channel_account, client, conversation, and store message
    let resolvedBusinessId = businessId;
    let resolvedClientId = '';
    let resolvedConversationId = '';
    let resolvedChannelAccountId = normalized.channelAccountId;

    try {
      // Look up the channel_account by channel type and external_id
      const channelAccount = await this.prisma.channel_accounts.findFirst({
        where: {
          channel: channelType,
          external_id: normalized.channelAccountId,
          is_active: true,
        },
      });

      if (channelAccount) {
        resolvedBusinessId = channelAccount.business_id;
        resolvedChannelAccountId = channelAccount.id;

        this.logger.log(
          `[${traceId}] Resolved channel_account ${channelAccount.id} ` +
            `(business: ${channelAccount.business_id})`,
        );

        // Find or create client via channel_contacts
        const senderExternalId = normalized.sender.externalId;
        let channelContact = await this.prisma.channel_contacts.findUnique({
          where: {
            channel_account_id_external_id: {
              channel_account_id: channelAccount.id,
              external_id: senderExternalId,
            },
          },
          include: { client: true },
        });

        if (!channelContact) {
          // Create client first, then channel_contact
          const client = await this.prisma.clients.create({
            data: {
              business_id: channelAccount.business_id,
              name: normalized.sender.displayName || senderExternalId,
              phone: channelType === ChannelType.SMS ? senderExternalId : undefined,
              email: channelType === ChannelType.EMAIL ? senderExternalId : undefined,
            },
          });

          channelContact = await this.prisma.channel_contacts.create({
            data: {
              business_id: channelAccount.business_id,
              client_id: client.id,
              channel_account_id: channelAccount.id,
              channel: channelType,
              external_id: senderExternalId,
              display_name: normalized.sender.displayName || senderExternalId,
            },
            include: { client: true },
          });

          this.logger.log(
            `[${traceId}] Created new client ${client.id} and contact ${channelContact.id} ` +
              `for sender ${senderExternalId}`,
          );
        } else {
          // Update last_seen_at
          await this.prisma.channel_contacts.update({
            where: { id: channelContact.id },
            data: { last_seen_at: new Date() },
          });
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
            where: { id: conversation.id },
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
        await this.prisma.messages.create({
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

        this.logger.log(
          `[${traceId}] Stored inbound message for conversation ${conversation.id}`,
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
    }

    // Step 4: Emit enriched domain event
    const event: MessageReceivedEvent = {
      id: generateId(),
      type: 'message.received',
      timestamp: new Date().toISOString(),
      businessId: resolvedBusinessId,
      correlationId: traceId,
      messageId: normalized.id,
      conversationId: resolvedConversationId,
      channelAccountId: resolvedChannelAccountId,
      channel: normalized.channel,
      senderExternalId: normalized.sender.externalId,
      clientId: resolvedClientId,
    };

    this.eventEmitter.emit('message.received', event);

    return normalized;
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
        attempts: 1,
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
        attempts: 1,
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
