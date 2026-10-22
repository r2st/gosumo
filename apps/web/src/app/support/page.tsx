import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { SupportForm } from './support-form';

export const metadata: Metadata = {
  alternates: { canonical: '/support' },
  title: 'Raise a Support Ticket — No Sign-up Needed',
  description:
    'Submit a support ticket in under a minute. No account, no app to install — describe the issue and the team replies on email or phone.',
  openGraph: {
    title: 'Raise a Support Ticket — DoAide Desk',
    description: 'Submit a support ticket without signing up. Get a reference number instantly.',
    url: 'https://desk.doaide.com/support',
  },
};

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-[var(--da-bg)]">
      <PublicNav />
      <main className="max-w-xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
        <Suspense fallback={null}>
          <SupportForm />
        </Suspense>
      </main>
      <PublicFooter />
    </div>
  );
}
