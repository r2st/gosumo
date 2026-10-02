'use client';

import { ErrorState } from '@/components/ui/states';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <ErrorState error={error} onRetry={reset} />
    </div>
  );
}
