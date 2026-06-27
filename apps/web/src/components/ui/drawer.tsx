'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Right-side slide-over panel for record detail views. Mirrors the Modal API
 * (open/onClose/title/footer) but anchors to the right edge and is wider, which
 * suits the order / booking / payment detail surfaces.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 flex h-full w-full max-w-xl animate-fade-in flex-col border-l border-border bg-card shadow-xl',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border p-5">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="truncate text-base font-semibold tracking-tight">{title}</h2>
            {description && <p className="truncate text-sm text-muted-foreground">{description}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border p-5 pt-4">{footer}</div>}
      </div>
    </div>
  );
}
