import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { CsatCalculator } from './calculator';

export const metadata: Metadata = {
  title: 'CSAT Calculator',
  description: 'Calculate Customer Satisfaction Score from survey responses. Free tool by DoAide Desk.',
  openGraph: {
    title: 'CSAT Calculator — DoAide Desk',
    description: 'Calculate Customer Satisfaction Score from survey responses.',
    url: 'https://desk.doaide.com/tools/csat-calculator',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <CsatCalculator />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'CSAT Calculator',
            description: 'Calculate Customer Satisfaction Score from survey responses.',
            url: 'https://desk.doaide.com/tools/csat-calculator',
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            author: { '@type': 'Organization', name: 'Apprend Technologies', url: 'https://doaide.com' },
          }),
        }}
      />
    </div>
  );
}
