import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { TdsCalculator } from './calculator';

export const metadata: Metadata = {
  alternates: { canonical: '/tools/tds-calculator' },
  title: 'TDS on Salary Calculator FY 2025-26',
  description: 'Estimate monthly TDS on salary for FY 2025-26 under the new and old tax regimes, with slabs, rebate, and cess. Free tool by DoAide Desk.',
  openGraph: {
    title: 'TDS on Salary Calculator — DoAide Desk',
    description: 'Estimate monthly TDS deduction from salary under the new or old Indian tax regime for FY 2025-26.',
    url: 'https://desk.doaide.com/tools/tds-calculator',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--da-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <TdsCalculator />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'TDS on Salary Calculator',
            description: 'Estimate monthly TDS deduction from salary under the new or old Indian tax regime for FY 2025-26.',
            url: 'https://desk.doaide.com/tools/tds-calculator',
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
