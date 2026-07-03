import {
  previewFromMessage,
  serializeConversationListItem,
  type ConversationListRow,
} from './conversation.serializer';

/* eslint-disable @typescript-eslint/no-explicit-any */

function baseRow(overrides: Partial<ConversationListRow> = {}): ConversationListRow {
  const now = new Date('2026-06-27T10:00:00.000Z');
  return {
    id: 'conv-1',
    business_id: 'biz-1',
    client_id: 'client-1',
    channel_account_id: 'chan-1',
    channel: 'WHATSAPP',
    status: 'OPEN',
    current_intent: null,
    intent_confidence: null,
    current_topic: null,
    assigned_to: null,
    subject: null,
    external_thread_id: null,
    first_message_at: now,
    last_message_at: now,
    resolved_at: null,
    snoozed_until: null,
    message_count: 1,
    unread_count: 2,
    human_message_count: 0,
    csat_score: null,
    csat_submitted_at: null,
    tags: [],
    metadata: {},
    created_at: now,
    updated_at: now,
    deleted_at: null,
    client: null,
    messages: [],
    ...overrides,
  } as unknown as ConversationListRow;
}

function message(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'msg-1',
    type: 'TEXT',
    content: { type: 'TEXT', text: 'Hello there' },
    text_content: 'Hello there',
    ...overrides,
  };
}

describe('previewFromMessage', () => {
  it('returns undefined when there is no message', () => {
    expect(previewFromMessage(undefined)).toBeUndefined();
    expect(previewFromMessage(null)).toBeUndefined();
  });

  it('prefers the denormalized text_content column', () => {
    expect(previewFromMessage(message({ text_content: 'From column' }))).toBe('From column');
  });

  it('falls back to content.text when text_content is empty', () => {
    expect(
      previewFromMessage(message({ text_content: null, content: { type: 'TEXT', text: 'From content' } })),
    ).toBe('From content');
  });

  it('handles content stored as a plain {text} object with no type', () => {
    expect(
      previewFromMessage(message({ text_content: null, content: { text: 'Plain text' } })),
    ).toBe('Plain text');
  });

  it('produces a [type] tag for non-text media messages', () => {
    expect(
      previewFromMessage(message({ text_content: null, type: 'IMAGE', content: { type: 'IMAGE', url: 'x' } })),
    ).toBe('[image]');
  });
});

describe('serializeConversationListItem', () => {
  it('maps a conversation to the dashboard contract with a last-message preview', () => {
    const row = baseRow({
      messages: [message({ text_content: 'Latest message' })] as any,
      client: {
        id: 'client-1',
        name: 'Asha Verma',
        phone: '+919999999999',
        email: 'asha@example.com',
        avatar_url: 'https://cdn/avatar.png',
      } as any,
    });

    const dto = serializeConversationListItem(row);

    expect(dto.id).toBe('conv-1');
    expect(dto.channelType).toBe('WHATSAPP');
    expect(dto.unreadCount).toBe(2);
    expect(dto.lastMessageAt).toBe('2026-06-27T10:00:00.000Z');
    expect(dto.lastMessagePreview).toBe('Latest message');
    expect(dto.aiHandling).toBe(true);
    expect(dto.client).toEqual({
      id: 'client-1',
      name: 'Asha Verma',
      phone: '+919999999999',
      email: 'asha@example.com',
      avatarUrl: 'https://cdn/avatar.png',
      tags: [],
    });
  });

  it('leaves the preview undefined when the conversation has no messages', () => {
    const dto = serializeConversationListItem(baseRow({ messages: [] }));
    expect(dto.lastMessagePreview).toBeUndefined();
  });

  it('marks a conversation with a human assignee as not AI-handled', () => {
    const dto = serializeConversationListItem(baseRow({ assigned_to: 'agent-7' }));
    expect(dto.aiHandling).toBe(false);
    expect(dto.assignedTo).toBe('agent-7');
  });
});
