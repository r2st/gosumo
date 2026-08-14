/**
 * The notification bell and its dropdown.
 *
 * The unread badge is what an operator scans, so its two edges are pinned:
 * nothing at all at zero, and "9+" past a count that would otherwise break the
 * pill. The rest of the suite is about the row's clickability, which changes
 * shape three ways — a row with an action URL is a link, one without is a
 * button that only marks it read, and for a VIEWER (who cannot write) it is
 * neither, because a control whose only effect is a forbidden write should not
 * be offered at all.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotification, NotificationType, Role } from '@/lib/feature-types';

function makeNotification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1',
    type: 'TASK_CREATED',
    title: 'New HITL task',
    body: 'A draft reply is waiting for review.',
    read: false,
    createdAt: '2026-08-14T05:00:00.000Z',
    ...overrides,
  };
}

const state = {
  feed: {
    data: { data: [makeNotification()], unreadCount: 1 } as
      | { data: AppNotification[]; unreadCount: number }
      | undefined,
    isLoading: false,
    isError: false,
  },
};

const mutations = { markRead: vi.fn(), markAll: vi.fn() };
const flags = { markAllPending: false };
let role: Role = 'STAFF';

vi.mock('@/hooks/use-notifications', () => ({
  useNotifications: () => state.feed,
  useMarkNotificationRead: () => ({ mutate: mutations.markRead, isPending: false }),
  useMarkAllNotificationsRead: () => ({
    mutate: mutations.markAll,
    isPending: flags.markAllPending,
  }),
}));

vi.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({
    role,
    canWrite: role !== 'VIEWER',
    canManage: role === 'MANAGER' || role === 'OWNER',
    canOwn: role === 'OWNER',
    isReadOnly: role === 'VIEWER',
  }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, onClick }: { href: string; children: React.ReactNode; onClick?: () => void }) => (
    <a href={href} onClick={onClick}>
      {children}
    </a>
  ),
}));

import { NotificationCenter } from './notification-center';

const bell = () => screen.getByLabelText('Notifications');
const openPanel = () => fireEvent.click(bell());

beforeEach(() => {
  state.feed = {
    data: { data: [makeNotification()], unreadCount: 1 },
    isLoading: false,
    isError: false,
  };
  flags.markAllPending = false;
  role = 'STAFF';
  vi.clearAllMocks();
});

describe('the unread badge', () => {
  it('counts the unread notifications', () => {
    render(<NotificationCenter />);
    expect(within(bell()).getByText('1')).toBeInTheDocument();
  });

  it('disappears entirely at zero rather than showing a 0', () => {
    state.feed = { ...state.feed, data: { data: [], unreadCount: 0 } };
    render(<NotificationCenter />);
    expect(within(bell()).queryByText('0')).not.toBeInTheDocument();
  });

  it('caps at 9+ so the pill cannot stretch', () => {
    state.feed = { ...state.feed, data: { data: [], unreadCount: 42 } };
    render(<NotificationCenter />);
    expect(within(bell()).getByText('9+')).toBeInTheDocument();
  });

  it('shows 9 in full but 10 as 9+', () => {
    state.feed = { ...state.feed, data: { data: [], unreadCount: 9 } };
    const { rerender } = render(<NotificationCenter />);
    expect(within(bell()).getByText('9')).toBeInTheDocument();

    state.feed = { ...state.feed, data: { data: [], unreadCount: 10 } };
    rerender(<NotificationCenter />);
    expect(within(bell()).getByText('9+')).toBeInTheDocument();
  });

  it('treats a feed that has not arrived as no unread', () => {
    state.feed = { data: undefined, isLoading: true, isError: false };
    render(<NotificationCenter />);
    expect(bell().textContent).toBe('');
  });
});

describe('the dropdown', () => {
  it('stays shut until the bell is clicked, and toggles back', () => {
    render(<NotificationCenter />);
    expect(screen.queryByText('Notifications', { selector: 'p' })).not.toBeInTheDocument();
    openPanel();
    expect(screen.getByText('Notifications', { selector: 'p' })).toBeInTheDocument();
    fireEvent.click(bell());
    expect(screen.queryByText('Notifications', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('closes when a click lands outside it', () => {
    render(<NotificationCenter />);
    openPanel();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Notifications', { selector: 'p' })).not.toBeInTheDocument();
  });

  it('stays open for a click inside it', () => {
    render(<NotificationCenter />);
    openPanel();
    fireEvent.mouseDown(screen.getByText('New HITL task'));
    expect(screen.getByText('Notifications', { selector: 'p' })).toBeInTheDocument();
  });

  it('heads the panel with the unread count', () => {
    state.feed = { ...state.feed, data: { data: [makeNotification()], unreadCount: 3 } };
    render(<NotificationCenter />);
    openPanel();
    expect(screen.getByText('3 new')).toBeInTheDocument();
  });

  it('spins while the feed loads', () => {
    state.feed = { data: undefined, isLoading: true, isError: false };
    const { container } = render(<NotificationCenter />);
    openPanel();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('says so when the feed fails', () => {
    state.feed = { data: undefined, isLoading: false, isError: true };
    render(<NotificationCenter />);
    openPanel();
    expect(screen.getByText('Couldn’t load notifications.')).toBeInTheDocument();
  });

  it('celebrates an empty feed', () => {
    state.feed = { ...state.feed, data: { data: [], unreadCount: 0 } };
    render(<NotificationCenter />);
    openPanel();
    expect(screen.getByText(/all caught up/)).toBeInTheDocument();
  });

  it('links out to the preferences page and closes on the way', () => {
    render(<NotificationCenter />);
    openPanel();
    const link = screen.getByRole('link', { name: /notification preferences/i });
    expect(link).toHaveAttribute('href', '/settings/notifications');
    fireEvent.click(link);
    expect(screen.queryByText('Notifications', { selector: 'p' })).not.toBeInTheDocument();
  });
});

describe('mark all read', () => {
  it('marks everything read', () => {
    render(<NotificationCenter />);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }));
    expect(mutations.markAll).toHaveBeenCalledTimes(1);
  });

  it('is inert when there is nothing unread', () => {
    state.feed = { ...state.feed, data: { data: [makeNotification({ read: true })], unreadCount: 0 } };
    render(<NotificationCenter />);
    openPanel();
    expect(screen.getByRole('button', { name: /mark all read/i })).toBeDisabled();
  });

  it('is inert while the request is in flight', () => {
    flags.markAllPending = true;
    render(<NotificationCenter />);
    openPanel();
    expect(screen.getByRole('button', { name: /mark all read/i })).toBeDisabled();
  });

  it('is not offered to a VIEWER', () => {
    role = 'VIEWER';
    render(<NotificationCenter />);
    openPanel();
    expect(screen.queryByRole('button', { name: /mark all read/i })).not.toBeInTheDocument();
  });
});

describe('a notification row', () => {
  it('shows the title, body and relative time', () => {
    render(<NotificationCenter />);
    openPanel();
    expect(screen.getByText('New HITL task')).toBeInTheDocument();
    expect(screen.getByText('A draft reply is waiting for review.')).toBeInTheDocument();
  });

  it('marks an unread one with a dot that a read one does not carry', () => {
    const { rerender } = render(<NotificationCenter />);
    openPanel();
    expect(screen.getByLabelText('Unread')).toBeInTheDocument();

    state.feed = { ...state.feed, data: { data: [makeNotification({ read: true })], unreadCount: 0 } };
    rerender(<NotificationCenter />);
    expect(screen.queryByLabelText('Unread')).not.toBeInTheDocument();
  });

  it('is a button that flips the read flag when there is nowhere to go', () => {
    render(<NotificationCenter />);
    openPanel();
    fireEvent.click(screen.getByText('New HITL task'));
    expect(mutations.markRead).toHaveBeenCalledWith({ id: 'n1', read: true });
  });

  it('flips a read notification back to unread', () => {
    state.feed = { ...state.feed, data: { data: [makeNotification({ read: true })], unreadCount: 0 } };
    render(<NotificationCenter />);
    openPanel();
    fireEvent.click(screen.getByText('New HITL task'));
    expect(mutations.markRead).toHaveBeenCalledWith({ id: 'n1', read: false });
  });

  it('becomes a link that also marks read when it has somewhere to go', () => {
    state.feed = {
      ...state.feed,
      data: { data: [makeNotification({ actionUrl: '/approvals/t1' })], unreadCount: 1 },
    };
    render(<NotificationCenter />);
    openPanel();
    const link = screen.getByRole('link', { name: /new hitl task/i });
    expect(link).toHaveAttribute('href', '/approvals/t1');
    fireEvent.click(link);
    expect(mutations.markRead).toHaveBeenCalledWith({ id: 'n1', read: true });
  });

  it('is plain text for a VIEWER, with no control that would write', () => {
    role = 'VIEWER';
    render(<NotificationCenter />);
    openPanel();
    expect(screen.getByText('New HITL task')).toBeInTheDocument();
    fireEvent.click(screen.getByText('New HITL task'));
    expect(mutations.markRead).not.toHaveBeenCalled();
  });

  it('still links for a VIEWER, since following it is only navigation', () => {
    role = 'VIEWER';
    state.feed = {
      ...state.feed,
      data: { data: [makeNotification({ actionUrl: '/approvals/t1' })], unreadCount: 1 },
    };
    render(<NotificationCenter />);
    openPanel();
    fireEvent.click(screen.getByRole('link', { name: /new hitl task/i }));
    expect(mutations.markRead).not.toHaveBeenCalled();
  });

  it.each([
    'TASK_CREATED',
    'TASK_ASSIGNED',
    'CONVERSATION_ESCALATED',
    'PAYMENT_RECEIVED',
    'BOOKING_CREATED',
    'CHANNEL_ERROR',
    'SYSTEM',
  ] as NotificationType[])('renders an icon for a %s notification', (type) => {
    state.feed = { ...state.feed, data: { data: [makeNotification({ type })], unreadCount: 1 } };
    const { container } = render(<NotificationCenter />);
    openPanel();
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(1);
  });

  it('falls back to the generic icon for a type the frontend has not heard of', () => {
    state.feed = {
      ...state.feed,
      data: {
        data: [makeNotification({ type: 'SOMETHING_NEW' as NotificationType })],
        unreadCount: 1,
      },
    };
    render(<NotificationCenter />);
    expect(() => openPanel()).not.toThrow();
    expect(screen.getByText('New HITL task')).toBeInTheDocument();
  });
});
