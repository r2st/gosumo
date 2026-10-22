import type { Metadata } from 'next';
import { DashboardShell } from '@/components/layout/dashboard-shell';

// Every dashboard route needs a session; to a crawler each one is the same
// sign-in redirect, so none of them should be indexed.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
