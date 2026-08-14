/**
 * The two-pane inbox shell.
 *
 * The list and thread panes have their own tests; what lives only here is the
 * URL as selection state. Picking a conversation must *preserve* the filter
 * query string already in the URL rather than replace it, and closing one must
 * drop `id` without leaving a bare `?` behind — a stray one turns every shared
 * inbox link into a slightly different URL. The pane visibility is the other
 * half: on mobile the list and the thread occupy the same space, so exactly one
 * of them carries `hidden` depending on whether something is selected, and
 * getting that backwards leaves a phone user staring at a blank screen.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConvFilterState } from '@/components/conversations/conversation-list';

const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => searchParams,
}));

const onSelectRef: { current: ((id: string) => void) | null } = { current: null };
const onFiltersChangeRef: { current: ((next: ConvFilterState) => void) | null } = {
  current: null,
};
let listFilters: ConvFilterState | null = null;

vi.mock('@/components/conversations/conversation-list', () => ({
  ConversationList: ({
    filters,
    onFiltersChange,
    selectedId,
    onSelect,
  }: {
    filters: ConvFilterState;
    onFiltersChange: (next: ConvFilterState) => void;
    selectedId: string | null;
    onSelect: (id: string) => void;
  }) => {
    onSelectRef.current = onSelect;
    onFiltersChangeRef.current = onFiltersChange;
    listFilters = filters;
    return <div data-testid="conversation-list" data-selected={selectedId ?? ''} />;
  },
}));

vi.mock('@/components/conversations/conversation-thread', () => ({
  ConversationThread: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="thread">{conversationId}</div>
  ),
}));

import ConversationsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
  onSelectRef.current = null;
  onFiltersChangeRef.current = null;
  listFilters = null;
});

describe('ConversationsPage selection', () => {
  it('invites the operator to pick a thread when nothing is selected', () => {
    render(<ConversationsPage />);

    expect(screen.getByText('Select a conversation')).toBeInTheDocument();
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();
  });

  it('opens the selected thread and tells the list which row is active', () => {
    searchParams = new URLSearchParams('id=conv-42');
    render(<ConversationsPage />);

    expect(screen.getByTestId('thread')).toHaveTextContent('conv-42');
    expect(screen.getByTestId('conversation-list')).toHaveAttribute('data-selected', 'conv-42');
    expect(screen.queryByText('Select a conversation')).not.toBeInTheDocument();
  });

  it('adds the id without discarding the filters already in the URL', () => {
    searchParams = new URLSearchParams('status=OPEN&channelType=WHATSAPP');
    render(<ConversationsPage />);

    onSelectRef.current!('conv-7');

    expect(replace).toHaveBeenCalledWith('/conversations?status=OPEN&channelType=WHATSAPP&id=conv-7');
  });

  it('replaces the id when a different row is picked', () => {
    searchParams = new URLSearchParams('id=conv-1');
    render(<ConversationsPage />);

    onSelectRef.current!('conv-2');

    expect(replace).toHaveBeenCalledWith('/conversations?id=conv-2');
  });

  it('drops the id but keeps the filters when the thread is closed', () => {
    searchParams = new URLSearchParams('status=OPEN&id=conv-42');
    render(<ConversationsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Back to inbox/ }));

    expect(replace).toHaveBeenCalledWith('/conversations?status=OPEN');
  });

  it('closes to a bare path rather than a dangling question mark', () => {
    searchParams = new URLSearchParams('id=conv-42');
    render(<ConversationsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Back to inbox/ }));

    expect(replace).toHaveBeenCalledWith('/conversations');
  });
});

describe('ConversationsPage panes', () => {
  it('gives the list the full width while no thread is open', () => {
    const { container } = render(<ConversationsPage />);

    const [listPane, threadPane] = Array.from(container.firstElementChild!.children);
    expect(listPane.className).not.toContain('hidden');
    // The thread pane is the one that collapses on a phone.
    expect(threadPane.className).toContain('hidden');
  });

  it('swaps which pane collapses once a thread is open', () => {
    searchParams = new URLSearchParams('id=conv-42');
    const { container } = render(<ConversationsPage />);

    const [listPane, threadPane] = Array.from(container.firstElementChild!.children);
    expect(listPane.className).toContain('hidden');
    expect(threadPane.className).not.toContain('hidden');
  });

  it('offers the back affordance only alongside an open thread', () => {
    render(<ConversationsPage />);
    expect(screen.queryByRole('button', { name: /Back to inbox/ })).not.toBeInTheDocument();
  });
});

describe('ConversationsPage filters', () => {
  it('starts with every filter cleared', () => {
    render(<ConversationsPage />);

    expect(listFilters).toEqual({ q: '', status: '', channelType: '', assignedTo: '' });
  });

  it('holds the filter state locally instead of routing on every keystroke', () => {
    render(<ConversationsPage />);

    act(() =>
      onFiltersChangeRef.current!({
        q: 'balcony',
        status: 'OPEN',
        channelType: '',
        assignedTo: '',
      }),
    );

    expect(listFilters).toEqual({
      q: 'balcony',
      status: 'OPEN',
      channelType: '',
      assignedTo: '',
    });
    // Typing in the search box must not push a history entry per character.
    expect(replace).not.toHaveBeenCalled();
  });
});
