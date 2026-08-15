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
import {
  isProductionEnv,
  verifySharedSecretSignature,
} from "../../../common/utils/webhook-verification.util";

/** One buffered outbound reply, exactly as the gateway will emit it. */
export interface WebChatPendingMessage {
  id: string;
  text: string;
  timestamp: Date;
}

/**
 * Pending outbound replies keyed by sessionId — the hand-off between this
 * adapter (which has no socket) and the gateway (which has no adapter).
 *
 * It is a buffer, not a store. Every entry is expected to leave it almost
 * immediately: {@link enqueueWebChatResponse} notifies the gateway on each
 * push, and the gateway drains the session as soon as it can see a live socket
 * for it. What stays behind is only what could not be delivered — a visitor
 * who closed the tab, or one mid-reconnect — and that is bounded three ways
 * below.
 */
export const webchatResponseMap = new Map<string, WebChatPendingMessage[]>();

/**
 * Replies held for one disconnected session. Past this the oldest are dropped:
 * a visitor coming back wants the end of the conversation, not the start of a
 * backlog, and an unbounded per-session list is one stuck session away from
 * being the whole leak on its own.
 */
export const WEBCHAT_OUTBOX_MAX_PER_SESSION = 50;

/**
 * Sessions held at once. The key space is one entry per visitor a business has
 * ever been replied to, so without a ceiling this grows for the life of the
 * process.
 */
export const WEBCHAT_OUTBOX_MAX_SESSIONS = 5_000;

/**
 * How long an undelivered reply is worth keeping. A visitor who has been gone
 * a quarter of an hour is not coming back to this buffer — the conversation is
 * in the database, and the widget renders history from there on reconnect.
 */
export const WEBCHAT_OUTBOX_TTL_MS = 15 * 60_000;

/**
 * Called with a sessionId whenever a reply is buffered for it. The gateway
 * registers itself here; anything it delivers it removes from the map.
 *
 * This is what makes the buffer a buffer. Before it, `sendMessage` pushed into
 * `webchatResponseMap` and the only drain — `WebChatGateway.deliverPendingMessages()`
 * — was called by nothing: not a timer, not an event, not a caller anywhere in
 * the app. So every AI reply to a web-chat visitor was appended to a
 * process-global Map that was never read and never cleared. The visitor saw
 * silence, and the process kept the text (and its PII) until it restarted.
 */
export type WebChatDeliverySink = (sessionId: string) => void;

let deliverySink: WebChatDeliverySink | null = null;

/** Register (or, with `null`, clear) the gateway that drains the outbox. */
export function setWebChatDeliverySink(sink: WebChatDeliverySink | null): void {
  deliverySink = sink;
}

/** The newest message in a session's buffer dates the session as a whole. */
function lastActivity(messages: WebChatPendingMessage[]): number {
  let newest = 0;
  for (const m of messages) {
    const at = m.timestamp.getTime();
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * Drop sessions whose buffered replies have aged out, then — if the map is
 * still over its ceiling — the least recently active ones until it is not.
 *
 * @returns how many sessions were dropped.
 */
export function evictStaleWebChatResponses(now: number = Date.now()): number {
  let dropped = 0;

  for (const [sessionId, messages] of webchatResponseMap) {
    if (messages.length === 0 || now - lastActivity(messages) >= WEBCHAT_OUTBOX_TTL_MS) {
      webchatResponseMap.delete(sessionId);
      dropped += 1;
    }
  }

  if (webchatResponseMap.size <= WEBCHAT_OUTBOX_MAX_SESSIONS) return dropped;

  // Still over the ceiling with nothing expired: shed the coldest sessions.
  // Sorting only happens on the overflow path, which a healthy process never
  // reaches.
  const byAge = [...webchatResponseMap.entries()].sort(
    (a, b) => lastActivity(a[1]) - lastActivity(b[1]),
  );
  const excess = webchatResponseMap.size - WEBCHAT_OUTBOX_MAX_SESSIONS;
  for (let i = 0; i < excess; i += 1) {
    webchatResponseMap.delete(byAge[i]![0]);
    dropped += 1;
  }

  return dropped;
}

/**
 * Buffer one outbound reply and tell the gateway to try delivering it.
 *
 * The sink runs synchronously, so for a connected visitor the message is
 * emitted and removed again before this returns and nothing is retained at all.
 */
export function enqueueWebChatResponse(
  sessionId: string,
  message: WebChatPendingMessage,
  now: number = Date.now(),
): void {
  evictStaleWebChatResponses(now);

  const pending = webchatResponseMap.get(sessionId) ?? [];
  pending.push(message);
  // Keep the tail: the newest replies are the ones the visitor is waiting on.
  if (pending.length > WEBCHAT_OUTBOX_MAX_PER_SESSION) {
    pending.splice(0, pending.length - WEBCHAT_OUTBOX_MAX_PER_SESSION);
  }
  webchatResponseMap.set(sessionId, pending);

  // A sink that throws must not fail the send — the adapter has already
  // reported success to the AI pipeline, and the message is safely buffered.
  try {
    deliverySink?.(sessionId);
  } catch {
    // Delivery is best-effort; the buffer (and its TTL) is the fallback.
  }
}

@Injectable()
export class WebChatAdapter extends BaseChannelAdapter {
  readonly channelType = ChannelType.WEB_CHAT;

  private readonly inboundSecret: string;
  /** Fail-closed switch: an unverifiable webhook is rejected in production. */
  private readonly isProduction: boolean;

  constructor(private readonly configService: ConfigService) {
    super("WebChatAdapter");
    this.inboundSecret = this.configService.get<string>("channelWebhook.webchatSecret", "");
    this.isProduction = isProductionEnv(this.configService);
  }

  /**
   * Verify an inbound web-chat callback.
   *
   * The widget's normal path is the WebSocket gateway, which is where the
   * "always valid" this method used to return came from. But `POST
   * /webhooks/:channel` is `@Public()` and accepts every `ChannelType`, so
   * `POST /webhooks/web_chat` reached this method unauthenticated — a forged
   * customer message into any tenant's inbox, tenant chosen by header.
   *
   * The HTTP path is for relays we configure ourselves, so it is held to the
   * same shared-secret HMAC as the email channel. The WebSocket path is
   * unaffected: it never calls `validateWebhook`.
   */
  validateWebhook(req: RawRequest): boolean {
    return verifySharedSecretSignature({
      logger: this.logger,
      isProduction: this.isProduction,
      secret: this.inboundSecret,
      headerName: "x-gosumo-signature",
      headers: req.headers,
      rawBody: req.rawBody,
      channelLabel: "WEB_CHAT",
    });
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

    enqueueWebChatResponse(sessionId, { id: messageId, text, timestamp: new Date() });

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
