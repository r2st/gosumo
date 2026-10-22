import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { LeaveCalculator } from './calculator';

export const metadata: Metadata = {
  alternates: { canonical: '/tools/leave-calculator' },
  title: 'Leave Encashment Calculator India',
  description: 'Calculate earned leave accrual and leave encashment value with the Section 10(10AA) tax exemption. Free tool by DoAide Desk.',
  openGraph: {
    title: 'Leave Encashment Calculator — DoAide Desk',
    description: 'Calculate the cash value of unused leave, per-day salary, and leave accrual for Indian employees.',
    url: 'https://desk.doaide.com/tools/leave-calculator',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--da-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <LeaveCalculator />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Leave Encashment Calculator India',
            description: 'Calculate the cash value of unused leave, per-day salary, and leave accrual for Indian employees.',
            url: 'https://desk.doaide.com/tools/leave-calculator',
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            author: { '@type': 'Organization', name: 'Apprend Technologies', url: 'https://desk.doaide.com' },
          }),
        }}
      />
    </div>
  );
}
