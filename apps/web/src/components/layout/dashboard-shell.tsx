'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { BottomNav } from './bottom-nav';
import { useAuth } from '@/providers/auth-provider';
import { LoadingState } from '@/components/ui/states';
import { OnboardingGate } from '@/components/onboarding/onboarding-gate';

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Redirect to login once we know the user is not authenticated.
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Loading your workspace…" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />
        {/* pb-14 keeps content clear of the fixed mobile bottom nav; reset from md up. */}
        <main className="flex-1 overflow-x-hidden pb-14 md:pb-0">{children}</main>
      </div>
      <BottomNav onMore={() => setSidebarOpen(true)} />
      <OnboardingGate />
    </div>
  );
}
