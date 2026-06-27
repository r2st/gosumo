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
} from '@gosumo/shared';
import { generateId, generateCorrelationId } from '@gosumo/shared';

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

  constructor(private readonly eventEmitter: EventEmitter2) {}

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

    // Step 3: Emit domain event
    // NOTE: The conversation module listens to `message.received` and is
    // responsible for creating/updating conversation records and assigning
    // the GoSumo messageId to a conversation.
    // Here we emit a partial event; the conversation module will enrich it.
    const event: MessageReceivedEvent = {
      id: generateId(),
      type: 'message.received',
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: traceId,
      // These fields will be populated by the conversation module handler
      messageId: normalized.id,
      conversationId: '', // resolved by conversation module
      channelAccountId: normalized.channelAccountId,
      channel: normalized.channel,
      senderExternalId: normalized.sender.externalId,
      clientId: '', // resolved by client-intelligence module
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
