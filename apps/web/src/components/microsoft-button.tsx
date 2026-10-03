'use client';

import { api } from '@/lib/api-client';

export function MicrosoftButton({ label = 'Continue with Microsoft' }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        window.location.href = api.auth.microsoftUrl();
      }}
      className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border bg-card text-sm font-medium shadow-sm transition-colors hover:bg-muted"
    >
      <svg className="h-4 w-4" viewBox="0 0 23 23" aria-hidden>
        <rect x="1" y="1" width="10" height="10" fill="#f25022" />
        <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
        <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
        <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
      </svg>
      {label}
    </button>
  );
}
