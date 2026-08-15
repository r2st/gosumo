import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ChannelType,
  MessageDirection,
  MessageContentType,
  ChannelCapabilities,
  NormalizedMessage,
  OutboundMessage,
  SendResult,
  TemplateMessage,
  InteractiveMessage,
  RawRequest,
} from '@gosumo/shared';
import { generateId } from '@gosumo/shared';
import { BaseChannelAdapter } from './base.adapter';
import { CircuitBreakerRegistry } from '../../../common/resilience/circuit-breaker.registry';
import { WHATSAPP_BREAKER } from '../../../common/resilience/circuit-breaker.constants';
import { allowUnverifiedWebhook, isProductionEnv } from '../../../common/utils/webhook-verification.util';
import { MEDIA_HTTP_TIMEOUT_MS, fetchWithTimeout } from '../../../common/utils/http-timeout.util';
import { readBodyWithLimit } from '../../../common/utils/media-download.util';
import { ExternalServiceError, PayloadParseError, UnsupportedOperationError } from '@gosumo/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Meta Cloud API payload types
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
// ─────────────────────────────────────────────────────────────────────────────

interface MetaWebhookPayload {
  object: string;
  entry: MetaEntry[];
}

interface MetaEntry {
  id: string; // WhatsApp Business Account ID
  changes: MetaChange[];
}

interface MetaChange {
  value: MetaChangeValue;
  field: string;
}

interface MetaChangeValue {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: MetaContact[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
  errors?: MetaError[];
}

interface MetaContact {
  profile: {
    name: string;
  };
  wa_id: string;
}

interface MetaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: MetaMessageType;
  // Content fields — only the relevant one is present based on `type`
  text?: { body: string };
  image?: MetaMediaObject;
  document?: MetaDocumentObject;
  audio?: MetaMediaObject;
  video?: MetaMediaObject;
  sticker?: MetaMediaObject;
  location?: MetaLocationObject;
  interactive?: MetaInteractiveObject;
  button?: MetaButtonObject;
  reaction?: { message_id: string; emoji: string };
  context?: { from: string; id: string };
}

type MetaMessageType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'sticker'
  | 'location'
  | 'interactive'
  | 'button'
  | 'reaction'
  | 'unknown';

interface MetaMediaObject {
  id: string;
  mime_type: string;
  sha256?: string;
  caption?: string;
}

interface MetaDocumentObject extends MetaMediaObject {
  filename?: string;
}

interface MetaLocationObject {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

interface MetaInteractiveObject {
  type: 'button_reply' | 'list_reply' | 'nfm_reply';
  button_reply?: {
    id: string;
    title: string;
  };
  list_reply?: {
    id: string;
    title: string;
    description?: string;
  };
}

interface MetaButtonObject {
  payload: string;
  text: string;
}

interface MetaStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
}

interface MetaError {
  code: number;
  title: string;
  message?: string;
  error_data?: { details: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Cloud API send-message request shapes
// https://developers.facebook.com/docs/whatsapp/cloud-api/messages
// ─────────────────────────────────────────────────────────────────────────────

interface MetaSendMessageRequest {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: string;
  text?: { preview_url?: boolean; body: string };
  image?: { id?: string; link?: string; caption?: string };
  document?: { id?: string; link?: string; caption?: string; filename?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  template?: {
    name: string;
    language: { code: string };
    components?: MetaTemplateComponent[];
  };
  interactive?: {
    type: string;
    header?: Record<string, unknown>;
    body: { text: string };
    footer?: { text: string };
    action: Record<string, unknown>;
  };
  context?: { message_id: string };
}

interface MetaTemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'quick_reply' | 'url';
  index?: string;
  parameters: MetaTemplateParameter[];
}

interface MetaTemplateParameter {
  type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video';
  text?: string;
}

interface MetaSendMessageResponse {
  messaging_product: string;
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WhatsApp Business API channel adapter.
 *
 * Implements the full ChannelAdapter contract for Meta's WhatsApp Cloud API.
 * One instance handles one WhatsApp Business phone number.
 *
 * Configuration (all via ConfigService / env vars):
 *   WHATSAPP_APP_SECRET        — Used to verify HMAC-SHA256 webhook signatures
 *   WHATSAPP_ACCESS_TOKEN      — System user access token for Cloud API calls
 *   WHATSAPP_PHONE_NUMBER_ID   — The phone number ID to send from
 *   WHATSAPP_VERIFY_TOKEN      — Secret token for GET verification handshake
 *
 * Meta Cloud API base URL: https://graph.facebook.com/v19.0
 */
@Injectable()
export class WhatsAppAdapter extends BaseChannelAdapter {
  readonly channelType = ChannelType.WHATSAPP;

  private readonly metaBaseUrl: string;
  private readonly appSecret: string;
  /** Fail-closed switch: a missing secret rejects webhooks in production. */
  private readonly isProduction: boolean;
  private readonly accessToken: string;
  private readonly phoneNumberId: string;

  /**
   * `@Optional()` so a spec can build an unguarded adapter — see
   * `BaseChannelAdapter.breaker` for why a shared, stateful breaker and unit
   * tests do not mix. Nest always supplies it: `ResilienceModule` is global.
   */
  constructor(
    private readonly configService: ConfigService,
    @Optional() registry?: CircuitBreakerRegistry,
  ) {
    super('WhatsAppAdapter', {
      maxAttempts: 3,
      retryDelayMs: 500,
      breaker: registry?.get(WHATSAPP_BREAKER),
    });

    this.metaBaseUrl = 'https://graph.facebook.com/v19.0';
    this.appSecret = this.configService.get<string>('whatsapp.appSecret', '');
    this.accessToken = this.configService.get<string>('whatsapp.accessToken', '');
    this.phoneNumberId = this.configService.get<string>('whatsapp.phoneNumberId', '');
    this.isProduction = isProductionEnv(this.configService);

    if (!this.appSecret) {
      this.logger.warn(
        this.isProduction
          ? 'WHATSAPP_APP_SECRET is not set — inbound WhatsApp webhooks will be REJECTED'
          : 'WHATSAPP_APP_SECRET is not set — webhook signature verification disabled (non-production)',
      );
    }
  }

  // ─────────────────────────────────────────────
  // Webhook validation
  // ─────────────────────────────────────────────

  /**
   * Verify that the webhook request originated from Meta by checking the
   * X-Hub-Signature-256 header against an HMAC-SHA256 of the raw body.
   *
   * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
   */
  validateWebhook(req: RawRequest): boolean {
    if (!this.appSecret) {
      return allowUnverifiedWebhook(
        this.logger,
        this.isProduction,
        'WHATSAPP_APP_SECRET is not set',
      );
    }

    const signature = (req.headers['x-hub-signature-256'] as string | undefined) ?? '';
    if (!signature.startsWith('sha256=')) {
      this.logger.warn('Webhook rejected: missing or malformed X-Hub-Signature-256 header');
      return false;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.warn('Webhook rejected: rawBody not available for signature verification');
      return false;
    }

    const expectedHash = crypto
      .createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex');

    const expectedSignature = `sha256=${expectedHash}`;

    // Use timingSafeEqual to prevent timing attacks
    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length) {
      this.logger.warn('Webhook rejected: signature length mismatch');
      return false;
    }

    const isValid = crypto.timingSafeEqual(sigBuffer, expectedBuffer);

    if (!isValid) {
      this.logger.warn('Webhook rejected: signature mismatch');
    }

    return isValid;
  }

  // ─────────────────────────────────────────────
  // Inbound parsing
  // ─────────────────────────────────────────────

  /**
   * Parse a Meta webhook payload into GoSumo's NormalizedMessage format.
   *
   * Meta batches multiple events in one POST, and this returns only the first
   * parseable one. The webhook route therefore does *not* call it —
   * `parseInboundAll` is the production path. What is left for this method is
   * the `ChannelAdapter` interface contract and the diagnostic role the batch
   * pipeline gives it: when `parseInboundAll` yields nothing, this is called to
   * turn "no messages" into a reason.
   *
   * Throws if the payload contains no parseable message (e.g. a pure
   * status-update webhook that has no `messages` array).
   */
  parseInbound(req: RawRequest): NormalizedMessage {
    const payload = req.body as MetaWebhookPayload;

    if (payload.object !== 'whatsapp_business_account') {
      throw new PayloadParseError(
        'WhatsApp',
        `Unexpected webhook object type: "${payload.object}" — expected "whatsapp_business_account"`,
        { context: { object: payload.object } },
      );
    }

    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const messages = value.messages;
        if (!messages || messages.length === 0) continue;

        const metaMsg = messages[0]!;
        const contact = value.contacts?.find((c) => c.wa_id === metaMsg.from);

        return {
          id: generateId(),
          externalId: metaMsg.id,
          channel: ChannelType.WHATSAPP,
          channelAccountId: value.metadata.phone_number_id,
          direction: MessageDirection.INBOUND,
          sender: {
            externalId: metaMsg.from,
            displayName: contact?.profile.name,
          },
          content: this.parseMessageContent(metaMsg),
          timestamp: new Date(parseInt(metaMsg.timestamp, 10) * 1000),
          metadata: {
            wabaId: entry.id,
            phoneNumberId: value.metadata.phone_number_id,
            displayPhoneNumber: value.metadata.display_phone_number,
            contextMessageId: metaMsg.context?.id,
            contextFrom: metaMsg.context?.from,
          },
        };
      }
    }

    throw new PayloadParseError(
      'WhatsApp',
      'Webhook payload contained no parseable inbound message',
    );
  }

  /**
   * Parse all messages from a single Meta webhook payload.
   * Returns an empty array if the webhook only contains status updates.
   */
  parseInboundAll(req: RawRequest): NormalizedMessage[] {
    const payload = req.body as MetaWebhookPayload;
    const results: NormalizedMessage[] = [];

    if (payload?.object !== 'whatsapp_business_account') return results;
    if (!Array.isArray(payload.entry)) return results;

    for (const entry of payload.entry) {
      if (!Array.isArray(entry?.changes)) continue;
      for (const change of entry.changes) {
        if (change?.field !== 'messages') continue;

        const value = change.value;
        if (!Array.isArray(value?.messages)) continue;

        for (const metaMsg of value.messages) {
          // The whole per-message body sits inside the try, including the
          // contact lookup. It used to sit outside, so a `messages` array
          // carrying one null entry (or a `contacts` array carrying one) threw
          // past the isolation this loop exists to provide: the caller turns
          // that into a parse failure for the entire payload, and the good
          // messages beside it are dropped with it.
          try {
            const contact = value.contacts?.find((c) => c?.wa_id === metaMsg?.from);

            results.push({
              id: generateId(),
              externalId: metaMsg.id,
              channel: ChannelType.WHATSAPP,
              channelAccountId: value.metadata.phone_number_id,
              direction: MessageDirection.INBOUND,
              sender: {
                externalId: metaMsg.from,
                displayName: contact?.profile.name,
              },
              content: this.parseMessageContent(metaMsg),
              timestamp: new Date(parseInt(metaMsg.timestamp, 10) * 1000),
              metadata: {
                wabaId: entry.id,
                phoneNumberId: value.metadata.phone_number_id,
                displayPhoneNumber: value.metadata.display_phone_number,
                contextMessageId: metaMsg.context?.id,
                contextFrom: metaMsg.context?.from,
              },
            });
          } catch (err) {
            // Optional-chained: a null `metaMsg` is one of the shapes that gets
            // us here, and a throw from the handler would defeat the catch.
            this.logger.warn(
              `Could not parse message ${metaMsg?.id} (type: ${metaMsg?.type}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────
  // Outbound — send message
  // ─────────────────────────────────────────────

  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    return this.sendWithRetry(async () => {
      const body = this.buildSendMessageBody(message);
      return this.callMetaApi(body);
    }, 'sendMessage');
  }

  async sendTemplate(template: TemplateMessage): Promise<SendResult> {
    return this.sendWithRetry(async () => {
      const components = this.buildTemplateComponents(template.parameters);
      const body: MetaSendMessageRequest = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: template.recipientExternalId,
        type: 'template',
        template: {
          name: template.templateName,
          language: { code: template.language },
          ...(components.length > 0 && { components }),
        },
      };
      return this.callMetaApi(body);
    }, 'sendTemplate');
  }

  async sendInteractive(interactive: InteractiveMessage): Promise<SendResult> {
    return this.sendWithRetry(async () => {
      const body: MetaSendMessageRequest = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: interactive.recipientExternalId,
        type: 'interactive',
        interactive: {
          type: interactive.interactiveType,
          body: { text: interactive.body },
          action: interactive.action,
          ...(interactive.header && { header: interactive.header }),
          ...(interactive.footer && { footer: { text: interactive.footer } }),
        },
      };
      return this.callMetaApi(body);
    }, 'sendInteractive');
  }

  // ─────────────────────────────────────────────
  // Media
  // ─────────────────────────────────────────────

  /**
   * Download a WhatsApp media asset.
   * First fetches the temporary download URL from the Media API,
   * then streams the binary content.
   *
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media
   */
  async downloadMedia(mediaId: string): Promise<Buffer> {
    // Step 1: Get the download URL
    const metaUrlResp = await fetchWithTimeout(
      `${this.metaBaseUrl}/${mediaId}`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
      { service: 'WhatsApp Media' },
    );

    if (!metaUrlResp.ok) {
      throw new ExternalServiceError('WhatsApp Media', 'URL fetch failed', {
        status: metaUrlResp.status,
        context: { statusText: metaUrlResp.statusText },
      });
    }

    const metaUrlJson = await metaUrlResp.json() as { url: string };
    const downloadUrl = metaUrlJson.url;

    // Step 2: Download the binary
    const mediaResp = await fetchWithTimeout(
      downloadUrl,
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
      { service: 'WhatsApp Media', timeoutMs: MEDIA_HTTP_TIMEOUT_MS },
    );

    if (!mediaResp.ok) {
      throw new ExternalServiceError('WhatsApp Media', 'download failed', {
        status: mediaResp.status,
        context: { statusText: mediaResp.statusText },
      });
    }

    // Bounded rather than `arrayBuffer()`: the address being read here is the
    // one Meta's metadata call named, not one this code chose, and the whole
    // response lands in the API process's heap.
    return readBodyWithLimit(mediaResp, { service: 'WhatsApp Media' });
  }

  /**
   * Upload a media buffer to WhatsApp's Media API.
   * Returns the Media ID which can be used in subsequent message sends.
   *
   * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media#upload-media
   */
  async uploadMedia(buffer: Buffer, mimeType: string): Promise<string> {
    const formData = new FormData();
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', mimeType);
    formData.append('file', new Blob([buffer], { type: mimeType }));

    const resp = await fetchWithTimeout(
      `${this.metaBaseUrl}/${this.phoneNumberId}/media`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}` },
        body: formData,
      },
      { service: 'WhatsApp Media', timeoutMs: MEDIA_HTTP_TIMEOUT_MS },
    );

    if (!resp.ok) {
      const errText = await resp.text();
      throw new ExternalServiceError('WhatsApp Media', 'upload failed', {
        status: resp.status,
        context: { body: errText },
      });
    }

    const json = await resp.json() as { id: string };
    return json.id;
  }

  // ─────────────────────────────────────────────
  // Capabilities
  // ─────────────────────────────────────────────

  getCapabilities(): ChannelCapabilities {
    return {
      channelType: ChannelType.WHATSAPP,
      supportsTemplates: true,
      supportsInteractiveMessages: true,
      supportsMedia: true,
      supportsVoice: false,
      supportsReactions: true,
      supportsReadReceipts: true,
      supportsPaymentLinks: true,
      maxMessageLength: 4096,
    };
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Map a Meta message object to GoSumo's MessageContent discriminated union.
   * Throws for unsupported / unknown message types so callers can decide
   * whether to skip or surface the error.
   */
  private parseMessageContent(msg: MetaMessage): NormalizedMessage['content'] {
    switch (msg.type) {
      case 'text':
        if (!msg.text)
          throw new PayloadParseError('WhatsApp', 'type=text but no text field', {
            context: { messageId: msg.id, messageType: msg.type },
          });
        return {
          type: MessageContentType.TEXT,
          text: msg.text.body,
        };

      case 'image':
        if (!msg.image)
          throw new PayloadParseError('WhatsApp', 'type=image but no image field', {
            context: { messageId: msg.id, messageType: msg.type },
          });
        return {
          type: MessageContentType.IMAGE,
          // URL must be resolved later via downloadMedia(msg.image.id)
          url: `whatsapp-media://${msg.image.id}`,
          caption: msg.image.caption,
          mimeType: msg.image.mime_type,
        };

      case 'document':
        if (!msg.document)
          throw new PayloadParseError('WhatsApp', 'type=document but no document field', {
            context: { messageId: msg.id, messageType: msg.type },
          });
        return {
          type: MessageContentType.DOCUMENT,
          url: `whatsapp-media://${msg.document.id}`,
          filename: msg.document.filename ?? 'document',
          mimeType: msg.document.mime_type,
        };

      case 'location':
        if (!msg.location)
          throw new PayloadParseError('WhatsApp', 'type=location but no location field', {
            context: { messageId: msg.id, messageType: msg.type },
          });
        return {
          type: MessageContentType.LOCATION,
          latitude: msg.location.latitude,
          longitude: msg.location.longitude,
          name: msg.location.name,
          address: msg.location.address,
        };

      case 'interactive':
        if (!msg.interactive)
          throw new PayloadParseError('WhatsApp', 'type=interactive but no interactive field', {
            context: { messageId: msg.id, messageType: msg.type },
          });
        return this.parseInteractiveContent(msg.interactive);

      case 'button':
        // Quick-reply button tap (from a template message)
        if (!msg.button)
          throw new PayloadParseError('WhatsApp', 'type=button but no button field', {
            context: { messageId: msg.id, messageType: msg.type },
          });
        return {
          type: MessageContentType.INTERACTIVE,
          interactiveType: 'button_reply',
          payload: {
            id: msg.button.payload,
            title: msg.button.text,
          },
        };

      case 'audio':
      case 'video':
      case 'sticker':
        // Treat as unsupported image-ish content — store media ID so it can be
        // downloaded later; the AI engine will decide what to do
        {
          const media = (msg.audio ?? msg.video ?? msg.sticker) as MetaMediaObject;
          return {
            type: MessageContentType.IMAGE,
            url: `whatsapp-media://${media.id}`,
            mimeType: media.mime_type,
          };
        }

      case 'reaction':
        // Reactions don't map cleanly to a MessageContent — surface as TEXT
        return {
          type: MessageContentType.TEXT,
          text: `[reaction: ${msg.reaction?.emoji ?? '?'} on ${msg.reaction?.message_id ?? '?'}]`,
        };

      case 'unknown':
      default:
        throw new PayloadParseError('WhatsApp', `Unsupported message type "${msg.type}"`, {
          context: { messageId: msg.id, messageType: msg.type },
        });
    }
  }

  private parseInteractiveContent(interactive: MetaInteractiveObject): NormalizedMessage['content'] {
    switch (interactive.type) {
      case 'button_reply':
        return {
          type: MessageContentType.INTERACTIVE,
          interactiveType: 'button_reply',
          payload: {
            id: interactive.button_reply?.id ?? '',
            title: interactive.button_reply?.title ?? '',
          },
        };

      case 'list_reply':
        return {
          type: MessageContentType.INTERACTIVE,
          interactiveType: 'list_reply',
          payload: {
            id: interactive.list_reply?.id ?? '',
            title: interactive.list_reply?.title ?? '',
            description: interactive.list_reply?.description,
          },
        };

      default:
        return {
          type: MessageContentType.INTERACTIVE,
          interactiveType: interactive.type,
          payload: interactive as unknown as Record<string, unknown>,
        };
    }
  }

  /**
   * Build the Meta API request body from a GoSumo OutboundMessage.
   */
  private buildSendMessageBody(message: OutboundMessage): MetaSendMessageRequest {
    const base: Omit<MetaSendMessageRequest, 'type'> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.recipientExternalId,
      ...(message.replyToExternalId && {
        context: { message_id: message.replyToExternalId },
      }),
    };

    const content = message.content;

    switch (content.type) {
      case MessageContentType.TEXT:
        return { ...base, type: 'text', text: { body: content.text, preview_url: false } };

      case MessageContentType.IMAGE:
        return {
          ...base,
          type: 'image',
          image: content.url.startsWith('whatsapp-media://')
            ? { id: content.url.replace('whatsapp-media://', ''), caption: content.caption }
            : { link: content.url, caption: content.caption },
        };

      case MessageContentType.DOCUMENT:
        return {
          ...base,
          type: 'document',
          document: content.url.startsWith('whatsapp-media://')
            ? { id: content.url.replace('whatsapp-media://', ''), filename: content.filename }
            : { link: content.url, filename: content.filename },
        };

      case MessageContentType.LOCATION:
        return {
          ...base,
          type: 'location',
          location: {
            latitude: content.latitude,
            longitude: content.longitude,
            name: content.name,
          },
        };

      case MessageContentType.TEMPLATE:
        return {
          ...base,
          type: 'template',
          template: {
            name: content.templateName,
            language: { code: content.language },
            components: this.buildTemplateComponents(content.parameters),
          },
        };

      case MessageContentType.INTERACTIVE:
      case MessageContentType.PAYMENT_LINK:
        // These require the caller to use sendInteractive / buildPaymentLinkMessage instead
        throw new UnsupportedOperationError(
          `Use sendInteractive() or sendTemplate() for content type: ${content.type}`,
          { context: { contentType: content.type } },
        );

      default: {
        const _exhaustive: never = content;
        throw new UnsupportedOperationError(
          `WhatsApp cannot send content of type "${(_exhaustive as { type: string }).type}"`,
        );
      }
    }
  }

  /**
   * Convert a flat key→value parameters map into the array of
   * body-component text parameters that Meta's template API expects.
   */
  private buildTemplateComponents(
    parameters: Record<string, string>,
  ): MetaTemplateComponent[] {
    const keys = Object.keys(parameters);
    if (keys.length === 0) return [];

    return [
      {
        type: 'body',
        parameters: keys.map((key) => ({
          type: 'text' as const,
          text: parameters[key] ?? '',
        })),
      },
    ];
  }

  /**
   * POST a message to the Meta Cloud API and parse the response.
   */
  private async callMetaApi(body: MetaSendMessageRequest): Promise<SendResult> {
    const url = `${this.metaBaseUrl}/${this.phoneNumberId}/messages`;

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      },
      { service: 'WhatsApp' },
    );

    if (!response.ok) {
      // `detail` omits the provider name (ExternalServiceError prefixes it);
      // the returned string keeps the historical flat shape.
      let detail = `returned ${response.status}`;
      let errorCode: number | undefined;
      try {
        const errBody = await response.json() as { error?: { message?: string; code?: number } };
        if (errBody.error?.message) {
          errorCode = errBody.error.code;
          detail = `error ${errorCode ?? response.status}: ${errBody.error.message}`;
        }
      } catch {
        // Body not JSON — use the status-only message
      }

      const failure = new ExternalServiceError('Meta API', detail, {
        status: response.status,
        context: { errorCode },
      });

      // The taxonomy decides what is worth another attempt. The previous
      // `>= 500` test excluded 429, which matters here specifically: WhatsApp
      // caps a number at 80 msg/sec, so a rate-limit reply is the most likely
      // transient failure this adapter sees and it was never being retried.
      if (failure.retryable) {
        throw failure;
      }

      return { success: false, error: `Meta API ${detail}` };
    }

    const json = await response.json() as MetaSendMessageResponse;
    const externalMessageId = json.messages?.[0]?.id;

    return {
      success: true,
      externalMessageId,
      sentAt: new Date(),
    };
  }
}

/**
 * Utility: check whether a Meta webhook payload contains only status
 * updates (no inbound messages). Used by the controller to short-circuit
 * processing.
 */
export function isStatusUpdateOnly(body: unknown): boolean {
  const payload = body as MetaWebhookPayload;
  if (!Array.isArray(payload?.entry)) return false;

  // Every dereference below is defensive on purpose. The controller calls this
  // *before* its try/catch and before the signature check, so a shape this
  // function cannot walk becomes a 500 out of a `@Public()` route — which is
  // precisely the response that makes Meta retry, and retry, and retry. A
  // payload we cannot classify is not status-only; let it fall through to the
  // parser, which reports the problem without taking the route down.
  for (const entry of payload.entry) {
    if (!Array.isArray(entry?.changes)) return false;
    for (const change of entry.changes) {
      if (change?.field === 'messages' && change.value?.messages?.length) {
        return false;
      }
    }
  }

  return true;
}
