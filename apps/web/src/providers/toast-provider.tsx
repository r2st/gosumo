'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  /** Optional bold heading shown above the message. */
  title?: string;
  /** Milliseconds before auto-dismiss. Defaults to 4000. Pass 0 to keep it until dismissed. */
  duration?: number;
}

interface Toast {
  id: number;
  variant: ToastVariant;
  title?: string;
  message: string;
  duration: number;
}

interface ToastContextValue {
  show: (variant: ToastVariant, message: string, opts?: ToastOptions) => number;
  success: (message: string, opts?: ToastOptions) => number;
  error: (message: string, opts?: ToastOptions) => number;
  warning: (message: string, opts?: ToastOptions) => number;
  info: (message: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION = 4000;

const VARIANT_STYLES: Record<
  ToastVariant,
  { icon: typeof CheckCircle2; iconClass: string; barClass: string }
> = {
  success: { icon: CheckCircle2, iconClass: 'text-success', barClass: 'bg-success' },
  error: { icon: XCircle, iconClass: 'text-danger', barClass: 'bg-danger' },
  warning: { icon: AlertTriangle, iconClass: 'text-warning', barClass: 'bg-warning' },
  info: { icon: Info, iconClass: 'text-primary', barClass: 'bg-primary' },
};

/**
 * Global toast host. Wrap the app once (see root layout) and read it from any
 * client component via {@link useToast}. Toasts render into a fixed stack in
 * the bottom-right corner, auto-dismiss after 4s, and can be dismissed manually.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const nextId = useRef(1);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const active = timers.current;
    return () => {
      active.forEach((t) => clearTimeout(t));
      active.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (variant: ToastVariant, message: string, opts?: ToastOptions) => {
      const id = nextId.current++;
      const duration = opts?.duration ?? DEFAULT_DURATION;
      setToasts((prev) => [...prev, { id, variant, message, title: opts?.title, duration }]);
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      success: (message, opts) => show('success', message, opts),
      error: (message, opts) => show('error', message, opts),
      warning: (message, opts) => show('warning', message, opts),
      info: (message, opts) => show('info', message, opts),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted &&
        createPortal(
          <div
            aria-live="polite"
            aria-atomic="false"
            className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-end gap-2.5 p-4 sm:inset-x-auto sm:right-0 sm:max-w-sm"
          >
            {toasts.map((toast) => (
              <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { icon: Icon, iconClass, barClass } = VARIANT_STYLES[toast.variant];
  return (
    <div
      role="status"
      className={cn(
        'pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border border-border bg-card py-3 pl-4 pr-3 shadow-lg',
        'animate-toast-in',
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-1', barClass)} aria-hidden />
      <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', iconClass)} aria-hidden />
      <div className="min-w-0 flex-1">
        {toast.title && (
          <p className="text-sm font-semibold leading-tight text-card-foreground">{toast.title}</p>
        )}
        <p
          className={cn(
            'text-sm text-muted-foreground',
            toast.title ? 'mt-0.5' : 'font-medium text-card-foreground',
          )}
        >
          {toast.message}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="-mr-1 mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

/** Access the global toast dispatcher. Must be called under {@link ToastProvider}. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
