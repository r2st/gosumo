'use client';

import { useState } from 'react';
import { Bell, ChevronDown, LogOut, Menu, Settings, User } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/providers/auth-provider';
import { useHitlTasks } from '@/hooks/use-queries';
import { cn } from '@/lib/utils';
import Link from 'next/link';

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { user, business, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  // Pending HITL tasks drive the notification bell badge.
  const { data: tasks } = useHitlTasks({ status: 'PENDING', limit: 5 });
  const pendingCount = tasks?.pagination.total ?? 0;

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-card/80 px-4 backdrop-blur lg:px-6">
      <button onClick={onMenuClick} className="rounded-md p-2 hover:bg-muted lg:hidden">
        <Menu className="h-5 w-5" />
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{business?.name ?? 'GoSumo Workspace'}</p>
        {business && (
          <p className="truncate text-xs text-muted-foreground">
            {business.subscriptionPlan} plan · {business.industry}
          </p>
        )}
      </div>

      {/* Notifications */}
      <div className="relative">
        <button
          onClick={() => {
            setNotifOpen((v) => !v);
            setMenuOpen(false);
          }}
          className="relative rounded-md p-2 hover:bg-muted"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
          {pendingCount > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-danger-foreground">
              {pendingCount > 9 ? '9+' : pendingCount}
            </span>
          )}
        </button>

        {notifOpen && (
          <DropdownPanel onClose={() => setNotifOpen(false)}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <p className="text-sm font-semibold">Notifications</p>
              {pendingCount > 0 && <Badge tone="danger">{pendingCount} pending</Badge>}
            </div>
            <div className="max-h-80 overflow-y-auto scrollbar-thin">
              {tasks && tasks.data.length > 0 ? (
                tasks.data.map((task) => (
                  <Link
                    key={task.id}
                    href={`/conversations?task=${task.id}`}
                    onClick={() => setNotifOpen(false)}
                    className="block border-b border-border px-4 py-3 last:border-0 hover:bg-muted"
                  >
                    <p className="text-sm font-medium">{task.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
                  </Link>
                ))
              ) : (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">You&apos;re all caught up 🎉</p>
              )}
            </div>
          </DropdownPanel>
        )}
      </div>

      {/* User menu */}
      <div className="relative">
        <button
          onClick={() => {
            setMenuOpen((v) => !v);
            setNotifOpen(false);
          }}
          className="flex items-center gap-2 rounded-md p-1 pr-2 hover:bg-muted"
        >
          <Avatar name={user?.name ?? 'User'} src={user?.avatarUrl} size="sm" />
          <span className="hidden text-sm font-medium sm:block">{user?.name ?? 'User'}</span>
          <ChevronDown className="hidden h-4 w-4 text-muted-foreground sm:block" />
        </button>

        {menuOpen && (
          <DropdownPanel onClose={() => setMenuOpen(false)} className="w-56">
            <div className="border-b border-border px-4 py-3">
              <p className="truncate text-sm font-medium">{user?.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
              {user && <Badge tone="primary" className="mt-2">{user.role}</Badge>}
            </div>
            <div className="p-1">
              <MenuLink href="/settings" icon={User} label="Profile" onClick={() => setMenuOpen(false)} />
              <MenuLink href="/settings" icon={Settings} label="Settings" onClick={() => setMenuOpen(false)} />
              <button
                onClick={() => {
                  setMenuOpen(false);
                  void logout();
                }}
                className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-danger hover:bg-muted"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          </DropdownPanel>
        )}
      </div>
    </header>
  );
}

function MenuLink({
  href,
  icon: Icon,
  label,
  onClick,
}: {
  href: string;
  icon: typeof User;
  label: string;
  onClick: () => void;
}) {
  return (
    <Link href={href} onClick={onClick} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted">
      <Icon className="h-4 w-4 text-muted-foreground" /> {label}
    </Link>
  );
}

function DropdownPanel({
  children,
  onClose,
  className,
}: {
  children: React.ReactNode;
  onClose: () => void;
  className?: string;
}) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} aria-hidden />
      <div
        className={cn(
          'absolute right-0 top-full z-20 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-card shadow-lg animate-fade-in',
          className,
        )}
      >
        {children}
      </div>
    </>
  );
}
