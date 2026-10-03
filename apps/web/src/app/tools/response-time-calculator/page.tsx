import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { ResponseTimeCalculator } from './calculator';

export const metadata: Metadata = {
  title: 'Response Time Calculator',
  description: 'Calculate average support response times and SLA compliance. Free tool by DoAide Desk.',
  openGraph: {
    title: 'Response Time Calculator — DoAide Desk',
    description: 'Calculate average support response times and SLA compliance.',
    url: 'https://desk.doaide.com/tools/response-time-calculator',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <ResponseTimeCalculator />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Response Time Calculator',
            description: 'Calculate average support response times and SLA compliance.',
            url: 'https://desk.doaide.com/tools/response-time-calculator',
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
