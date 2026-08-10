import { Injectable } from '@nestjs/common';
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
import { allowUnverifiedWebhook, isProductionEnv } from './webhook-verification.util';

// ─────────────────────────────────────────────────────────────────────────────
// Instagram Messaging API payload types
// Instagram messaging rides on Meta's Messenger Platform webhook format
// (object: "instagram"), which differs from the WhatsApp Cloud API shape.
// https://developers.facebook.com/docs/messenger-platform/instagram/features/webhook
// ─────────────────────────────────────────────────────────────────────────────

interface IgWebhookPayload {
  object: string;
  entry: IgEntry[];
}

interface IgEntry {
  /** Instagram-scoped ID of the business account (Page/IG account) */
  id: string;
  time: number;
  messaging?: IgMessagingEvent[];
}

interface IgMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: IgInboundMessage;
  postback?: IgPostback;
  reaction?: IgReaction;
  read?: { mid: string };
}

interface IgInboundMessage {
  mid: string;
  text?: string;
  attachments?: IgAttachment[];
  quick_reply?: { payload: string };
  /** Present when the message is an echo of something the business sent */
  is_echo?: boolean;
  /** Story-reply / story-mention context */
  reply_to?: { story?: { url: string; id: string }; mid?: string };
}

interface IgAttachment {
  type: 'image' | 'video' | 'audio' | 'file' | 'share' | 'story_mention' | 'location';
  payload: {
    url?: string;
    title?: string;
    /** Present on location attachments */
    coordinates?: { lat: number; long: number };
  };
}

interface IgPostback {
  mid: string;
  title?: string;
  payload: string;
}

interface IgReaction {
  mid: string;
  action: 'react' | 'unreact';
  reaction?: string;
  emoji?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Instagram send-message request shapes (Graph API: POST /{page-id}/messages)
// https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message
// ─────────────────────────────────────────────────────────────────────────────

interface IgSendMessageRequest {
  recipient: { id: string };
  message: IgOutboundMessage;
}

interface IgOutboundMessage {
  text?: string;
  attachment?: {
    type: 'image' | 'video' | 'audio' | 'file';
    payload: { url: string; is_reusable?: boolean };
  };
  quick_replies?: IgQuickReply[];
}

interface IgQuickReply {
  content_type: 'text';
  title: string;
  payload: string;
  image_url?: string;
}

interface IgSendMessageResponse {
  recipient_id: string;
  message_id: string;
}

/**
 * Shape of a single quick-reply button as accepted by sendInteractive().
 * Callers pass these in `InteractiveMessage.action.quickReplies`.
 */
interface QuickReplyButton {
  title: string;
  payload: string;
  imageUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Instagram Adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Instagram Direct Messaging channel adapter.
 *
 * Implements the ChannelAdapter contract for Meta's Instagram Messaging API.
 * One instance handles one connected Instagram professional account.
 *
 * Configuration (all via ConfigService / env vars):
 *   INSTAGRAM_APP_SECRET     — Used to verify HMAC-SHA256 webhook signatures
 *   INSTAGRAM_ACCESS_TOKEN   — Page access token for Graph API send calls
 *   INSTAGRAM_PAGE_ID        — The Page/IG account ID to send from
 *   INSTAGRAM_VERIFY_TOKEN   — Secret token for the GET verification handshake
 *
 * Meta Graph API base URL: https://graph.facebook.com/v19.0
 *
 * Notable differences from WhatsApp:
 *  - Webhook `object` is "instagram"; events live under `entry[].messaging[]`
 *    (not `entry[].changes[].value.messages[]`).
 *  - Outbound body is `{ recipient: { id }, message: {...} }` posted to
 *    `/{page-id}/messages` — there is no `messaging_product` field.
 *  - No WhatsApp-style approved templates. Interactivity is quick replies.
 *  - Image attachments arrive as direct (expiring) CDN URLs, not media IDs.
 */
@Injectable()
export class InstagramAdapter extends BaseChannelAdapter {
  readonly channelType = ChannelType.INSTAGRAM;

  private readonly metaBaseUrl: string;
  private readonly appSecret: string;
  /** Fail-closed switch: a missing secret rejects webhooks in production. */
  private readonly isProduction: boolean;
  private readonly accessToken: string;
  private readonly pageId: string;
  private readonly verifyToken: string;

  constructor(private readonly configService: ConfigService) {
    super('InstagramAdapter', { maxAttempts: 3, retryDelayMs: 500 });

    this.metaBaseUrl = 'https://graph.facebook.com/v19.0';
    this.appSecret = this.configService.get<string>('instagram.appSecret', '');
    this.accessToken = this.configService.get<string>('instagram.accessToken', '');
    this.pageId = this.configService.get<string>('instagram.pageId', '');
    this.verifyToken = this.configService.get<string>('instagram.verifyToken', '');
    this.isProduction = isProductionEnv(this.configService);

    if (!this.appSecret) {
      this.logger.warn(
        this.isProduction
          ? 'INSTAGRAM_APP_SECRET is not set — inbound Instagram webhooks will be REJECTED'
          : 'INSTAGRAM_APP_SECRET is not set — webhook signature verification disabled (non-production)',
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
   * Instagram uses the same signature scheme as the rest of the Graph API.
   *
   * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
   */
  validateWebhook(req: RawRequest): boolean {
    if (!this.appSecret) {
      return allowUnverifiedWebhook(
        this.logger,
        this.isProduction,
        'INSTAGRAM_APP_SECRET is not set',
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

  /**
   * Handle Meta's GET verification challenge for the Instagram webhook.
   *
   * When a webhook URL is registered in the Meta Developer Console, Meta
   * sends a GET request carrying `hub.mode`, `hub.verify_token`, and
   * `hub.challenge`. We echo back the challenge only when the mode is
   * "subscribe" and the verify token matches the configured secret.
   *
   * Returns the challenge string to echo back, or `null` when verification
   * fails (caller should respond 403).
   *
   * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#configure-webhooks-product
   */
  verifyChallenge(mode: string | undefined, token: string | undefined, challenge: string | undefined): string | null {
    if (mode === 'subscribe' && token === this.verifyToken && challenge !== undefined) {
      this.logger.log('Instagram webhook verification successful');
      return challenge;
    }

    this.logger.warn(
      `Instagram webhook verification failed: mode=${mode}, tokenMatch=${token === this.verifyToken}`,
    );
    return null;
  }

  // ─────────────────────────────────────────────
  // Inbound parsing
  // ─────────────────────────────────────────────

  /**
   * Parse an Instagram webhook payload into GoSumo's NormalizedMessage format.
   *
   * Meta batches multiple events in one POST. This returns the first
   * parseable inbound message. Echo events (`is_echo`) — copies of messages
   * the business itself sent — and read receipts are skipped.
   *
   * Throws if the payload contains no parseable inbound message.
   */
  parseInbound(req: RawRequest): NormalizedMessage {
    const payload = req.body as IgWebhookPayload;

    if (payload.object !== 'instagram') {
      throw new Error(
        `Unexpected webhook object type: "${payload.object}" — expected "instagram"`,
      );
    }

    for (const entry of payload.entry) {
      for (const event of entry.messaging ?? []) {
        // Skip echoes of our own outbound messages and pure read receipts
        if (event.message?.is_echo) continue;
        if (!event.message && !event.postback && !event.reaction) continue;

        return this.buildNormalizedMessage(event);
      }
    }

    throw new Error('Webhook payload contained no parseable inbound message');
  }

  /**
   * Parse all inbound messages from a single Instagram webhook payload.
   * Returns an empty array if the webhook only contains echoes / read receipts.
   */
  parseInboundAll(req: RawRequest): NormalizedMessage[] {
    const payload = req.body as IgWebhookPayload;
    const results: NormalizedMessage[] = [];

    if (payload.object !== 'instagram') return results;

    for (const entry of payload.entry) {
      for (const event of entry.messaging ?? []) {
        if (event.message?.is_echo) continue;
        if (!event.message && !event.postback && !event.reaction) continue;

        try {
          results.push(this.buildNormalizedMessage(event));
        } catch (err) {
          this.logger.warn(
            `Could not parse Instagram event from ${event.sender.id}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
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

  /**
   * Instagram Messaging has no WhatsApp-style approved template system.
   * This always resolves to a failed result rather than throwing so the
   * caller's `message.failed` flow runs as normal.
   */
  async sendTemplate(_template: TemplateMessage): Promise<SendResult> {
    this.logger.warn('sendTemplate called on InstagramAdapter — Instagram does not support templates');
    return {
      success: false,
      error: 'Instagram does not support template messages',
    };
  }

  /**
   * Send an interactive message. On Instagram the only inline-interactivity
   * primitive is quick replies, so the InteractiveMessage `action` must
   * carry a `quickReplies` array of `{ title, payload, imageUrl? }`.
   */
  async sendInteractive(interactive: InteractiveMessage): Promise<SendResult> {
    return this.sendWithRetry(async () => {
      const quickReplies = this.buildQuickReplies(interactive.action);

      if (quickReplies.length === 0) {
        return {
          success: false,
          error: 'Instagram interactive messages require a non-empty action.quickReplies array',
        };
      }

      const body: IgSendMessageRequest = {
        recipient: { id: interactive.recipientExternalId },
        message: {
          text: interactive.body,
          quick_replies: quickReplies,
        },
      };
      return this.callMetaApi(body);
    }, 'sendInteractive');
  }

  // ─────────────────────────────────────────────
  // Media
  // ─────────────────────────────────────────────

  /**
   * Download an Instagram media asset.
   *
   * Unlike WhatsApp, Instagram delivers attachments as direct (but
   * short-lived) CDN URLs, so `mediaId` here is the full URL captured at
   * parse time. We fetch it straight away — these URLs expire, so callers
   * should re-upload to GoSumo storage immediately.
   */
  async downloadMedia(mediaId: string): Promise<Buffer> {
    const resp = await fetch(mediaId, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (!resp.ok) {
      throw new Error(`Media download failed: ${resp.status} ${resp.statusText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  // ─────────────────────────────────────────────
  // Capabilities
  // ─────────────────────────────────────────────

  getCapabilities(): ChannelCapabilities {
    return {
      channelType: ChannelType.INSTAGRAM,
      supportsTemplates: false,
      supportsInteractiveMessages: true,
      supportsMedia: true,
      supportsVoice: false,
      supportsReactions: true,
      supportsReadReceipts: true,
      supportsPaymentLinks: false,
      // Instagram caps direct-message text at 1000 characters
      maxMessageLength: 1000,
    };
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

  /**
   * Map a single Instagram messaging event to a NormalizedMessage.
   */
  private buildNormalizedMessage(event: IgMessagingEvent): NormalizedMessage {
    const externalId =
      event.message?.mid ?? event.postback?.mid ?? event.reaction?.mid ?? generateId();

    return {
      id: generateId(),
      externalId,
      channel: ChannelType.INSTAGRAM,
      // The business's IG account is the recipient of an inbound message
      channelAccountId: event.recipient.id,
      direction: MessageDirection.INBOUND,
      sender: {
        externalId: event.sender.id,
      },
      content: this.parseEventContent(event),
      timestamp: new Date(event.timestamp),
      metadata: {
        instagramAccountId: event.recipient.id,
        storyReplyUrl: event.message?.reply_to?.story?.url,
        storyReplyId: event.message?.reply_to?.story?.id,
      },
    };
  }

  /**
   * Map an Instagram messaging event to GoSumo's MessageContent union.
   * Throws for events we can't represent so callers can skip/surface them.
   */
  private parseEventContent(event: IgMessagingEvent): NormalizedMessage['content'] {
    // Postback — taps on a generic-template button / ice breaker
    if (event.postback) {
      return {
        type: MessageContentType.INTERACTIVE,
        interactiveType: 'postback',
        payload: {
          id: event.postback.payload,
          title: event.postback.title ?? '',
        },
      };
    }

    // Reaction — surface as text, mirroring the WhatsApp adapter
    if (event.reaction) {
      const emoji = event.reaction.emoji ?? event.reaction.reaction ?? '?';
      return {
        type: MessageContentType.TEXT,
        text: `[reaction: ${emoji} on ${event.reaction.mid}]`,
      };
    }

    const message = event.message;
    if (!message) {
      throw new Error('Instagram event has no message, postback, or reaction content');
    }

    // Quick-reply tap carries both text and a payload — represent as interactive
    if (message.quick_reply) {
      return {
        type: MessageContentType.INTERACTIVE,
        interactiveType: 'quick_reply',
        payload: {
          id: message.quick_reply.payload,
          title: message.text ?? '',
        },
      };
    }

    // Attachments — take the first one; images map to IMAGE content
    const attachment = message.attachments?.[0];
    if (attachment) {
      return this.parseAttachmentContent(attachment);
    }

    // Plain text
    if (message.text !== undefined) {
      return {
        type: MessageContentType.TEXT,
        text: message.text,
      };
    }

    throw new Error(`Unsupported Instagram message ${message.mid}: no text or attachment`);
  }

  private parseAttachmentContent(attachment: IgAttachment): NormalizedMessage['content'] {
    switch (attachment.type) {
      case 'image':
      case 'story_mention':
      case 'share': {
        const url = attachment.payload.url;
        if (!url) throw new Error(`Instagram ${attachment.type} attachment missing payload.url`);
        return {
          type: MessageContentType.IMAGE,
          url,
          // Instagram does not provide a MIME type in the webhook payload
          mimeType: 'image/jpeg',
        };
      }

      case 'video':
      case 'audio':
      case 'file': {
        const url = attachment.payload.url;
        if (!url) throw new Error(`Instagram ${attachment.type} attachment missing payload.url`);
        // No dedicated audio/video content type — store as IMAGE-style media ref
        return {
          type: MessageContentType.IMAGE,
          url,
          mimeType: attachment.type === 'video' ? 'video/mp4' : 'application/octet-stream',
        };
      }

      case 'location': {
        const coords = attachment.payload.coordinates;
        if (!coords) throw new Error('Instagram location attachment missing coordinates');
        return {
          type: MessageContentType.LOCATION,
          latitude: coords.lat,
          longitude: coords.long,
          name: attachment.payload.title,
        };
      }

      default:
        throw new Error(`Unsupported Instagram attachment type: "${attachment.type}"`);
    }
  }

  /**
   * Build the Instagram Graph API request body from a GoSumo OutboundMessage.
   * Instagram supports text and image (via public URL) here; interactive and
   * template content must go through sendInteractive() / sendTemplate().
   */
  private buildSendMessageBody(message: OutboundMessage): IgSendMessageRequest {
    const recipient = { id: message.recipientExternalId };
    const content = message.content;

    switch (content.type) {
      case MessageContentType.TEXT:
        return { recipient, message: { text: content.text } };

      case MessageContentType.IMAGE:
        return {
          recipient,
          message: {
            attachment: {
              type: 'image',
              payload: { url: content.url, is_reusable: false },
            },
          },
        };

      case MessageContentType.DOCUMENT:
        return {
          recipient,
          message: {
            attachment: {
              type: 'file',
              payload: { url: content.url, is_reusable: false },
            },
          },
        };

      case MessageContentType.INTERACTIVE:
      case MessageContentType.TEMPLATE:
      case MessageContentType.PAYMENT_LINK:
        throw new Error(
          `Use sendInteractive() for interactive content; Instagram does not support ` +
            `content type: ${content.type}`,
        );

      case MessageContentType.LOCATION:
        throw new Error('Instagram does not support sending location messages');

      default: {
        const _exhaustive: never = content;
        throw new Error(`Unhandled content type: ${(_exhaustive as { type: string }).type}`);
      }
    }
  }

  /**
   * Coerce the loosely-typed InteractiveMessage.action into Instagram
   * quick-reply objects. Reads from `action.quickReplies`.
   */
  private buildQuickReplies(action: Record<string, unknown>): IgQuickReply[] {
    const raw = action['quickReplies'];
    if (!Array.isArray(raw)) return [];

    const buttons = raw as QuickReplyButton[];
    return buttons
      .filter((b) => b && typeof b.title === 'string' && typeof b.payload === 'string')
      .map((b) => ({
        content_type: 'text' as const,
        title: b.title,
        payload: b.payload,
        ...(b.imageUrl && { image_url: b.imageUrl }),
      }));
  }

  /**
   * POST a message to the Instagram Messaging API and parse the response.
   */
  private async callMetaApi(body: IgSendMessageRequest): Promise<SendResult> {
    const url = `${this.metaBaseUrl}/${this.pageId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      let errorMessage = `Meta API returned ${response.status}`;
      try {
        const errBody = (await response.json()) as { error?: { message?: string; code?: number } };
        if (errBody.error?.message) {
          errorMessage = `Meta API error ${errBody.error.code ?? response.status}: ${errBody.error.message}`;
        }
      } catch {
        // Body not JSON — use the status-only message
      }

      // 4xx are non-retryable (invalid recipient, token, outside 24h window, etc.)
      // 5xx are retried by sendWithRetry.
      if (response.status >= 500) {
        throw new Error(errorMessage);
      }

      return { success: false, error: errorMessage };
    }

    const json = (await response.json()) as IgSendMessageResponse;

    return {
      success: true,
      externalMessageId: json.message_id,
      sentAt: new Date(),
    };
  }
}

/**
 * Utility: check whether an Instagram webhook payload contains only events
 * we don't process (echoes, read receipts). Used by the controller to
 * short-circuit acknowledgement.
 */
export function isNonMessageEventOnly(body: unknown): boolean {
  const payload = body as IgWebhookPayload;
  if (!payload?.entry) return false;

  for (const entry of payload.entry) {
    for (const event of entry.messaging ?? []) {
      if (event.message?.is_echo) continue;
      if (event.message || event.postback || event.reaction) {
        return false;
      }
    }
  }

  return true;
}
