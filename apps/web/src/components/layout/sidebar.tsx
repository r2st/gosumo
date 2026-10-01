'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { Logo } from '@/components/logo';
import { NAV_SECTIONS, NAV_TOP, type NavItem } from './nav-items';
import { useT } from '@/providers/language-provider';
import { cn } from '@/lib/utils';

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname() ?? '';
  const t = useT();

  const renderItem = (item: NavItem) => {
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onClose}
        className={cn(
          'group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
          active
            ? 'bg-accent text-primary'
            : 'text-sidebar-muted hover:bg-muted hover:text-foreground',
        )}
      >
        <Icon
          className={cn(
            'h-5 w-5 shrink-0 transition-colors',
            active ? 'text-primary' : 'text-sidebar-muted group-hover:text-foreground',
          )}
        />
        {t(item.labelKey)}
      </Link>
    );
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-5">
          <Logo />
          <button
            onClick={onClose}
            className="rounded-md p-1 text-sidebar-muted hover:bg-muted hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-3 scrollbar-thin">
          <div className="space-y-0.5">{NAV_TOP.map(renderItem)}</div>
          {NAV_SECTIONS.map((section) => (
            <div key={section.label} className="mt-5">
              <p className="mb-1 px-3 font-mono text-[10px] uppercase tracking-widest text-sidebar-muted/60">
                {t(section.labelKey)}
              </p>
              <div className="space-y-0.5">{section.items.map(renderItem)}</div>
            </div>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-4 text-xs text-sidebar-muted">
          <p className="font-heading text-sm text-sidebar-foreground">
            DoAide <span className="italic text-primary">CRM</span>
          </p>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider">AI-powered client management</p>
        </div>
      </aside>
    </>
  );
}
