import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { SatisfactionSurvey } from './survey';

export const metadata: Metadata = {
  alternates: { canonical: '/tools/satisfaction-survey' },
  title: 'Customer Satisfaction Survey Builder',
  description: 'Free CSAT and NPS survey builder for support teams. Create, preview, and export customer satisfaction surveys with rating, NPS, and free-text questions.',
  openGraph: {
    title: 'Customer Satisfaction Survey Builder — DoAide Desk',
    description: 'Build CSAT and NPS surveys. Preview and export templates.',
    url: 'https://desk.doaide.com/tools/satisfaction-survey',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--da-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <SatisfactionSurvey />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Customer Satisfaction Survey Builder',
            description: 'Free CSAT and NPS survey builder for support teams.',
            url: 'https://desk.doaide.com/tools/satisfaction-survey',
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          }),
        }}
      />
    </div>
  );
}
