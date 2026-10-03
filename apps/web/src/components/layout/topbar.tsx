'use client';

import { useState } from 'react';
import { ChevronDown, Languages, LogOut, Menu, Monitor, Moon, Settings, Sun, User } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { NotificationCenter } from '@/components/notifications/notification-center';
import { useAuth } from '@/providers/auth-provider';
import { useLanguage } from '@/providers/language-provider';
import { useTheme, type Theme } from '@/providers/theme-provider';
import { UI_LANGUAGE_LABELS } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import Link from 'next/link';

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { user, business, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur lg:px-6">
      <button onClick={onMenuClick} className="hidden rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground md:inline-flex lg:hidden">
        <Menu className="h-5 w-5" />
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">{business?.name ?? 'DoAide Desk Workspace'}</p>
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

      <ThemeToggle />

      <LanguageToggle />

      <NotificationCenter />

      <div className="relative">
        <button
          onClick={() => {
            setMenuOpen((v) => !v);
          }}
          className="flex items-center gap-2 rounded-md p-1 pr-2 text-foreground hover:bg-muted"
        >
          <Avatar name={user?.name ?? 'User'} src={user?.avatarUrl} size="sm" />
          <span className="hidden text-sm font-medium sm:block">{user?.name ?? 'User'}</span>
          <ChevronDown className="hidden h-4 w-4 text-muted-foreground sm:block" />
        </button>

        {menuOpen && (
          <DropdownPanel onClose={() => setMenuOpen(false)} className="w-56">
            <div className="border-b border-border px-4 py-3">
              <p className="truncate text-sm font-medium text-foreground">{user?.name}</p>
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

const THEME_ICON: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };
const THEME_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const Icon = THEME_ICON[theme];
  const order: Theme[] = ['light', 'dark', 'system'];
  const nextIdx = (order.indexOf(theme) + 1) % order.length;
  const next = order[nextIdx];
  return (
    <button
      onClick={toggleTheme}
      className="flex h-9 items-center gap-1 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Switch to ${THEME_LABEL[next]} theme`}
      title={`${THEME_LABEL[theme]} theme — click for ${THEME_LABEL[next]}`}
    >
      <Icon className="h-4 w-4" />
      <span className="hidden sm:inline">{THEME_LABEL[theme]}</span>
    </button>
  );
}

function LanguageToggle() {
  const { lang, setLang } = useLanguage();
  const next = lang === 'en' ? 'hi' : 'en';
  return (
    <button
      onClick={() => setLang(next)}
      className="flex h-9 items-center gap-1 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Switch to ${UI_LANGUAGE_LABELS[next]}`}
      title={`Switch to ${UI_LANGUAGE_LABELS[next]}`}
    >
      <Languages className="h-4 w-4" />
      <span>{UI_LANGUAGE_LABELS[lang]}</span>
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
    <Link href={href} onClick={onClick} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground hover:bg-muted">
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
