import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { SlaCalculator } from './calculator';

export const metadata: Metadata = {
  title: 'SLA Calculator',
  description: 'Calculate uptime targets, allowed downtime, and staffing needs from your SLA. Free tool by DoAide Desk.',
  openGraph: {
    title: 'SLA Calculator — DoAide Desk',
    description: 'Calculate allowed downtime, response capacity, and agents needed from your SLA targets.',
    url: 'https://desk.doaide.com/tools/sla-calculator',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <SlaCalculator />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'SLA Calculator',
            description: 'Calculate allowed downtime, response capacity, and agents needed from your SLA targets.',
            url: 'https://desk.doaide.com/tools/sla-calculator',
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
