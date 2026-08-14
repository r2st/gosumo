/**
 * ConversationController.list() unit tests.
 *
 * This is the dashboard inbox's entry point, and it is the one place that
 * re-shapes the service's paginated result into the REST envelope the web app
 * reads. The nullish fallbacks on the pagination block exist because the
 * service layer's paginated shape is only partially populated on some code
 * paths — a missing `total` must render as 0, not as `null` in the JSON.
 */

import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import type { ConversationListRow } from './conversation.serializer';

/* eslint-disable @typescript-eslint/no-explicit-any */

const TENANT_ID = '00000000-0000-4000-a000-000000000001';
const USER_ID = '00000000-0000-4000-a000-000000000002';

function row(overrides: Partial<ConversationListRow> = {}): ConversationListRow {
  const now = new Date('2026-06-27T10:00:00.000Z');
  return {
    id: 'conv-1',
    business_id: TENANT_ID,
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

describe('ConversationController.list', () => {
  let controller: ConversationController;
  let service: { listConversations: jest.Mock };

  beforeEach(() => {
    service = { listConversations: jest.fn() };
    controller = new ConversationController(service as unknown as ConversationService);
  });

  it('serializes each row and threads the caller through as the viewer', async () => {
    service.listConversations.mockResolvedValue({
      data: [row({ id: 'conv-1' }), row({ id: 'conv-2', assigned_to: 'agent-9' })],
      total: 2,
      limit: 20,
      page: 1,
      totalPages: 1,
    });

    const result = await controller.list(TENANT_ID, USER_ID, {} as any);

    expect(service.listConversations).toHaveBeenCalledWith(TENANT_ID, {}, USER_ID);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({ id: 'conv-1', aiHandling: true });
    expect(result.data[1]).toMatchObject({ id: 'conv-2', assignedTo: 'agent-9', aiHandling: false });
    expect(result.pagination).toEqual({ total: 2, limit: 20, page: 1, totalPages: 1 });
  });

  it('substitutes pagination defaults when the service omits the counters', async () => {
    service.listConversations.mockResolvedValue({ data: [] });

    const result = await controller.list(TENANT_ID, USER_ID, {} as any);

    // Nullish — not falsy — fallbacks: the dashboard needs numbers here.
    expect(result.data).toEqual([]);
    expect(result.pagination).toEqual({ total: 0, limit: 20, page: 1, totalPages: 0 });
  });

  it('keeps a genuine zero page/total rather than replacing it with the default', async () => {
    service.listConversations.mockResolvedValue({
      data: [],
      total: 0,
      limit: 0,
      page: 0,
      totalPages: 0,
    });

    const result = await controller.list(TENANT_ID, USER_ID, {} as any);

    expect(result.pagination).toEqual({ total: 0, limit: 0, page: 0, totalPages: 0 });
  });

  it('passes the query filters through untouched', async () => {
    service.listConversations.mockResolvedValue({ data: [], total: 0, limit: 5, page: 2, totalPages: 0 });

    const query = { status: 'OPEN', channel: 'WHATSAPP', page: 2, limit: 5 } as any;
    await controller.list(TENANT_ID, USER_ID, query);

    expect(service.listConversations).toHaveBeenCalledWith(TENANT_ID, query, USER_ID);
  });
});
