/**
 * ConversationThread — the operator's main working surface.
 *
 * Covers the states an operator actually lands in (loading, error, empty,
 * populated), the day grouping that makes a long thread readable, the reply
 * box's send semantics, the status controls, and the hand-off to the HITL
 * draft panel. Everything that mutates a conversation is gated on STAFF+, so
 * each control is asserted in both directions.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Conversation, HitlTask, Message } from '@/lib/types';
import type { Role } from '@/lib/feature-types';
import { ApiError } from '@/lib/api-client';

let currentRole: Role | null = 'STAFF';

const authValue = () => ({
  status: 'authenticated' as const,
  user: currentRole
    ? {
        id: 'u1',
        email: 'me@acme.in',
        name: 'Me',
        role: currentRole,
        businessId: 'b1',
        twoFactorEnabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }
    : null,
  business: null,
});

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => authValue(),
  useOptionalAuth: () => authValue(),
}));

// ── Query/mutation doubles ──────────────────────────────────────────────────

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    businessId: 'b1',
    clientId: 'cl1',
    channelType: 'WHATSAPP',
    channelAccountId: 'acct1',
    status: 'OPEN',
    aiHandling: false,
    unreadCount: 0,
    lastMessageAt: '2026-08-14T04:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-14T04:00:00.000Z',
    client: { id: 'cl1', name: 'Priya Sharma', phone: '+919999900001' },
    ...overrides,
  } as Conversation;
}

function makeMessage(id: string, timestamp: string, text: string): Message {
  return {
    id,
    conversationId: 'c1',
    businessId: 'b1',
    direction: 'INBOUND',
    contentType: 'TEXT',
    content: { type: 'TEXT', text },
    status: 'DELIVERED',
    sentByAi: false,
    timestamp,
    metadata: {},
  } as unknown as Message;
}

const state = {
  conv: {
    data: makeConversation() as Conversation | undefined,
    isLoading: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
  messages: {
    data: { data: [] as Message[] },
    isLoading: false,
  },
  send: { mutate: vi.fn(), isPending: false, isError: false, error: null as Error | null },
  resolve: { mutate: vi.fn(), isPending: false },
  escalate: { mutate: vi.fn(), isPending: false },
  update: { mutate: vi.fn(), isPending: false },
  markRead: { mutate: vi.fn(), isPending: false },
};

vi.mock('@/hooks/use-queries', () => ({
  useConversation: () => state.conv,
  useMessages: () => state.messages,
  useSendMessage: () => state.send,
  useResolveConversation: () => state.resolve,
  useEscalateConversation: () => state.escalate,
  useUpdateConversation: () => state.update,
  useMarkConversationRead: () => state.markRead,
  // The nested AiDraftPanel pulls these.
  useApproveTask: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
  useRejectTask: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}));

const { ConversationThread } = await import('./conversation-thread');

beforeEach(() => {
  currentRole = 'STAFF';
  state.conv = {
    data: makeConversation(),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
  state.messages = { data: { data: [] }, isLoading: false };
  state.send = { mutate: vi.fn(), isPending: false, isError: false, error: null };
  state.resolve = { mutate: vi.fn(), isPending: false };
  state.escalate = { mutate: vi.fn(), isPending: false };
  state.update = { mutate: vi.fn(), isPending: false };
  state.markRead = { mutate: vi.fn(), isPending: false };
  // jsdom has no layout, so the auto-scroll effect needs a stub.
  Element.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConversationThread — load states', () => {
  it('shows a loading state while the conversation resolves', () => {
    state.conv.isLoading = true;
    render(<ConversationThread conversationId="c1" />);
    expect(screen.getByText('Loading conversation…')).toBeInTheDocument();
  });

  it('shows an error state with a retry when the conversation fails', () => {
    state.conv.isError = true;
    state.conv.error = new Error('Conversation not found');
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByText('Conversation not found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(state.conv.refetch).toHaveBeenCalled();
  });

  it('treats a successful-but-empty response as an error rather than a blank thread', () => {
    state.conv.data = undefined;
    render(<ConversationThread conversationId="c1" />);
    expect(screen.queryByPlaceholderText(/Type a reply/)).not.toBeInTheDocument();
  });

  it('shows a loading state for the messages while the header is already up', () => {
    state.messages.isLoading = true;
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Loading messages…')).toBeInTheDocument();
  });

  it('says the thread is empty when there are no messages', () => {
    render(<ConversationThread conversationId="c1" />);
    expect(screen.getByText('No messages in this conversation yet.')).toBeInTheDocument();
  });
});

describe('ConversationThread — header', () => {
  it('shows the client, channel and status', () => {
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText(/\+919999900001/)).toBeInTheDocument();
  });

  it('falls back to "Unknown client" when the client did not expand', () => {
    state.conv.data = makeConversation({ client: undefined });
    render(<ConversationThread conversationId="c1" />);
    expect(screen.getByText('Unknown client')).toBeInTheDocument();
  });

  it('flags a conversation the AI is currently driving', () => {
    state.conv.data = makeConversation({ aiHandling: true });
    render(<ConversationThread conversationId="c1" />);
    expect(screen.getByText('AI handling')).toBeInTheDocument();
  });

  it('does not claim AI handling on a human-run conversation', () => {
    render(<ConversationThread conversationId="c1" />);
    expect(screen.queryByText('AI handling')).not.toBeInTheDocument();
  });
});

describe('ConversationThread — message grouping', () => {
  it('renders one day divider per IST calendar day, not per message', () => {
    // 04:00 and 10:00 UTC are the same IST day; 20:00 UTC is the next one
    // (IST is UTC+5:30), which is exactly the boundary a naive UTC grouping
    // would get wrong for Indian operators.
    state.messages.data = {
      data: [
        makeMessage('m1', '2026-08-10T04:00:00.000Z', 'first'),
        makeMessage('m2', '2026-08-10T10:00:00.000Z', 'second'),
        makeMessage('m3', '2026-08-10T20:00:00.000Z', 'third'),
      ],
    };
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('third')).toBeInTheDocument();
    // Two IST days across the three messages: 10 Aug (04:00, 10:00 UTC) and
    // 11 Aug (20:00 UTC = 01:30 IST the next morning).
    expect(screen.getAllByText(/Aug 2026|Today|Yesterday/)).toHaveLength(2);
  });

  it('renders every message in the thread', () => {
    state.messages.data = {
      data: [
        makeMessage('m1', '2026-08-10T04:00:00.000Z', 'kal 3 baje available hai?'),
        makeMessage('m2', '2026-08-10T04:05:00.000Z', 'haan bilkul'),
      ],
    };
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByText('kal 3 baje available hai?')).toBeInTheDocument();
    expect(screen.getByText('haan bilkul')).toBeInTheDocument();
  });
});

describe('ConversationThread — reply box', () => {
  it('sends on Enter and clears the box on success', () => {
    state.send.mutate = vi.fn((_text, opts) => opts?.onSuccess?.());
    render(<ConversationThread conversationId="c1" />);

    const box = screen.getByPlaceholderText(/Type a reply/);
    fireEvent.change(box, { target: { value: 'ji bilkul' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(state.send.mutate).toHaveBeenCalledWith('ji bilkul', expect.anything());
    expect((box as HTMLTextAreaElement).value).toBe('');
  });

  it('inserts a newline on Shift+Enter instead of sending', () => {
    render(<ConversationThread conversationId="c1" />);

    const box = screen.getByPlaceholderText(/Type a reply/);
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });

    expect(state.send.mutate).not.toHaveBeenCalled();
  });

  it('refuses to send whitespace', () => {
    render(<ConversationThread conversationId="c1" />);

    const box = screen.getByPlaceholderText(/Type a reply/);
    fireEvent.change(box, { target: { value: '    ' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(state.send.mutate).not.toHaveBeenCalled();
  });

  it('trims the message before sending', () => {
    render(<ConversationThread conversationId="c1" />);

    const box = screen.getByPlaceholderText(/Type a reply/);
    fireEvent.change(box, { target: { value: '  namaste  ' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(state.send.mutate).toHaveBeenCalledWith('namaste', expect.anything());
  });

  it('keeps the typed text when the send fails', () => {
    // Clearing on failure would lose the operator's reply with nothing sent.
    state.send.mutate = vi.fn();
    render(<ConversationThread conversationId="c1" />);

    const box = screen.getByPlaceholderText(/Type a reply/);
    fireEvent.change(box, { target: { value: 'important reply' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect((box as HTMLTextAreaElement).value).toBe('important reply');
  });

  it('surfaces a send failure', () => {
    state.send.isError = true;
    state.send.error = new Error('Outside the 24h WhatsApp window');
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByText('Outside the 24h WhatsApp window')).toBeInTheDocument();
  });

  it('translates a transport-level send failure instead of showing its raw text', () => {
    state.send.isError = true;
    state.send.error = new ApiError(0, 'NETWORK_ERROR', 'Unable to reach the DoAide Desk API. Is it running?');
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByText(/Check your internet connection/)).toBeInTheDocument();
    expect(screen.queryByText(/Is it running/)).not.toBeInTheDocument();
  });

  it('offers a retry that re-sends the reply still sitting in the box', () => {
    state.send.isError = true;
    state.send.error = new Error('Gateway rejected the message');
    render(<ConversationThread conversationId="c1" />);

    const box = screen.getByPlaceholderText(/Type a reply/);
    fireEvent.change(box, { target: { value: 'important reply' } });
    fireEvent.click(screen.getByRole('button', { name: /retry send/i }));

    expect(state.send.mutate).toHaveBeenCalledWith('important reply', expect.anything());
  });

  it('disables the retry when the box is empty, so it cannot send a blank message', () => {
    state.send.isError = true;
    state.send.error = new Error('Gateway rejected the message');
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByRole('button', { name: /retry send/i })).toBeDisabled();
  });

  it('offers no retry control while the send is succeeding', () => {
    render(<ConversationThread conversationId="c1" />);
    expect(screen.queryByRole('button', { name: /retry send/i })).not.toBeInTheDocument();
  });

  it('fills the box from a quick reply', () => {
    render(<ConversationThread conversationId="c1" />);

    fireEvent.click(screen.getByRole('button', { name: /Could you share a few more details/ }));

    expect((screen.getByPlaceholderText(/Type a reply/) as HTMLTextAreaElement).value).toBe(
      'Could you share a few more details?',
    );
  });

  it('unescapes the HTML entity in a quick reply before inserting it', () => {
    // The literal source carries &apos; — an operator must never see it.
    render(<ConversationThread conversationId="c1" />);

    fireEvent.click(screen.getByRole('button', { name: /Your request is being processed/ }));

    const value = (screen.getByPlaceholderText(/Type a reply/) as HTMLTextAreaElement).value;
    expect(value).toContain("We'll update you shortly");
    expect(value).not.toContain('&apos;');
  });
});

describe('ConversationThread — status controls', () => {
  it('resolves an open conversation', () => {
    render(<ConversationThread conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: /Resolve/ }));
    expect(state.resolve.mutate).toHaveBeenCalledWith({ id: 'c1' });
  });

  it('offers Reopen instead of Resolve once resolved', () => {
    state.conv.data = makeConversation({ status: 'RESOLVED' });
    render(<ConversationThread conversationId="c1" />);

    expect(screen.queryByRole('button', { name: /Resolve/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reopen/ }));
    expect(state.update.mutate).toHaveBeenCalledWith({ id: 'c1', status: 'OPEN' });
  });

  it('snoozes to PENDING', () => {
    render(<ConversationThread conversationId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: /Snooze/ }));
    expect(state.update.mutate).toHaveBeenCalledWith({ id: 'c1', status: 'PENDING' });
  });

  it('cannot snooze an already-resolved conversation', () => {
    state.conv.data = makeConversation({ status: 'RESOLVED' });
    render(<ConversationThread conversationId="c1" />);
    expect(screen.getByRole('button', { name: /Snooze/ })).toBeDisabled();
  });

  it('escalates with the reason the operator typed', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Customer threatening to cancel');
    render(<ConversationThread conversationId="c1" />);

    fireEvent.click(screen.getByRole('button', { name: /Escalate/ }));

    expect(state.escalate.mutate).toHaveBeenCalledWith({
      id: 'c1',
      reason: 'Customer threatening to cancel',
      priority: 'HIGH',
    });
  });

  it('does not escalate when the reason prompt is cancelled', () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null);
    render(<ConversationThread conversationId="c1" />);

    fireEvent.click(screen.getByRole('button', { name: /Escalate/ }));

    expect(state.escalate.mutate).not.toHaveBeenCalled();
  });

  it('does not escalate on a blank reason', () => {
    // An escalation with no reason is useless to whoever picks it up.
    vi.spyOn(window, 'prompt').mockReturnValue('   ');
    render(<ConversationThread conversationId="c1" />);

    fireEvent.click(screen.getByRole('button', { name: /Escalate/ }));

    expect(state.escalate.mutate).not.toHaveBeenCalled();
  });
});

describe('ConversationThread — AI draft hand-off', () => {
  const pendingDraft = {
    id: 'task-1',
    businessId: 'b1',
    conversationId: 'c1',
    type: 'DRAFT_REVIEW',
    status: 'PENDING',
    priority: 'MEDIUM',
    title: 'Booking request',
    description: '',
    aiDraft: 'Kal 3 baje confirm hai!',
    aiConfidence: 82,
    createdAt: '2026-08-14T04:00:00.000Z',
    updatedAt: '2026-08-14T04:00:00.000Z',
  } as HitlTask;

  it('shows the review panel for a pending draft task', () => {
    state.conv.data = { ...makeConversation(), tasks: [pendingDraft] } as Conversation;
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByText('AI draft awaiting review')).toBeInTheDocument();
    expect(screen.getByText('82% confidence')).toBeInTheDocument();
  });

  it('hides the panel once the task is resolved', () => {
    state.conv.data = {
      ...makeConversation(),
      tasks: [{ ...pendingDraft, status: 'RESOLVED' }],
    } as Conversation;
    render(<ConversationThread conversationId="c1" />);

    expect(screen.queryByText('AI draft awaiting review')).not.toBeInTheDocument();
  });

  it('ignores a pending task of another type', () => {
    // An ESCALATION task is not a draft; rendering the approve/send card for
    // one would offer to send a message that does not exist.
    state.conv.data = {
      ...makeConversation(),
      tasks: [{ ...pendingDraft, type: 'ESCALATION' }],
    } as Conversation;
    render(<ConversationThread conversationId="c1" />);

    expect(screen.queryByText('AI draft awaiting review')).not.toBeInTheDocument();
  });

  it('renders normally when the conversation carries no tasks', () => {
    render(<ConversationThread conversationId="c1" />);
    expect(screen.queryByText('AI draft awaiting review')).not.toBeInTheDocument();
  });
});

describe('ConversationThread — role gating', () => {
  it('gives a VIEWER a readable thread with no write controls', () => {
    currentRole = 'VIEWER';
    state.messages.data = { data: [makeMessage('m1', '2026-08-10T04:00:00.000Z', 'hello')] };
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();

    expect(screen.queryByPlaceholderText(/Type a reply/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resolve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Escalate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Snooze/ })).not.toBeInTheDocument();
  });

  it('gives STAFF the full control set', () => {
    render(<ConversationThread conversationId="c1" />);

    expect(screen.getByPlaceholderText(/Type a reply/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resolve/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Escalate/ })).toBeInTheDocument();
  });
});

describe('ConversationThread — mark read', () => {
  it('clears the unread badge when the thread is opened', () => {
    render(<ConversationThread conversationId="c1" />);

    expect(state.markRead.mutate).toHaveBeenCalledWith('c1');
  });

  it('clears it again when a message arrives while the thread is open', () => {
    const { rerender } = render(<ConversationThread conversationId="c1" />);
    expect(state.markRead.mutate).toHaveBeenCalledTimes(1);

    state.messages.data = { data: [makeMessage('m1', '2026-08-10T04:00:00.000Z', 'hello')] };
    rerender(<ConversationThread conversationId="c1" />);

    // The operator is looking at the thread, so the new message is read on
    // arrival rather than badging a conversation already on screen.
    expect(state.markRead.mutate).toHaveBeenCalledTimes(2);
  });

  it('does not re-fire on an unrelated re-render', () => {
    const { rerender } = render(<ConversationThread conversationId="c1" />);
    rerender(<ConversationThread conversationId="c1" />);

    expect(state.markRead.mutate).toHaveBeenCalledTimes(1);
  });

  it('marks the newly opened thread when the operator switches conversations', () => {
    const { rerender } = render(<ConversationThread conversationId="c1" />);
    rerender(<ConversationThread conversationId="c2" />);

    expect(state.markRead.mutate).toHaveBeenNthCalledWith(2, 'c2');
  });

  it('does not call it for a VIEWER', () => {
    // A VIEWER is read-only across the API; firing this would only collect
    // 403s, and the badge is shared team state rather than a per-viewer flag.
    currentRole = 'VIEWER';
    render(<ConversationThread conversationId="c1" />);

    expect(state.markRead.mutate).not.toHaveBeenCalled();
  });
});
