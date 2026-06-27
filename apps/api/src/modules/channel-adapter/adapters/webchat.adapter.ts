import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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

/**
 * Pending outbound messages keyed by sessionId.
 * The WebSocket gateway reads from this map to deliver messages to clients.
 */
export const webchatResponseMap = new Map<string, Array<{ id: string; text: string; timestamp: Date }>>();

@Injectable()
export class WebChatAdapter extends BaseChannelAdapter {
  readonly channelType = ChannelType.WEB_CHAT;

  constructor(private readonly configService: ConfigService) {
    super("WebChatAdapter");
  }

  /** WebChat messages come via WebSocket, not external webhook — always valid. */
  validateWebhook(_req: RawRequest): boolean {
    return true;
  }

  /**
   * Parse a WebSocket message format into NormalizedMessage.
   * Expected body shape: { widgetId, sessionId, text, timestamp }
   */
  parseInbound(req: RawRequest): NormalizedMessage {
    const body = req.body as {
      widgetId?: string;
      sessionId?: string;
      text?: string;
      timestamp?: string | number;
      sender?: string;
    };

    const sessionId = body.sessionId || generateId();
    const widgetId = body.widgetId || "";
    const text = body.text || "";
    const timestamp = body.timestamp ? new Date(body.timestamp) : new Date();

    return {
      id: generateId(),
      externalId: generateId(),
      channel: ChannelType.WEB_CHAT,
      channelAccountId: widgetId,
      direction: MessageDirection.INBOUND,
      sender: {
        externalId: sessionId,
        displayName: body.sender || "Website Visitor",
      },
      content: {
        type: MessageContentType.TEXT,
        text,
      },
      timestamp,
      metadata: {
        widgetId,
        sessionId,
      },
    };
  }

  /**
   * Send a message by storing it in the response map.
   * The WebSocket gateway reads from this map and delivers to the right client.
   */
  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    const messageId = generateId();
    const sessionId = message.recipientExternalId;

    let text: string;
    if (message.content.type === MessageContentType.TEXT) {
      text = message.content.text;
    } else if (message.content.type === MessageContentType.IMAGE) {
      text = message.content.caption || "[Image: " + message.content.url + "]";
    } else if (message.content.type === MessageContentType.DOCUMENT) {
      text = "[Document: " + (message.content as { filename?: string }).filename + "]";
    } else {
      text = "[Unsupported content type]";
    }

    const pending = webchatResponseMap.get(sessionId) || [];
    pending.push({ id: messageId, text, timestamp: new Date() });
    webchatResponseMap.set(sessionId, pending);

    return {
      success: true,
      externalMessageId: messageId,
      sentAt: new Date(),
    };
  }

  /** Convert template to text and send. */
  async sendTemplate(template: TemplateMessage): Promise<SendResult> {
    const paramValues = Object.values(template.parameters).join(", ");
    const text = "Template: " + template.templateName + " — " + paramValues;

    return this.sendMessage({
      channelAccountId: template.channelAccountId,
      recipientExternalId: template.recipientExternalId,
      content: { type: MessageContentType.TEXT, text },
      correlationId: template.correlationId,
    });
  }

  /** Convert interactive to text and send. */
  async sendInteractive(interactive: InteractiveMessage): Promise<SendResult> {
    const text = interactive.body + (interactive.footer ? "\n" + interactive.footer : "");

    return this.sendMessage({
      channelAccountId: interactive.channelAccountId,
      recipientExternalId: interactive.recipientExternalId,
      content: { type: MessageContentType.TEXT, text },
      correlationId: interactive.correlationId,
    });
  }

  getCapabilities(): ChannelCapabilities {
    return {
      channelType: ChannelType.WEB_CHAT,
      supportsTemplates: false,
      supportsInteractiveMessages: true,
      supportsMedia: true,
      supportsVoice: false,
      supportsReactions: false,
      supportsReadReceipts: false,
      supportsPaymentLinks: false,
      maxMessageLength: 10000,
    };
  }
}
