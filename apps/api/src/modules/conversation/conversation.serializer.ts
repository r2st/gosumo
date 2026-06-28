import type { clients, conversations, messages } from '@prisma/client';

/**
 * A conversation row as loaded for the list endpoint: includes the related
 * client and (at most) the single most recent message used to build the
 * preview line shown in the dashboard inbox.
 */
export type ConversationListRow = conversations & {
  client?: clients | null;
  messages?: messages[];
};

/** The client summary shape the dashboard expects (camelCase REST contract). */
export interface ClientSummaryDto {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  avatarUrl?: string;
  tags: string[];
}

/** A conversation as returned to the dashboard list view. */
export interface ConversationListItemDto {
  id: string;
  businessId: string;
  clientId: string;
  channelId: string;
  channelType: string;
  externalThreadId?: string;
  status: string;
  subject?: string;
  assignedTo?: string;
  aiHandling: boolean;
  lastMessageAt?: string;
  lastMessagePreview?: string;
  unreadCount: number;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  client?: ClientSummaryDto;
}

/**
 * Derive the short preview text shown under each conversation in the inbox.
 *
 * Prefers the denormalized `text_content` column, falls back to a `text` field
 * inside the polymorphic `content` payload, and finally to a `[type]` tag for
 * non-text messages (e.g. `[image]`). Returns undefined when there is no
 * last message so the UI can show its own empty state.
 */
export function previewFromMessage(message: messages | undefined | null): string | undefined {
  if (!message) return undefined;
  if (message.text_content) return message.text_content;

  const content = message.content as Record<string, unknown> | null;
  const text = content && typeof content.text === 'string' ? content.text : undefined;
  if (text) return text;

  const type = content && typeof content.type === 'string' ? content.type : message.type;
  return type ? `[${String(type).toLowerCase()}]` : undefined;
}

function toClientSummary(client: clients | null | undefined): ClientSummaryDto | undefined {
  if (!client) return undefined;
  return {
    id: client.id,
    name: client.name ?? 'Unknown',
    phone: client.phone ?? undefined,
    email: client.email ?? undefined,
    avatarUrl: client.avatar_url ?? undefined,
    tags: [],
  };
}

/**
 * Map a raw conversation row (with relations) into the camelCase REST contract
 * the dashboard inbox consumes, including the `lastMessagePreview` derived from
 * the most recent message.
 */
export function serializeConversationListItem(row: ConversationListRow): ConversationListItemDto {
  const lastMessage = row.messages?.[0];

  return {
    id: row.id,
    businessId: row.business_id,
    clientId: row.client_id,
    channelId: row.channel_account_id,
    channelType: row.channel,
    externalThreadId: row.external_thread_id ?? undefined,
    status: row.status,
    subject: row.subject ?? undefined,
    assignedTo: row.assigned_to ?? undefined,
    // No dedicated column — a conversation with no human assignee is AI-handled.
    aiHandling: row.assigned_to == null,
    lastMessageAt: row.last_message_at?.toISOString(),
    lastMessagePreview: previewFromMessage(lastMessage),
    unreadCount: row.unread_count,
    tags: row.tags ?? [],
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString(),
    client: toClientSummary(row.client),
  };
}
