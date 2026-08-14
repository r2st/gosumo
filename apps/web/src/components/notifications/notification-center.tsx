'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Bell,
  CalendarPlus,
  CheckCheck,
  IndianRupee,
  Info,
  ListChecks,
  MessageSquareWarning,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/format';
import { Spinner } from '@/components/ui/states';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/hooks/use-notifications';
import type { AppNotification, NotificationType } from '@/lib/feature-types';
import { usePermissions } from '@/hooks/use-permissions';

const ICON: Record<NotificationType, LucideIcon> = {
  TASK_CREATED: ListChecks,
  TASK_ASSIGNED: ListChecks,
  CONVERSATION_ESCALATED: MessageSquareWarning,
  PAYMENT_RECEIVED: IndianRupee,
  BOOKING_CREATED: CalendarPlus,
  CHANNEL_ERROR: AlertTriangle,
  SYSTEM: Info,
};

const ICON_TONE: Record<NotificationType, string> = {
  TASK_CREATED: 'bg-accent text-primary',
  TASK_ASSIGNED: 'bg-accent text-primary',
  CONVERSATION_ESCALATED: 'bg-amber-50 text-amber-600',
  PAYMENT_RECEIVED: 'bg-emerald-50 text-emerald-600',
  BOOKING_CREATED: 'bg-sky-50 text-sky-600',
  CHANNEL_ERROR: 'bg-rose-50 text-rose-600',
  SYSTEM: 'bg-muted text-muted-foreground',
};

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data, isLoading, isError } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  // Marking notifications read is an undecorated write — STAFF and above.
  // The bell and the list stay visible to everyone.
  const { canWrite } = usePermissions();

  const unread = data?.unreadCount ?? 0;
  const items = data?.data ?? [];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 hover:bg-muted"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-danger-foreground">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-x-2 top-16 z-30 animate-fade-in overflow-hidden rounded-lg border border-border bg-card shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold">Notifications</p>
              {unread > 0 && (
                <span className="rounded-full bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-foreground">
                  {unread} new
                </span>
              )}
            </div>
            {canWrite && (
              <button
                onClick={() => markAll.mutate()}
                disabled={markAll.isPending || unread === 0}
                className="flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-40"
              >
                <CheckCheck className="h-3.5 w-3.5" /> Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto scrollbar-thin">
            {isLoading ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : isError ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                Couldn’t load notifications.
              </p>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
                <Bell className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium">You&apos;re all caught up 🎉</p>
                <p className="text-xs text-muted-foreground">New alerts will show up here.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    onToggle={
                      canWrite ? () => markRead.mutate({ id: n.id, read: !n.read }) : undefined
                    }
                  />
                ))}
              </ul>
            )}
          </div>

          <Link
            href="/settings/notifications"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-2 border-t border-border px-4 py-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <SettingsIcon className="h-3.5 w-3.5" /> Notification preferences
          </Link>
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  notification,
  onToggle,
}: {
  notification: AppNotification;
  /** Undefined for a role that cannot mark notifications read. */
  onToggle?: () => void;
}) {
  const Icon = ICON[notification.type] ?? Info;
  const body = (
    <div className="flex gap-3">
      <div
        className={cn(
          'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
          ICON_TONE[notification.type],
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{notification.title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{notification.body}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{timeAgo(notification.createdAt)}</p>
      </div>
      {!notification.read && (
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />
      )}
    </div>
  );

  return (
    <li
      className={cn(
        'px-4 py-3 transition-colors hover:bg-muted/60',
        !notification.read && 'bg-accent/30',
      )}
    >
      {notification.actionUrl ? (
        <Link href={notification.actionUrl} onClick={onToggle}>
          {body}
        </Link>
      ) : onToggle === undefined ? (
        // Nothing to click: following the row would only mark it read.
        body
      ) : (
        <button onClick={onToggle} className="w-full text-left">
          {body}
        </button>
      )}
    </li>
  );
}
