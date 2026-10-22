'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components/ui/states';

// Route-segment error boundary: a render or data error on one page shows this
// recovery UI inside the existing shell instead of unmounting the whole app
// (global-error.tsx remains the last resort when the root layout itself throws).
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <div className="flex flex-col items-center gap-2">
        <ErrorState
          title="Something went wrong"
          message="An unexpected error occurred on this page. Your data is safe — try again, or head back home."
          onRetry={reset}
        />
        <a
          href="/"
          className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted"
        >
          Back to home
        </a>
      </div>
    </div>
  );
}
