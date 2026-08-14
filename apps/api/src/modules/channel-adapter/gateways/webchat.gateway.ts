import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Server, Socket } from "socket.io";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  ChannelType,
  MessageDirection,
  MessageContentType,
} from "@gosumo/shared";
import { generateId, generateCorrelationId } from "@gosumo/shared";
import { PrismaService } from "../../../common/services/prisma.service";
import { ChannelAdapterService } from "../channel-adapter.service";
import { webchatResponseMap } from "../adapters/webchat.adapter";
import {
  signWebChatSession,
  verifyWebChatSession,
} from "../../../common/utils/webchat-session.util";
import { clientIp } from "../../../common/utils/client-ip.util";
import { WebChatThrottle } from "./webchat-throttle";

interface SessionContext {
  businessId: string;
  channelAccountId: string;
  clientId: string;
  conversationId: string;
}

@WebSocketGateway({
  namespace: "/webchat",
  cors: { origin: "*", credentials: true },
})
export class WebChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WebChatGateway.name);

  /** Map sessionId -> Socket for routing outbound messages */
  private readonly sessions = new Map<string, Socket>();

  /** Map socket.id -> sessionId for cleanup on disconnect */
  private readonly socketToSession = new Map<string, string>();

  /** Map sessionId -> business/client/conversation context */
  private readonly sessionContext = new Map<string, SessionContext>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly channelAdapterService: ChannelAdapterService,
    private readonly configService: ConfigService,
    private readonly throttle: WebChatThrottle,
  ) {}

  /**
   * The visitor's address, for rationing. Socket.IO's handshake carries the
   * same headers an Express request would, so the reverse-proxy rules in
   * {@link clientIp} apply unchanged. Best-effort grouping key only — nothing
   * authenticates on it.
   */
  private callerIp(client: Socket): string | null {
    return clientIp({
      headers: client.handshake?.headers,
      ip: client.handshake?.address,
    });
  }

  /**
   * Key the session-token HMAC is signed with.
   *
   * `JWT_SECRET` is already a required env var, so this adds no new deployment
   * surface — and it is the same key the OAuth state tokens use.
   */
  private sessionSecret(): string {
    return this.configService.get<string>("jwt.secret", "");
  }

  handleConnection(client: Socket): void {
    const widgetId = client.handshake.query.widgetId as string;
    this.logger.log("WebChat client connected: " + client.id + " widgetId=" + (widgetId || "none"));
  }

  handleDisconnect(client: Socket): void {
    const sessionId = this.socketToSession.get(client.id);
    this.socketToSession.delete(client.id);

    if (sessionId) {
      // Only tear the session down if this socket is still the one holding it.
      //
      // The widget persists its sessionId and reconnects with it, and Socket.IO
      // does not notice the old socket is gone until pingTimeout elapses — so
      // the reconnect's `chat:init` regularly lands *before* the old socket's
      // disconnect. Deleting unconditionally then wiped the live socket and the
      // context that had just replaced it, and every `chat:message` after that
      // answered `received: false` and dropped the visitor's text on the floor
      // until they reloaded the page. Nothing surfaced: the widget had a
      // sessionId, the socket was open, and the messages simply went nowhere.
      if (this.sessions.get(sessionId) !== client) {
        this.logger.log(
          "WebChat socket " + client.id + " disconnected after session " + sessionId +
          " moved to a newer socket — keeping the live session",
        );
      } else {
        this.sessions.delete(sessionId);
        this.sessionContext.delete(sessionId);
        this.logger.log("WebChat session cleaned up: " + sessionId);
      }
    }
    this.logger.log("WebChat client disconnected: " + client.id);
  }

  @SubscribeMessage("chat:init")
  async handleInit(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { widgetId: string; sessionId?: string },
  ): Promise<{ sessionId: string; greeting: string }> {
    const widgetId = data.widgetId;

    // Validate widgetId against channel_accounts
    const channel = await this.prisma.channel_accounts.findFirst({
      where: {
        id: widgetId,
        channel: ChannelType.WEB_CHAT,
        is_active: true,
        deleted_at: null,
      },
    });

    if (!channel) {
      this.logger.warn("Invalid widgetId: " + widgetId);
      return { sessionId: "", greeting: "Widget not found" };
    }

    const secret = this.sessionSecret();
    if (!secret) {
      // Without a signing key every session token would be forgeable, so refuse
      // to open the channel rather than fall back to the unauthenticated form.
      this.logger.error(
        "Cannot start a WebChat session: jwt.secret is not configured",
      );
      return { sessionId: "", greeting: "Chat is unavailable right now" };
    }

    // The visitor's token is the only claim to an existing thread, and it
    // arrives from a browser we do not control. Verify it — and verify it was
    // minted for *this* widget — before letting it name a session; anything
    // that fails simply starts a fresh one.
    let sessionId: string;
    let isNewSession: boolean;
    if (data.sessionId) {
      const verified = verifyWebChatSession(data.sessionId, secret, widgetId);
      if (verified) {
        sessionId = verified.sessionId;
        isNewSession = false;
      } else {
        sessionId = generateId();
        isNewSession = true;
        this.logger.warn(
          "Rejected WebChat session token for widget " + widgetId +
          " (forged, expired, or minted for another widget) — issuing a new session",
        );
      }
    } else {
      sessionId = generateId();
      isNewSession = true;
    }

    // Only *new* sessions are charged. A fresh one inserts a client, a contact
    // and a conversation, then fans `conversation.created` out across the
    // platform; a resume does none of that. Charging resumes too would punish
    // a visitor whose connection keeps dropping, which is the case the token
    // replay exists to serve.
    if (isNewSession && !this.throttle.consume("session", this.callerIp(client))) {
      this.logger.warn(
        "WebChat session rate limit reached for widget " + widgetId + " — refusing to open a new session",
      );
      return { sessionId: "", greeting: "Too many chat sessions. Please try again shortly." };
    }

    // Only the signed form leaves the server. Everything below — the maps, the
    // `channel_contacts.external_id`, the emitted events — keys on the raw id.
    const sessionToken = signWebChatSession(widgetId, secret, sessionId);

    // Find or create a client for this webchat visitor
    const clientRecord = await this.findOrCreateWebChatClient(
      channel.business_id,
      sessionId,
      widgetId,
    );

    // Find or create a conversation
    const conversation = await this.findOrCreateConversation(
      channel.business_id,
      clientRecord.id,
      widgetId,
    );

    // Store context for message handling
    const ctx: SessionContext = {
      businessId: channel.business_id,
      channelAccountId: widgetId,
      clientId: clientRecord.id,
      conversationId: conversation.id,
    };
    this.sessionContext.set(sessionId, ctx);

    // Register session. A reconnect re-inits with the stored sessionId, so the
    // previous socket's reverse mapping has to go with it — left behind, it
    // would name a session it no longer owns.
    const previous = this.sessions.get(sessionId);
    if (previous && previous.id !== client.id) {
      this.socketToSession.delete(previous.id);
    }
    this.sessions.set(sessionId, client);
    this.socketToSession.set(client.id, sessionId);

    const meta = channel.metadata as Record<string, unknown>;
    const greeting = (meta?.greeting as string) || "Hello! How can we help you today?";

    this.logger.log(
      "WebChat session initialized: " + sessionId +
      " for widget " + widgetId +
      " client " + clientRecord.id +
      " conversation " + conversation.id,
    );

    return { sessionId: sessionToken, greeting };
  }

  @SubscribeMessage("chat:message")
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId?: string; text: string },
  ): Promise<{ received: boolean; messageId: string }> {
    const text = data.text;
    const messageId = generateId();
    const correlationId = generateCorrelationId();

    // The session comes from the socket, never from the body.
    //
    // `sessionContext` is a process-wide map spanning every tenant, so honouring
    // `data.sessionId` let any connected socket post into any *other* live
    // visitor's conversation — under that conversation's businessId — just by
    // naming its session. No forged init and no database read were needed; the
    // handler simply looked up whatever key it was handed. Resolving through
    // `socketToSession` binds a message to the session this socket actually
    // completed `chat:init` for. The body field is still accepted for wire
    // compatibility with older widgets, and still ignored.
    const sessionId = this.socketToSession.get(client.id);
    if (!sessionId) {
      this.logger.warn(
        "Rejected chat:message from socket " + client.id + " with no initialized session",
      );
      return { received: false, messageId };
    }

    const ctx = this.sessionContext.get(sessionId);
    if (!ctx) {
      this.logger.warn("No session context for " + sessionId);
      return { received: false, messageId };
    }

    // Every accepted message reaches the AI pipeline, which is an outbound LLM
    // call — so this ceiling bounds spend, not just rows. Both dimensions are
    // charged: the per-session one is the per-visitor ceiling, and the per-IP
    // one stops a host spending its whole session quota's worth of messages.
    const ip = this.callerIp(client);
    if (
      !this.throttle.consume("message", sessionId) ||
      !this.throttle.consume("messageIp", ip)
    ) {
      this.logger.warn("WebChat message rate limit reached for session " + sessionId);
      return { received: false, messageId };
    }

    try {
      // Store the message in the database
      await this.prisma.messages.create({
        data: {
          id: messageId,
          business_id: ctx.businessId,
          conversation_id: ctx.conversationId,
          channel_account_id: ctx.channelAccountId,
          direction: MessageDirection.INBOUND,
          type: "TEXT",
          status: "PENDING",
          sender_type: "CLIENT",
          sender_id: ctx.clientId,
          content: { type: MessageContentType.TEXT, text },
          text_content: text,
          external_id: "webchat_" + messageId,
        },
      });

      // Update conversation last_message_at
      await this.prisma.conversations.update({
        where: { id: ctx.conversationId, business_id: ctx.businessId },
        data: { last_message_at: new Date(), updated_at: new Date() },
      });

      // Emit enriched message.received event with all IDs populated
      const event = {
        id: generateId(),
        type: "message.received",
        timestamp: new Date().toISOString(),
        businessId: ctx.businessId,
        correlationId,
        messageId,
        conversationId: ctx.conversationId,
        channelAccountId: ctx.channelAccountId,
        channel: ChannelType.WEB_CHAT,
        senderExternalId: sessionId,
        clientId: ctx.clientId,
        content: { type: MessageContentType.TEXT, text },
        metadata: { sessionId },
      };

      this.eventEmitter.emit("message.received", event);

      this.logger.log(
        "WebChat message stored and emitted: session=" + sessionId +
        " conversation=" + ctx.conversationId +
        " msg=" + text.substring(0, 50),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error("Failed to process webchat message: " + msg);
      return { received: false, messageId };
    }

    return { received: true, messageId };
  }

  /**
   * Find or create a client for a webchat visitor.
   * Uses the sessionId as the external identifier.
   */
  private async findOrCreateWebChatClient(
    businessId: string,
    sessionId: string,
    channelAccountId: string,
  ) {
    // Check if a client with this webchat session exists via channel_contacts
    const existingContact = await this.prisma.channel_contacts.findFirst({
      where: {
        business_id: businessId,
        channel: ChannelType.WEB_CHAT,
        external_id: sessionId,
      },
      include: { client: true },
    });

    if (existingContact?.client) {
      return existingContact.client;
    }

    // Create a new client and channel contact
    const clientId = generateId();
    const client = await this.prisma.clients.create({
      data: {
        id: clientId,
        business_id: businessId,
        name: "Web Visitor",
      },
    });

    await this.prisma.channel_contacts.create({
      data: {
        id: generateId(),
        business_id: businessId,
        client_id: clientId,
        channel: ChannelType.WEB_CHAT,
        channel_account_id: channelAccountId,
        external_id: sessionId,
      },
    });

    this.logger.log("Created webchat client " + clientId + " for session " + sessionId);

    return client;
  }

  /**
   * Find or create a conversation for a webchat client.
   */
  private async findOrCreateConversation(
    businessId: string,
    clientId: string,
    channelAccountId: string,
  ) {
    // Reuse this visitor's existing thread whatever its status — a RESOLVED one
    // is reopened by the conversation module when message.received lands, so
    // filtering it out here would fork the visitor's history into a duplicate.
    const existing = await this.prisma.conversations.findFirst({
      where: {
        business_id: businessId,
        client_id: clientId,
        channel_account_id: channelAccountId,
        deleted_at: null,
      },
      orderBy: { created_at: "desc" },
    });

    if (existing) {
      return existing;
    }

    // Create a new conversation
    const conversationId = generateId();
    const conversation = await this.prisma.conversations.create({
      data: {
        id: conversationId,
        business_id: businessId,
        client_id: clientId,
        channel_account_id: channelAccountId,
        channel: ChannelType.WEB_CHAT,
        status: "OPEN",
        last_message_at: new Date(),
      },
    });

    // Emit conversation.created event
    this.eventEmitter.emit("conversation.created", {
      type: "conversation.created",
      id: generateId(),
      timestamp: new Date().toISOString(),
      businessId,
      correlationId: generateCorrelationId(),
      conversationId: conversation.id,
      clientId,
      channelAccountId,
      channel: ChannelType.WEB_CHAT,
    });

    this.logger.log("Created webchat conversation " + conversationId + " for client " + clientId);

    return conversation;
  }

  /**
   * Send a message to a specific WebChat session.
   * Called by the WebChat adapter when an outbound message is ready.
   */
  sendToClient(sessionId: string, message: { id: string; text: string; timestamp: Date }): boolean {
    const socket = this.sessions.get(sessionId);
    if (!socket) {
      this.logger.warn("No socket found for session " + sessionId);
      return false;
    }

    socket.emit("chat:response", {
      messageId: message.id,
      text: message.text,
      timestamp: message.timestamp.toISOString(),
    });

    return true;
  }

  /**
   * Poll and deliver pending messages from the webchat response map.
   * This can be called periodically or triggered by events.
   */
  deliverPendingMessages(): void {
    for (const [sessionId, messages] of webchatResponseMap.entries()) {
      if (messages.length === 0) continue;

      const socket = this.sessions.get(sessionId);
      if (socket) {
        for (const msg of messages) {
          socket.emit("chat:response", {
            messageId: msg.id,
            text: msg.text,
            timestamp: msg.timestamp.toISOString(),
          });
        }
        webchatResponseMap.delete(sessionId);
      }
    }
  }
}
