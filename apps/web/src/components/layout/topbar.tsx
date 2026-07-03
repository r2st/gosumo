'use client';

import { useState } from 'react';
import { ChevronDown, LogOut, Menu, Moon, Settings, Sun, User } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { NotificationCenter } from '@/components/notifications/notification-center';
import { useAuth } from '@/providers/auth-provider';
import { useTheme } from '@/providers/theme-provider';
import { cn } from '@/lib/utils';
import Link from 'next/link';

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { user, business, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-card/80 px-4 backdrop-blur lg:px-6">
      {/* Tablet-only drawer trigger. On mobile the bottom nav's "More" tab opens the sidebar,
          so the hamburger is hidden below md; on desktop the sidebar is always visible. */}
      <button onClick={onMenuClick} className="hidden rounded-md p-2 hover:bg-muted md:inline-flex lg:hidden">
        <Menu className="h-5 w-5" />
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{business?.name ?? 'GoSumo Workspace'}</p>
        {business && (
          <p className="truncate text-xs text-muted-foreground">
            {[
              business.subscriptionPlan ? `${business.subscriptionPlan} plan` : null,
              business.industry || null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Free plan'}
          </p>
        )}
      </div>

      {/* Theme toggle */}
      <ThemeToggle />

      {/* Notifications */}
      <NotificationCenter />

      {/* User menu */}
      <div className="relative">
        <button
          onClick={() => {
            setMenuOpen((v) => !v);
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

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      onClick={toggleTheme}
      className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
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
