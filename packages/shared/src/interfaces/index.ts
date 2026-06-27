import {
  ChannelType,
  MessageDirection,
  MessageContentType,
  MessageStatus,
  ConversationStatus,
  IntentType,
  ConfidenceMode,
} from '../enums';

// ─────────────────────────────────────────────
// MESSAGE CONTENT (discriminated union)
// ─────────────────────────────────────────────

export type MessageContent =
  | {
      type: MessageContentType.TEXT;
      text: string;
    }
  | {
      type: MessageContentType.IMAGE;
      url: string;
      caption?: string;
      mimeType: string;
      width?: number;
      height?: number;
      fileSizeBytes?: number;
    }
  | {
      type: MessageContentType.DOCUMENT;
      url: string;
      filename: string;
      mimeType: string;
      fileSizeBytes?: number;
    }
  | {
      type: MessageContentType.LOCATION;
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
    }
  | {
      type: MessageContentType.INTERACTIVE;
      interactiveType: string;
      payload: Record<string, unknown>;
    }
  | {
      type: MessageContentType.PAYMENT_LINK;
      url: string;
      /** Amount in paise */
      amount: number;
      currency: string;
      expiresAt?: Date;
    }
  | {
      type: MessageContentType.TEMPLATE;
      templateName: string;
      /** ISO 639-1 language code, e.g. "en", "hi" */
      language: string;
      parameters: Record<string, string>;
    };

// ─────────────────────────────────────────────
// NORMALIZED MESSAGE
// ─────────────────────────────────────────────

/**
 * Channel-agnostic internal message format.
 * Every channel adapter translates its raw payload into this shape
 * before emitting a `message.received` event.
 */
export interface NormalizedMessage {
  /** GoSumo internal ID (UUID v4) */
  id: string;
  /** Channel-assigned message ID (for deduplication and status callbacks) */
  externalId: string;
  channel: ChannelType;
  /** ID of the business's account on this channel (FK to channel_accounts) */
  channelAccountId: string;
  direction: MessageDirection;
  sender: {
    /** Phone number, IG user ID, email address, etc. */
    externalId: string;
    displayName?: string;
  };
  content: MessageContent;
  timestamp: Date;
  /** Raw channel-specific extras (signature headers, story context, etc.) */
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────
// CHANNEL CAPABILITIES
// ─────────────────────────────────────────────

/**
 * Declares what a channel supports so the AI engine can choose
 * the most appropriate response type.
 */
export interface ChannelCapabilities {
  channelType: ChannelType;
  supportsTemplates: boolean;
  supportsInteractiveMessages: boolean;
  supportsMedia: boolean;
  supportsVoice: boolean;
  supportsReactions: boolean;
  supportsReadReceipts: boolean;
  supportsPaymentLinks: boolean;
  maxMessageLength: number;
}

// ─────────────────────────────────────────────
// OUTBOUND MESSAGE
// ─────────────────────────────────────────────

/**
 * Payload the action executor sends to a channel adapter when
 * it wants to deliver a message to a client.
 */
export interface OutboundMessage {
  /** ID of the business's channel account to send from */
  channelAccountId: string;
  /** Channel-specific recipient identifier (phone number, IG user ID, etc.) */
  recipientExternalId: string;
  content: MessageContent;
  /** Set when this outbound message is in reply to an inbound one */
  replyToExternalId?: string;
  /** BullMQ job correlation for tracing */
  correlationId?: string;
}

// ─────────────────────────────────────────────
// CONFIDENCE SCORE
// ─────────────────────────────────────────────

/**
 * Breakdown of how the AI calculated its confidence score.
 * Formula: (dataAvailability × 0.5) + (policyClarity × 0.5)
 */
export interface ConfidenceScore {
  /** 0.0–1.0: how complete is the data needed to respond (catalog, client history, etc.) */
  dataAvailability: number;
  /** 0.0–1.0: how unambiguous are the business rules for this situation */
  policyClarity: number;
  /** Composite score after applying overrides */
  finalScore: number;
  /** Mode determined by the final score */
  mode: ConfidenceMode;
  /** Any hard overrides that forced the score down */
  overrides: ConfidenceOverride[];
}

export interface ConfidenceOverride {
  /** Machine-readable override key */
  code: string;
  /** Human-readable reason */
  reason: string;
  /** Score penalty applied (0.0–1.0, subtracted from composite) */
  penalty: number;
}

// ─────────────────────────────────────────────
// AI RESPONSE
// ─────────────────────────────────────────────

/**
 * Structured output returned by the AI engine after processing
 * an inbound message. Consumed by the routing engine.
 */
export interface AIResponse {
  /** The message text to send to the client (may be null for action-only responses) */
  responseText: string | null;
  confidenceScore: ConfidenceScore;
  intent: IntentType;
  /** Chain-of-thought reasoning from the LLM (for audit and precedent logging) */
  reasoning: string;
  /** Concrete actions the system should take (e.g. create_order, send_payment_link) */
  suggestedActions: SuggestedAction[];
  /** Profile fields the AI wants to update based on this interaction */
  profileUpdates: Record<string, unknown>;
  /** Model version used */
  modelId: string;
  /** Token usage for cost tracking */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** End-to-end latency from message received to response generated (ms) */
  latencyMs: number;
}

export interface SuggestedAction {
  /** Unique action type understood by the action executor */
  type: string;
  /** Action-specific parameters */
  parameters: Record<string, unknown>;
  /** Relative confidence in this specific action (0.0–1.0) */
  confidence: number;
}

// ─────────────────────────────────────────────
// API PRIMITIVES
// ─────────────────────────────────────────────

/**
 * Cursor-based paginated response for any list endpoint.
 */
export interface PaginatedResponse<T> {
  items: T[];
  /** Opaque cursor to pass as `after` in the next request */
  cursor: string | null;
  hasMore: boolean;
  /** Total count of records matching the filter (omitted when expensive) */
  total?: number;
}

/**
 * Standardised error shape returned by all API endpoints.
 * Mirrors the NestJS exception filter output.
 */
export interface ApiError {
  /** HTTP status code */
  statusCode: number;
  /** Human-readable error message */
  message: string;
  /** Machine-readable error code for client-side handling */
  code: string;
  /** Correlation ID for log tracing */
  traceId: string;
  /** ISO-8601 timestamp of when the error occurred */
  timestamp: string;
  /** Validation error details (present on 422 responses) */
  errors?: Record<string, string[]>;
}

// ─────────────────────────────────────────────
// CHANNEL ADAPTER CONTRACT
// ─────────────────────────────────────────────

export interface RawRequest {
  headers: Record<string, string>;
  body: unknown;
  rawBody?: Buffer;
  query?: Record<string, string>;
}

export interface SendResult {
  success: boolean;
  externalMessageId?: string;
  error?: string;
  sentAt?: Date;
}

export interface TemplateMessage {
  channelAccountId: string;
  recipientExternalId: string;
  templateName: string;
  language: string;
  parameters: Record<string, string>;
  correlationId?: string;
}

export interface InteractiveMessage {
  channelAccountId: string;
  recipientExternalId: string;
  interactiveType: string;
  header?: Record<string, unknown>;
  body: string;
  footer?: string;
  action: Record<string, unknown>;
  correlationId?: string;
}

export interface ChannelAdapter {
  readonly channelType: ChannelType;

  validateWebhook(req: RawRequest): boolean;
  parseInbound(req: RawRequest): NormalizedMessage;

  sendMessage(message: OutboundMessage): Promise<SendResult>;
  sendTemplate(template: TemplateMessage): Promise<SendResult>;
  sendInteractive(interactive: InteractiveMessage): Promise<SendResult>;

  getCapabilities(): ChannelCapabilities;

  downloadMedia(mediaId: string): Promise<Buffer>;
  uploadMedia(buffer: Buffer, mimeType: string): Promise<string>;
}
