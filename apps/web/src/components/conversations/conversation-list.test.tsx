/**
 * ConversationList — the operator's inbox rail.
 *
 * Covers the four load states, the three filter selects and the search box
 * (all of which feed the query key, so a wrong mapping silently returns the
 * wrong inbox), row rendering, and selection. The filter assertions check that
 * blank values are sent as `undefined` rather than empty strings — an empty
 * string would serialise into the query and filter the list down to nothing.
 */
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Conversation } from '@/lib/types';
import type { ConvFilterState } from './conversation-list';

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
    lastMessagePreview: 'Is the 2BHK still available?',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-14T04:00:00.000Z',
    client: { id: 'cl1', name: 'Priya Sharma' },
    ...overrides,
  } as Conversation;
}

const state = {
  conversations: {
    data: { data: [makeConversation()] as Conversation[] } as
      | { data: Conversation[] }
      | undefined,
    isLoading: false,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
};

/** Every filter object the list has asked for, in call order. */
let filterCalls: Record<string, unknown>[] = [];

vi.mock('@/hooks/use-queries', () => ({
  useConversations: (filters: Record<string, unknown>) => {
    filterCalls.push(filters);
    return state.conversations;
  },
}));

const { ConversationList } = await import('./conversation-list');

const BLANK: ConvFilterState = { q: '', status: '', channelType: '', assignedTo: '' };

/** Render with controlled filters that actually update, like the page does. */
function renderList(
  overrides: {
    filters?: Partial<ConvFilterState>;
    selectedId?: string | null;
    onSelect?: (id: string) => void;
  } = {},
) {
  const onSelect = overrides.onSelect ?? vi.fn();
  const initial: ConvFilterState = { ...BLANK, ...overrides.filters };

  function Harness() {
    const [f, setF] = useState<ConvFilterState>(initial);
    return (
      <ConversationList
        filters={f}
        onFiltersChange={setF}
        selectedId={overrides.selectedId ?? null}
        onSelect={onSelect}
      />
    );
  }

  const utils = render(<Harness />);
  return { ...utils, onSelect };
}

beforeEach(() => {
  filterCalls = [];
  state.conversations = {
    data: { data: [makeConversation()] },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ConversationList — load states', () => {
  it('shows a list-shaped skeleton while the inbox resolves', () => {
    state.conversations.isLoading = true;
    renderList();
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading conversations…');
  });

  it('shows the error message and retries on demand', () => {
    state.conversations.isError = true;
    state.conversations.error = new Error('Inbox unavailable');
    renderList();

    expect(screen.getByText('Inbox unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(state.conversations.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when no conversation matches', () => {
    state.conversations.data = { data: [] };
    renderList();
    expect(screen.getByText('No conversations')).toBeInTheDocument();
  });

  it('treats a missing payload as empty rather than crashing on data.data', () => {
    state.conversations.data = undefined;
    renderList();
    expect(screen.getByText('No conversations')).toBeInTheDocument();
  });

  it('keeps the filter bar visible in every state, so a bad filter is recoverable', () => {
    state.conversations.isError = true;
    state.conversations.error = new Error('boom');
    renderList();
    expect(screen.getByPlaceholderText(/Search conversations/)).toBeInTheDocument();
  });
});

describe('ConversationList — rows', () => {
  it('shows the client name, preview and unread count', () => {
    state.conversations.data = { data: [makeConversation({ unreadCount: 4 })] };
    renderList();

    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Is the 2BHK still available?')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('hides the unread pill at zero rather than rendering a "0" badge', () => {
    renderList();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('falls back to "Unknown" when the client did not expand', () => {
    state.conversations.data = { data: [makeConversation({ client: undefined })] };
    renderList();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('says so when a conversation has no preview yet', () => {
    state.conversations.data = { data: [makeConversation({ lastMessagePreview: undefined })] };
    renderList();
    expect(screen.getByText('No messages')).toBeInTheDocument();
  });

  it('renders one row per conversation', () => {
    state.conversations.data = {
      data: [
        makeConversation({ id: 'c1', client: { id: 'cl1', name: 'Priya' } as never }),
        makeConversation({ id: 'c2', client: { id: 'cl2', name: 'Rahul' } as never }),
        makeConversation({ id: 'c3', client: { id: 'cl3', name: 'Anita' } as never }),
      ],
    };
    renderList();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('calls onSelect with the conversation id when a row is clicked', () => {
    const onSelect = vi.fn();
    renderList({ onSelect });

    fireEvent.click(screen.getByRole('button', { name: /Priya Sharma/ }));
    expect(onSelect).toHaveBeenCalledWith('c1');
  });

  it('marks the selected row as active and leaves the others alone', () => {
    state.conversations.data = {
      data: [
        makeConversation({ id: 'c1', client: { id: 'cl1', name: 'Priya' } as never }),
        makeConversation({ id: 'c2', client: { id: 'cl2', name: 'Rahul' } as never }),
      ],
    };
    renderList({ selectedId: 'c2' });

    const [first, second] = screen.getAllByRole('button');
    expect(first.className).not.toContain('bg-accent');
    expect(second.className).toContain('bg-accent');
  });
});

describe('ConversationList — filters', () => {
  it('always requests the client expansion and a 50-row page', () => {
    renderList();
    expect(filterCalls[0]).toMatchObject({ include: 'client', limit: 50 });
  });

  it('sends blank filters as undefined, not empty strings', () => {
    renderList();
    expect(filterCalls[0]).toMatchObject({
      q: undefined,
      status: undefined,
      channelType: undefined,
      assignedTo: undefined,
    });
  });

  it('passes the search text through as `q`', () => {
    renderList();
    fireEvent.change(screen.getByPlaceholderText(/Search conversations/), {
      target: { value: 'invoice' },
    });
    expect(filterCalls.at(-1)).toMatchObject({ q: 'invoice' });
  });

  it('reverts `q` to undefined when the search box is cleared', () => {
    renderList();
    const box = screen.getByPlaceholderText(/Search conversations/);

    fireEvent.change(box, { target: { value: 'invoice' } });
    fireEvent.change(box, { target: { value: '' } });
    expect(filterCalls.at(-1)).toMatchObject({ q: undefined });
  });

  it('maps each status option onto the status filter', () => {
    renderList();
    const select = screen.getAllByRole('combobox')[0];

    for (const status of ['OPEN', 'PENDING', 'ESCALATED', 'BOT_HANDLING', 'RESOLVED']) {
      fireEvent.change(select, { target: { value: status } });
      expect(filterCalls.at(-1)).toMatchObject({ status });
    }
  });

  it('maps each channel option onto the channel filter', () => {
    renderList();
    const select = screen.getAllByRole('combobox')[1];

    for (const channel of ['WHATSAPP', 'INSTAGRAM', 'SMS', 'WEB_CHAT', 'EMAIL']) {
      fireEvent.change(select, { target: { value: channel } });
      expect(filterCalls.at(-1)).toMatchObject({ channelType: channel });
    }
  });

  it('maps the assignee options onto the assignedTo filter', () => {
    renderList();
    const select = screen.getAllByRole('combobox')[2];

    fireEvent.change(select, { target: { value: 'me' } });
    expect(filterCalls.at(-1)).toMatchObject({ assignedTo: 'me' });

    fireEvent.change(select, { target: { value: 'unassigned' } });
    expect(filterCalls.at(-1)).toMatchObject({ assignedTo: 'unassigned' });
  });

  it('combines filters instead of replacing them', () => {
    renderList();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'OPEN' } });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'WHATSAPP' } });
    fireEvent.change(screen.getByPlaceholderText(/Search conversations/), {
      target: { value: 'deposit' },
    });

    expect(filterCalls.at(-1)).toMatchObject({
      status: 'OPEN',
      channelType: 'WHATSAPP',
      q: 'deposit',
    });
  });

  it('offers "all" escapes on every select', () => {
    renderList();
    expect(screen.getByRole('option', { name: 'All statuses' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All channels' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Anyone' })).toBeInTheDocument();
  });
});
