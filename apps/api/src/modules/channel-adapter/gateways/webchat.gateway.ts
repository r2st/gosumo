import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { Logger, Optional, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Server, Socket } from "socket.io";
import { EventEmitter2 } from "@nestjs/event-emitter";
import {
  ChannelType,
  MessageDirection,
  MessageContentType,
} from "@gosumo/shared";
import type { MessageReceivedEvent } from "@gosumo/shared";
import { generateId, generateCorrelationId } from "@gosumo/shared";
import { PrismaService } from "../../../common/services/prisma.service";
import { ChannelAdapterService } from "../channel-adapter.service";
import {
  setWebChatDeliverySink,
  webchatResponseMap,
} from "../adapters/webchat.adapter";
import {
  signWebChatSession,
  verifyWebChatSession,
} from "../../../common/utils/webchat-session.util";
import { clientIp } from "../../../common/utils/client-ip.util";
import { isBlankText } from "../../../common/utils/blank-text.util";
import { corsOptionsFor } from "../../../common/utils/cors.util";
import { ConversationLockService } from "../../../common/services/conversation-lock.service";
import { isUniqueViolation } from "../../../common/utils/sequential-number.util";
import { WebChatThrottle } from "./webchat-throttle";

interface SessionContext {
  businessId: string;
  channelAccountId: string;
  clientId: string;
  conversationId: string;
}

/**
 * Longest visitor message the widget may submit.
 *
 * `WebChatThrottle` bounds how *many* messages a session sends, which is the
 * right shape for row growth but not for the two costs that scale with
 * size: every accepted message is stored verbatim and then handed to the AI
 * pipeline as an outbound LLM call priced per token. Sixty short messages and
 * sixty megabyte ones are the same event count and wildly different bills, so
 * the count ceiling alone left the expensive dimension open.
 *
 * Set above any genuine web-chat turn (and above WhatsApp's own 4096-character
 * body limit, so nothing a visitor could legitimately send on a sibling channel
 * is refused here).
 */
export const WEBCHAT_MAX_MESSAGE_CHARS = 4096;

/**
 * Largest frame Engine.IO will accept on this namespace, in bytes.
 *
 * {@link WEBCHAT_MAX_MESSAGE_CHARS} is an *application* ceiling: it is checked
 * inside `chat:message`, which is to say after the transport has buffered the
 * whole frame and the parser has turned it into an object. Engine.IO's own
 * default is 1 MB, so every rejected message still cost a megabyte of buffer
 * and a megabyte of JSON parsing first — and `chat:init`, which has no length
 * ceiling of its own, could be sent at that size indefinitely.
 *
 * 32 KB is the transport-level backstop: comfortably above 4096 characters
 * even when every one of them is a 4-byte emoji, plus the event name and the
 * JSON envelope, and small enough that a socket flooding oversized frames is
 * refused by the transport rather than by us.
 */
export const WEBCHAT_MAX_FRAME_BYTES = 32 * 1024;

/**
 * Longest `widgetId` and session token the gateway will even look at.
 *
 * A widget id is a UUID (36 chars) and a session token is a base64url payload
 * plus a 64-char hex digest (~200). Both bounds are slack, and both exist so a
 * frame under {@link WEBCHAT_MAX_FRAME_BYTES} still cannot spend 32 KB inside a
 * database query or an HMAC.
 */
export const WEBCHAT_MAX_WIDGET_ID_CHARS = 128;
export const WEBCHAT_MAX_SESSION_TOKEN_CHARS = 512;

/**
 * Concurrent sockets one caller IP may hold open on this namespace.
 *
 * `WebChatThrottle` rations *events* — init attempts, new sessions, messages —
 * which leaves the connection itself free. A client that connects and then says
 * nothing is charged nothing by any of those buckets, yet each socket costs an
 * Engine.IO session, its buffers, and an entry in Socket.IO's own maps for as
 * long as it is held. Opening them in a loop was an unrationed way to exhaust
 * the process without ever emitting an event.
 *
 * Set well above what a real caller spends — one browser tab is one socket, and
 * even a carrier-NAT'd or office-NAT'd group of visitors to one small business's
 * site stays far below this — and far below what makes holding sockets useful.
 */
export const WEBCHAT_MAX_SOCKETS_PER_IP = 50;

/** A validated `chat:init` body. */
export interface WebChatInitPayload {
  widgetId: string;
  sessionId?: string;
}

/**
 * Read a `chat:init` body, or `null` when it is not one.
 *
 * Socket.IO hands the handler whatever JSON the client sent — the global
 * `ValidationPipe` only sees HTTP routes — and the declared parameter type is a
 * compile-time fiction. Two things went wrong without this:
 *
 *  - **A non-object body** (`null`, a number, a bare string) threw on the first
 *    property read, so a malformed frame became an exception rather than a
 *    refusal.
 *  - **A non-string `widgetId` selected the tenant.** The value is passed
 *    straight to `channel_accounts.findFirst({ where: { id: widgetId } })`,
 *    and Prisma accepts a filter object there as readily as a string. A visitor
 *    sending `{"not": "00000000-0000-0000-0000-000000000000"}` therefore matched
 *    *some other business's* active web-chat account, and the handler went on to
 *    create a client row under that business's `business_id`. The widget id is
 *    the only thing standing between an anonymous socket and a tenant, so it has
 *    to be a string before it reaches a query.
 *
 * `sessionId` is dropped rather than rejected when malformed: an unusable token
 * already means "start a fresh session", and that is exactly what a missing one
 * does.
 */
export function readInitPayload(data: unknown): WebChatInitPayload | null {
  if (typeof data !== "object" || data === null) return null;

  const { widgetId, sessionId } = data as Record<string, unknown>;
  if (typeof widgetId !== "string") return null;
  if (widgetId.length === 0 || widgetId.length > WEBCHAT_MAX_WIDGET_ID_CHARS) return null;

  const token =
    typeof sessionId === "string" &&
    sessionId.length > 0 &&
    sessionId.length <= WEBCHAT_MAX_SESSION_TOKEN_CHARS
      ? sessionId
      : undefined;

  return token === undefined ? { widgetId } : { widgetId, sessionId: token };
}

/**
 * Where the web-chat widget may be embedded, from `WEBCHAT_ALLOWED_ORIGINS`
 * (comma-separated), defaulting to anywhere.
 *
 * Read from `process.env` rather than `ConfigService` because the
 * `@WebSocketGateway` decorator below is evaluated when this class is defined,
 * long before the DI container exists.
 */
export function webChatCorsOptions(
  raw = process.env["WEBCHAT_ALLOWED_ORIGINS"] ?? "*",
): { origin: string | string[]; credentials: boolean } {
  return corsOptionsFor(raw);
}

/**
 * The widget is embedded on customer sites, so unlike the REST API its default
 * allow-list genuinely is "anywhere" — but that makes `credentials: true`
 * exactly the combination browsers refuse (see `corsOptionsFor`). Pairing it
 * with the wildcard did not loosen anything; it broke every credentialed
 * handshake while still inviting every origin to attempt one. Credentials come
 * back on the moment an operator names real origins.
 */
@WebSocketGateway({
  namespace: "/webchat",
  cors: webChatCorsOptions(),
  maxHttpBufferSize: WEBCHAT_MAX_FRAME_BYTES,
})
export class WebChatGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WebChatGateway.name);

  /** Map sessionId -> Socket for routing outbound messages */
  private readonly sessions = new Map<string, Socket>();

  /** Map socket.id -> sessionId for cleanup on disconnect */
  private readonly socketToSession = new Map<string, string>();

  /** Map sessionId -> business/client/conversation context */
  private readonly sessionContext = new Map<string, SessionContext>();

  /**
   * Map socket.id -> the caller IP it was counted against.
   *
   * Recorded at connect rather than re-derived at disconnect: the count has to
   * come back down under exactly the key it went up under, and a header that
   * read differently on the way out would leak a slot per socket — turning the
   * ceiling below into a permanent lockout for that caller.
   */
  private readonly socketIp = new Map<string, string>();

  /** Live socket count per caller IP — the quantity {@link WEBCHAT_MAX_SOCKETS_PER_IP} bounds. */
  private readonly socketsPerIp = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly channelAdapterService: ChannelAdapterService,
    private readonly configService: ConfigService,
    private readonly throttle: WebChatThrottle,
    // Optional so the gateway is constructible in unit tests that do not build
    // the global module — the same shape `ChannelAdapterService` uses.
    @Optional() private readonly conversationLock?: ConversationLockService,
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
   * Give a disconnecting socket's slot back to its caller.
   *
   * The map entry is dropped once the count reaches zero, so an IP that comes
   * and goes leaves nothing resident — the key space is caller-controlled, and
   * a per-IP counter that only ever grew would be the leak the ceiling exists
   * to prevent.
   */
  private releaseConnectionSlot(socketId: string): void {
    const ip = this.socketIp.get(socketId);
    if (!ip) return;
    this.socketIp.delete(socketId);

    const live = (this.socketsPerIp.get(ip) ?? 1) - 1;
    if (live <= 0) this.socketsPerIp.delete(ip);
    else this.socketsPerIp.set(ip, live);
  }

  /** Sockets currently counted against `ip` — the ceiling's view, for tests. */
  liveSocketsFor(ip: string): number {
    return this.socketsPerIp.get(ip) ?? 0;
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

  /**
   * Become the outbox's delivery sink.
   *
   * `WebChatAdapter` writes every outbound reply into the shared buffer and has
   * no way to reach a socket; this gateway holds the sockets and has no way to
   * know a reply was written. Registering here is the join between them —
   * without it the adapter's writes accumulated in a map nothing ever read, so
   * web-chat visitors got no reply at all and the process kept every one.
   */
  onModuleInit(): void {
    setWebChatDeliverySink((sessionId) => this.flushSession(sessionId));
  }

  /**
   * Release the sink on teardown, then let go of every socket and every map
   * keyed on one.
   *
   * The sink half was already here: it is module-global state, so a gateway
   * that left itself registered would keep being called — holding this instance
   * (and every socket it maps) alive past shutdown, and, in tests, delivering
   * one suite's messages into another's mocks.
   *
   * The sockets were not. Clearing the sink stops new work reaching them but
   * leaves them connected and leaves all five maps populated, so the visitor's
   * widget sat on an open socket to a process that had stopped answering until
   * Nest tore the Engine.IO server down underneath it — a silent hang rather
   * than a disconnect. Disconnecting explicitly is what makes the widget
   * reconnect, which is how it reaches the replacement process; the buffered
   * replies are untouched in the outbox and flush on the next `chat:init`.
   *
   * Every map is then cleared. In production the process is about to exit and
   * this is hygiene; in tests it is not — the gateway is constructed per suite
   * and these maps are the state that would otherwise carry a session, its
   * businessId and its per-IP count from one test into the next.
   */
  onModuleDestroy(): void {
    setWebChatDeliverySink(null);

    for (const socket of this.sessions.values()) {
      try {
        socket.disconnect(true);
      } catch (error) {
        // An already-dead socket throwing here must not stop the rest from
        // being closed — teardown is best-effort, like every other one.
        this.logger.warn(
          "WebChat socket " + socket.id + " could not be disconnected on shutdown: " +
          (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    const closed = this.sessions.size;
    this.sessions.clear();
    this.socketToSession.clear();
    this.sessionContext.clear();
    this.socketIp.clear();
    this.socketsPerIp.clear();

    if (closed > 0) {
      this.logger.log("WebChat shutdown — disconnected " + closed + " live session(s)");
    }
  }

  /**
   * Deliver everything buffered for one session, if its socket is connected.
   *
   * Messages are removed only once emitted, so a session with no live socket
   * keeps its backlog for the reconnect (bounded by the outbox's own TTL and
   * size caps) rather than losing it here.
   *
   * @returns true when at least one message was delivered.
   */
  flushSession(sessionId: string): boolean {
    const pending = webchatResponseMap.get(sessionId);
    if (!pending || pending.length === 0) return false;

    const socket = this.sessions.get(sessionId);
    if (!socket) return false;

    let delivered = 0;
    try {
      for (const msg of pending) {
        socket.emit("chat:response", {
          messageId: msg.id,
          text: msg.text,
          timestamp: msg.timestamp.toISOString(),
        });
        delivered += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        "WebChat delivery to session " + sessionId + " failed after " + delivered +
        " message(s): " + message,
      );
    }

    // Drop exactly what went out. A partial failure leaves the rest queued for
    // the next attempt instead of replaying what the visitor already has.
    pending.splice(0, delivered);
    if (pending.length === 0) {
      webchatResponseMap.delete(sessionId);
    }

    return delivered > 0;
  }

  /**
   * Count this socket against its caller, and refuse it once that caller is
   * already holding {@link WEBCHAT_MAX_SOCKETS_PER_IP}.
   *
   * The refusal happens here, before any handler runs, because a socket that
   * never emits an event is invisible to every bucket in `WebChatThrottle` —
   * connecting *is* the cost being rationed.
   */
  handleConnection(client: Socket): void {
    const widgetId = client.handshake.query?.widgetId as string;
    const ip = this.callerIp(client);

    if (ip) {
      const live = this.socketsPerIp.get(ip) ?? 0;
      if (live >= WEBCHAT_MAX_SOCKETS_PER_IP) {
        this.logger.warn(
          "WebChat connection limit reached — refusing socket " + client.id +
          " (caller already holds " + live + ")",
        );
        client.disconnect(true);
        return;
      }
      this.socketsPerIp.set(ip, live + 1);
      this.socketIp.set(client.id, ip);
    }

    this.logger.log("WebChat client connected: " + client.id + " widgetId=" + (widgetId || "none"));
  }

  handleDisconnect(client: Socket): void {
    this.releaseConnectionSlot(client.id);

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
    @MessageBody() data: unknown,
  ): Promise<{ sessionId: string; greeting: string }> {
    // Before anything else, and before the throttle: an unusable body should
    // cost nothing and reach nothing. `widgetId` in particular decides which
    // tenant this socket ends up writing under, so it is a string here or the
    // frame is refused — see `readInitPayload`.
    const payload = readInitPayload(data);
    if (!payload) {
      this.logger.warn(
        "Rejected chat:init from socket " + client.id + " with a malformed body",
      );
      return { sessionId: "", greeting: "Widget not found" };
    }
    const widgetId = payload.widgetId;

    // Charged before the lookup below, because the lookup is itself the cost
    // being rationed: an unknown widgetId returns early, so every other ceiling
    // on this gateway is charged too late to bound a socket that only ever
    // submits junk. See the `init` rule for why this is a separate bucket from
    // `session` rather than an earlier charge against it.
    if (!this.throttle.consume("init", this.callerIp(client))) {
      this.logger.warn(
        "WebChat init rate limit reached — refusing to resolve widget " + widgetId,
      );
      return { sessionId: "", greeting: "Too many attempts. Please try again shortly." };
    }

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
    if (payload.sessionId) {
      const verified = verifyWebChatSession(payload.sessionId, secret, widgetId);
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

    // Both calls below are find-or-create: a read that misses, then a write.
    // A visitor can drive two of them at once without trying — the widget
    // reconnects on every network blip and re-inits with the same token, and a
    // second tab on the same page replays it too. Concurrently, both reads miss
    // and both write, giving one visitor two clients and two conversations and
    // splitting their history across threads the operator sees as separate
    // people. Serialize per (widget, session), the same guarantee
    // `handleInboundWebhook` takes per (channel account, sender).
    //
    // In-process only, like every other holder of this lock. The cross-process
    // half is the `(channel_account_id, external_id)` unique constraint that
    // `findOrCreateWebChatClient` now recovers from.
    const sessionKey = ConversationLockService.conversationKey(
      channel.business_id,
      `webchat:${widgetId}:${sessionId}`,
    );

    const { clientRecord, conversation } = await this.withSessionLock(
      sessionKey,
      async () => {
        const resolvedClient = await this.findOrCreateWebChatClient(
          channel.business_id,
          sessionId,
          widgetId,
        );
        const resolvedConversation = await this.findOrCreateConversation(
          channel.business_id,
          resolvedClient.id,
          widgetId,
        );
        return { clientRecord: resolvedClient, conversation: resolvedConversation };
      },
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

    // The mirror case: this socket already holds a *different* session, because
    // it inited twice without reconnecting. `socketToSession` maps one socket to
    // one session, so the line below overwrites that mapping — and the
    // disconnect that eventually follows resolves only the newer session,
    // leaving the older one (and its businessId/conversationId) in `sessions`
    // and `sessionContext` for the life of the process. Nothing bounded that:
    // resuming a session is deliberately not rate-limited, so a client replaying
    // tokens it had already been issued grew both maps without ever opening a
    // new session. Release it here — unless a newer socket has since taken it
    // over, which is the reconnect race above and has to win.
    const superseded = this.socketToSession.get(client.id);
    if (superseded && superseded !== sessionId && this.sessions.get(superseded) === client) {
      this.sessions.delete(superseded);
      this.sessionContext.delete(superseded);
      this.logger.log(
        "WebChat socket " + client.id + " re-inited as session " + sessionId +
        " — released its previous session " + superseded,
      );
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

    // A reply that landed while this visitor was between sockets is buffered,
    // and nothing else will come along to push it: the sink only fires on a new
    // send. Reconnecting is the moment it becomes deliverable.
    this.flushSession(sessionId);

    return { sessionId: sessionToken, greeting };
  }

  @SubscribeMessage("chat:message")
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: unknown,
  ): Promise<{ received: boolean; messageId: string }> {
    const messageId = generateId();
    const correlationId = generateCorrelationId();

    // The body is whatever JSON the client sent — including `null` or a bare
    // string, on which the property read below throws rather than refusing.
    if (typeof data !== "object" || data === null) {
      this.logger.warn(
        "Rejected chat:message from socket " + client.id + " with a non-object body",
      );
      return { received: false, messageId };
    }
    const text = (data as Record<string, unknown>).text;

    // `data` is parsed from a socket frame, so nothing upstream has checked
    // that `text` is even a string — the global `ValidationPipe` covers HTTP
    // routes, not Socket.IO events. A non-string reached the Prisma create and
    // the AI pipeline as-is, and an oversized one was accepted in full at
    // whatever the LLM charges for it. Reject rather than truncate: silently
    // sending the AI a different message than the visitor typed is worse than
    // telling the widget the message did not go through.
    // Trimmed, not raw. `text.length === 0` refuses `""` and accepts `"   "`,
    // and a whitespace-only turn is the same nothing wearing a costume: it is
    // stored as a blank message, dropped again by the transcript loader (which
    // filters empty turns), and in between it drives the full AI pipeline —
    // an intent classification and a generation, both billed, both reasoning
    // over an empty customer message. A widget that submits on Enter produces
    // these by accident all day.
    if (typeof text !== "string" || isBlankText(text)) {
      this.logger.warn(
        "Rejected chat:message from socket " + client.id + " with a non-string or blank body",
      );
      return { received: false, messageId };
    }
    if (text.length > WEBCHAT_MAX_MESSAGE_CHARS) {
      this.logger.warn(
        "Rejected chat:message from socket " + client.id + ": " + text.length +
        " chars exceeds the " + WEBCHAT_MAX_MESSAGE_CHARS + "-char ceiling",
      );
      return { received: false, messageId };
    }

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

      // Emit enriched message.received event with all IDs populated.
      //
      // Annotated, not inferred. This is the *second* producer of
      // `message.received` — `ChannelAdapterService` is the other, and every
      // HTTP channel goes through it — but web chat is a socket, so it builds
      // the event itself. Left as a bare object literal, a field added to
      // `MessageReceivedEvent` compiled fine here and the gateway simply
      // stopped satisfying the contract: `AiEngineService` skips an event with
      // no `conversationId`, `ConversationService` skips one with no
      // `clientId`, and either way web chat would go quiet with no error
      // anywhere. The annotation is what makes that a build failure.
      //
      // `senderPhone` is deliberately absent — a web-chat visitor has no phone
      // identity, and a session id forced into a phone field is corruption
      // rather than a fallback.
      const event: MessageReceivedEvent = {
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

  /** Run `fn` under the session lock, or directly when no lock is wired. */
  private async withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.conversationLock) return fn();
    return this.conversationLock.runExclusive(key, fn);
  }

  /**
   * Find or create a client for a webchat visitor.
   * Uses the sessionId as the external identifier.
   *
   * The client row and its contact row are written together, and a lost race is
   * recovered rather than surfaced. `channel_contacts` is unique on
   * `(channel_account_id, external_id)`, so when two inits for one session get
   * past the read the loser's contact insert raises P2002 — and because the
   * client was inserted first and separately, that used to leave an orphan
   * "Web Visitor" row behind for every collision *and* fail the visitor's init
   * with nothing to retry. The transaction makes the pair atomic (the orphan
   * rolls back with the contact), and the re-read turns the loser into the same
   * reuse path it would have taken a moment later — the pattern
   * `findOrCreateClientByIdentity` already uses for phone/email identities,
   * which a webchat visitor has neither of.
   */
  private async findOrCreateWebChatClient(
    businessId: string,
    sessionId: string,
    channelAccountId: string,
  ) {
    const existing = await this.findWebChatClient(businessId, sessionId);
    if (existing) return existing;

    const clientId = generateId();
    try {
      const client = await this.prisma.$transaction(async (tx) => {
        const created = await tx.clients.create({
          data: {
            id: clientId,
            business_id: businessId,
            name: "Web Visitor",
          },
        });

        await tx.channel_contacts.create({
          data: {
            id: generateId(),
            business_id: businessId,
            client_id: clientId,
            channel: ChannelType.WEB_CHAT,
            channel_account_id: channelAccountId,
            external_id: sessionId,
          },
        });

        return created;
      });

      this.logger.log("Created webchat client " + clientId + " for session " + sessionId);
      return client;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;

      const raced = await this.findWebChatClient(businessId, sessionId);
      // A P2002 with nothing to re-read means the violation was on some other
      // constraint. Surfacing it beats returning a client that is not there.
      if (!raced) throw err;

      this.logger.debug(
        "Reused webchat client " + raced.id + " for session " + sessionId + " after a concurrent init",
      );
      return raced;
    }
  }

  /** The client behind this webchat session, or null if the session is new. */
  private async findWebChatClient(businessId: string, sessionId: string) {
    const contact = await this.prisma.channel_contacts.findFirst({
      where: {
        business_id: businessId,
        channel: ChannelType.WEB_CHAT,
        external_id: sessionId,
      },
      include: { client: true },
    });
    return contact?.client ?? null;
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
   * Drain every session that currently has a live socket.
   *
   * Delivery is push-driven ({@link onModuleInit}) and reconnect-driven
   * ({@link handleInit}), so this is a sweep rather than the mechanism: useful
   * for an operator endpoint or a periodic safety net, and harmless to call
   * when there is nothing to do.
   */
  deliverPendingMessages(): void {
    for (const sessionId of [...webchatResponseMap.keys()]) {
      this.flushSession(sessionId);
    }
  }
}
