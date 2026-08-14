import { Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { friendlyError, isRetryable } from '@/lib/errors';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-muted-foreground', className)} />;
}

export function LoadingState({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-16 text-muted-foreground', className)}>
      <Spinner className="h-6 w-6" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-16 text-center', className)}>
      {Icon && (
        <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
      )}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  error,
  onRetry,
  className,
}: {
  title?: string;
  /**
   * Explicit copy describing what failed to load, e.g. "Could not load
   * approvals." Used as the fallback when {@link error} carries nothing more
   * specific, and shown verbatim when no `error` is passed.
   */
  message?: string;
  /**
   * The thrown value from the query. Preferred over `message`: it produces
   * cause-specific, actionable copy (offline vs. expired session vs. no
   * permission) instead of one generic sentence for every failure.
   */
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const body = error !== undefined ? friendlyError(error, message) : message;
  // Retrying a 403 or 404 cannot succeed — don't offer a button that misleads.
  const showRetry = Boolean(onRetry) && (error === undefined || isRetryable(error));

  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-16 text-center', className)}>
      <h3 className="text-sm font-semibold text-danger">{title}</h3>
      {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
      {showRetry && (
        <button
          onClick={onRetry}
          className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Try again
        </button>
      )}
    </div>
  );
}
