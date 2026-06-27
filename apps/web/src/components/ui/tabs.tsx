'use client';

import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TabItem {
  key: string;
  label: string;
  href?: string;
  icon?: LucideIcon;
}

/** Link-based tabs for routed sub-pages. */
export function LinkTabs({ items, activeKey }: { items: TabItem[]; activeKey: string }) {
  return (
    <nav className="flex gap-1 overflow-x-auto scrollbar-thin">
      {items.map((item) => {
        const active = item.key === activeKey;
        const Icon = item.icon;
        return (
          <Link
            key={item.key}
            href={item.href ?? '#'}
            className={cn(
              'flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="h-4 w-4" />}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Segmented button tabs for in-page state switching. */
export function SegmentedTabs({
  items,
  activeKey,
  onChange,
}: {
  items: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-border bg-card p-0.5">
      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
