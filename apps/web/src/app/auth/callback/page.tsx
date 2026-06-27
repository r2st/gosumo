'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { tokenStore } from '@/lib/token-store';

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const accessToken = searchParams.get('accessToken');
    const refreshToken = searchParams.get('refreshToken');

    if (accessToken && refreshToken) {
      tokenStore.setAccessToken(accessToken);
      tokenStore.setRefreshToken(refreshToken);
      router.replace('/dashboard');
    } else {
      router.replace('/login?error=google_auth_failed');
    }
  }, [searchParams, router]);

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
