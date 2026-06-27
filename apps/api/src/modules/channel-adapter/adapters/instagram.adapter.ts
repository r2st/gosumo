import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
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
} from "@gosumo/shared";
import { generateId } from "@gosumo/shared";
import { BaseChannelAdapter } from "./base.adapter";

// ─────────────────────────────────────────────
// Instagram Messenger Platform types
// ─────────────────────────────────────────────

interface InstagramWebhookPayload {
  object: string;
  entry: InstagramEntry[];
}

interface InstagramEntry {
  id: string;
  time: number;
  messaging: InstagramMessagingEvent[];
}

interface InstagramMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: Array<{
      type: string;
      payload: { url: string };
    }>;
  };
  postback?: {
    mid: string;
    title: string;
    payload: string;
  };
}

/**
 * Check if the webhook payload is a status-only update (no messages).
 */
export function isInstagramStatusOnly(body: unknown): boolean {
  const payload = body as InstagramWebhookPayload;
  if (!payload?.entry) return false;

  for (const entry of payload.entry) {
    if (entry.messaging?.length > 0) {
      return false;
    }
  }
  return true;
}

@Injectable()
export class InstagramAdapter extends BaseChannelAdapter {
  readonly channelType = ChannelType.INSTAGRAM;

  private readonly appSecret: string;
  private readonly accessToken: string;
  private readonly pageId: string;
  private readonly metaBaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    super("InstagramAdapter", { maxAttempts: 3, retryDelayMs: 500 });

    this.metaBaseUrl = "https://graph.facebook.com/v19.0";
    this.appSecret = this.configService.get<string>("instagram.appSecret", "");
    this.accessToken = this.configService.get<string>("instagram.accessToken", "");
    this.pageId = this.configService.get<string>("instagram.pageId", "");

    if (!this.appSecret) {
      this.logger.warn("INSTAGRAM_APP_SECRET is not set — webhook signature verification disabled");
    }
  }

  validateWebhook(req: RawRequest): boolean {
    if (!this.appSecret) {
      this.logger.warn("Webhook signature verification skipped — INSTAGRAM_APP_SECRET not set");
      return true;
    }

    const signature = (req.headers["x-hub-signature-256"] as string | undefined) ?? "";
    if (!signature.startsWith("sha256=")) {
      this.logger.warn("Webhook rejected: missing or malformed X-Hub-Signature-256 header");
      return false;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      this.logger.warn("Webhook rejected: rawBody not available for signature verification");
      return false;
    }

    const expectedHash = crypto
      .createHmac("sha256", this.appSecret)
      .update(rawBody)
      .digest("hex");

    const expectedSignature = `sha256=${expectedHash}`;

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (sigBuffer.length !== expectedBuffer.length) {
      this.logger.warn("Webhook rejected: signature length mismatch");
      return false;
    }

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  }

  parseInbound(req: RawRequest): NormalizedMessage {
    const payload = req.body as InstagramWebhookPayload;

    if (payload.object !== "instagram") {
      throw new Error(`Unexpected webhook object type: "${payload.object}" — expected "instagram"`);
    }

    for (const entry of payload.entry) {
      if (!entry.messaging || entry.messaging.length === 0) continue;

      const event = entry.messaging[0]!;

      if (event.message) {
        const content = event.message.text
          ? { type: MessageContentType.TEXT as const, text: event.message.text }
          : event.message.attachments?.[0]
            ? {
                type: MessageContentType.IMAGE as const,
                url: event.message.attachments[0].payload.url,
                mimeType: "image/jpeg",
              }
            : { type: MessageContentType.TEXT as const, text: "[unsupported content]" };

        return {
          id: generateId(),
          externalId: event.message.mid,
          channel: ChannelType.INSTAGRAM,
          channelAccountId: event.recipient.id,
          direction: MessageDirection.INBOUND,
          sender: {
            externalId: event.sender.id,
          },
          content,
          timestamp: new Date(event.timestamp),
          metadata: {
            pageId: entry.id,
            recipientId: event.recipient.id,
          },
        };
      }

      if (event.postback) {
        return {
          id: generateId(),
          externalId: event.postback.mid,
          channel: ChannelType.INSTAGRAM,
          channelAccountId: event.recipient.id,
          direction: MessageDirection.INBOUND,
          sender: {
            externalId: event.sender.id,
          },
          content: {
            type: MessageContentType.INTERACTIVE,
            interactiveType: "postback",
            payload: {
              title: event.postback.title,
              payload: event.postback.payload,
            },
          },
          timestamp: new Date(event.timestamp),
          metadata: {
            pageId: entry.id,
          },
        };
      }
    }

    throw new Error("Webhook payload contained no parseable inbound message");
  }

  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    return this.sendWithRetry(async () => {
      const pageId = this.pageId || message.channelAccountId;
      const url = `${this.metaBaseUrl}/${pageId}/messages`;

      let messageBody: Record<string, unknown>;

      if (message.content.type === MessageContentType.TEXT) {
        messageBody = {
          recipient: { id: message.recipientExternalId },
          message: { text: message.content.text },
        };
      } else if (message.content.type === MessageContentType.IMAGE) {
        messageBody = {
          recipient: { id: message.recipientExternalId },
          message: {
            attachment: {
              type: "image",
              payload: { url: message.content.url },
            },
          },
        };
      } else {
        // Fallback to text
        messageBody = {
          recipient: { id: message.recipientExternalId },
          message: { text: "[content type not supported on Instagram]" },
        };
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(messageBody),
      });

      if (!response.ok) {
        let errorMessage = `Instagram API returned ${response.status}`;
        try {
          const errBody = (await response.json()) as { error?: { message?: string } };
          if (errBody.error?.message) {
            errorMessage = `Instagram API error: ${errBody.error.message}`;
          }
        } catch {
          // ignore
        }

        if (response.status >= 500) {
          throw new Error(errorMessage);
        }
        return { success: false, error: errorMessage };
      }

      const json = (await response.json()) as { message_id?: string };
      return {
        success: true,
        externalMessageId: json.message_id,
        sentAt: new Date(),
      };
    }, "sendMessage");
  }

  async sendTemplate(_template: TemplateMessage): Promise<SendResult> {
    return {
      success: false,
      error: "Instagram does not support template messages",
    };
  }

  async sendInteractive(_interactive: InteractiveMessage): Promise<SendResult> {
    return {
      success: false,
      error: "Instagram interactive messages are not yet implemented",
    };
  }

  getCapabilities(): ChannelCapabilities {
    return {
      channelType: ChannelType.INSTAGRAM,
      supportsTemplates: false,
      supportsInteractiveMessages: true,
      supportsMedia: true,
      supportsVoice: false,
      supportsReactions: false,
      supportsReadReceipts: true,
      supportsPaymentLinks: false,
      maxMessageLength: 1000,
    };
  }
}
