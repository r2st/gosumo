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

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly channelAdapterService: ChannelAdapterService,
  ) {}

  handleConnection(client: Socket): void {
    const widgetId = client.handshake.query.widgetId as string;
    this.logger.log("WebChat client connected: " + client.id + " widgetId=" + (widgetId || "none"));
  }

  handleDisconnect(client: Socket): void {
    const sessionId = this.socketToSession.get(client.id);
    if (sessionId) {
      this.sessions.delete(sessionId);
      this.socketToSession.delete(client.id);
      this.logger.log("WebChat session cleaned up: " + sessionId);
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

    const sessionId = data.sessionId || generateId();

    // Register session
    this.sessions.set(sessionId, client);
    this.socketToSession.set(client.id, sessionId);

    const meta = channel.metadata as Record<string, unknown>;
    const greeting = (meta.greeting as string) || "Hello! How can we help you today?";

    this.logger.log("WebChat session initialized: " + sessionId + " for widget " + widgetId);

    return { sessionId, greeting };
  }

  @SubscribeMessage("chat:message")
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId: string; text: string },
  ): Promise<{ received: boolean; messageId: string }> {
    const sessionId = data.sessionId;
    const text = data.text;
    const messageId = generateId();

    // Build a NormalizedMessage-like event
    const event = {
      id: generateId(),
      type: "message.received",
      timestamp: new Date().toISOString(),
      businessId: "",
      correlationId: generateCorrelationId(),
      messageId,
      conversationId: "",
      channelAccountId: "",
      channel: ChannelType.WEB_CHAT,
      senderExternalId: sessionId,
      clientId: "",
      content: {
        type: MessageContentType.TEXT,
        text,
      },
      metadata: { sessionId },
    };

    this.eventEmitter.emit("message.received", event);

    this.logger.log("WebChat message received from session " + sessionId + ": " + text.substring(0, 50));

    return { received: true, messageId };
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
