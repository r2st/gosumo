'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, LayoutDashboard, Menu, MessagesSquare, Target, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BottomTab {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Marks the "More" tab, which opens the full sidebar instead of navigating. */
  isMore?: boolean;
}

const TABS: BottomTab[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Leads', href: '/leads', icon: Target },
  { label: 'Chats', href: '/conversations', icon: MessagesSquare },
  { label: 'Inventory', href: '/inventory', icon: Building2 },
  { label: 'More', href: '#more', icon: Menu, isMore: true },
];

/**
 * Fixed bottom tab bar shown only on mobile (below the `md` breakpoint). It gives
 * one-tap access to the five most-used destinations; the "More" tab opens the full
 * sidebar so every other route stays reachable.
 */
export function BottomNav({ onMore }: { onMore: () => void }) {
  const pathname = usePathname() ?? '';

  const isActive = (tab: BottomTab) =>
    !tab.isMore && (pathname === tab.href || pathname.startsWith(`${tab.href}/`));

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-stretch border-t border-border bg-card/95 backdrop-blur md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map((tab) => {
        const active = isActive(tab);
        const Icon = tab.icon;
        const content = (
          <>
            <Icon className={cn('h-5 w-5', active ? 'text-primary' : 'text-muted-foreground')} />
            <span className={cn('text-[10px] font-medium', active ? 'text-primary' : 'text-muted-foreground')}>
              {tab.label}
            </span>
          </>
        );
        const className = cn(
          'flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors',
          active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
        );

        if (tab.isMore) {
          return (
            <button key={tab.href} type="button" onClick={onMore} className={className} aria-label="Open menu">
              {content}
            </button>
          );
        }

        return (
          <Link key={tab.href} href={tab.href} aria-current={active ? 'page' : undefined} className={className}>
            {content}
          </Link>
        );
      })}
    </nav>
  );
}
