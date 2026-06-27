'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { tokenStore } from '@/lib/token-store';
import { useAuth } from '@/providers/auth-provider';

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refreshProfile } = useAuth();
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const accessToken = searchParams.get('accessToken');
    const refreshToken = searchParams.get('refreshToken');

    if (accessToken && refreshToken) {
      tokenStore.setAccessToken(accessToken);
      tokenStore.setRefreshToken(refreshToken);

      // Hydrate AuthProvider state so DashboardShell sees 'authenticated'
      // before the client-side navigation fires.
      refreshProfile()
        .then(() => {
          router.replace('/dashboard');
        })
        .catch(() => {
          // refreshProfile failed (e.g. token already expired) — fall back to
          // a hard navigation which forces AuthProvider to re-initialise from
          // the refresh token we just persisted to localStorage.
          window.location.replace('/dashboard');
        });
    } else {
      router.replace('/login?error=google_auth_failed');
    }
  }, [searchParams, router, refreshProfile]);

  return (
    <div className="text-center">
      <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
      <p className="text-muted-foreground">Completing sign in...</p>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Suspense fallback={
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      }>
        <CallbackHandler />
      </Suspense>
    </div>
  );
}
