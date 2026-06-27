import { NotificationTemplateChannel } from '@prisma/client';

/**
 * Fully-resolved, channel-specific payload handed to a {@link ChannelSender}.
 * The body has already been rendered from its template — senders never see
 * `{{ variables }}`.
 */
export interface OutboundNotification {
  /** GoSumo notification id (for logging / provider idempotency keys). */
  notificationId: string;
  businessId: string;
  /** Resolved destination: E.164 phone, email address, or device token. */
  recipient: string;
  /** Email subject / push title — null for SMS. */
  subject: string | null;
  /** Rendered plain-text body — present for every channel. */
  text: string;
  /** Rendered HTML body — email only. */
  html: string | null;
  /** WhatsApp approved-template name, when sending a template message. */
  externalTemplateName: string | null;
  /** Template variables, used by WhatsApp approved templates as ordered params. */
  data: Record<string, unknown>;
}

/**
 * Result of a single provider send attempt.
 */
export interface SendOutcome {
  success: boolean;
  /** Provider-assigned message id (wamid, SMS gateway id, FCM id, …). */
  providerMessageId?: string;
  /** Human-readable failure reason when `success` is false. */
  error?: string;
  /**
   * Whether the failure is worth retrying. Transient errors (timeouts, 5xx,
   * provider rate limits) are retryable; permanent ones (invalid recipient,
   * unapproved template) are not and should fail fast.
   */
  retryable?: boolean;
}

/**
 * ChannelSender — the contract every concrete channel transport implements.
 *
 * A sender is the notification module's equivalent of the channel-adapter's
 * `ChannelAdapter`: it is the only place that speaks a specific provider's
 * protocol. The {@link NotificationService} stays provider-agnostic and routes
 * through the registry by {@link NotificationTemplateChannel}.
 */
export interface ChannelSender {
  readonly channel: NotificationTemplateChannel;

  /**
   * Validate that `recipient` is a well-formed address for this channel.
   * Returns null when valid, or an error string describing why it isn't.
   */
  validateRecipient(recipient: string): string | null;

  /** Deliver the notification to the provider. Must never throw — wrap errors in SendOutcome. */
  send(payload: OutboundNotification): Promise<SendOutcome>;
}
