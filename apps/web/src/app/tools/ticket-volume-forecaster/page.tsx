import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { TicketVolumeForecaster } from './forecaster';

export const metadata: Metadata = {
  title: 'Ticket Volume Forecaster',
  description: 'Predict weekly and monthly ticket volume from historical data. Free tool by DoAide Desk.',
  openGraph: {
    title: 'Ticket Volume Forecaster — DoAide Desk',
    description: 'Predict weekly and monthly ticket volume from historical data.',
    url: 'https://desk.doaide.com/tools/ticket-volume-forecaster',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <TicketVolumeForecaster />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Ticket Volume Forecaster',
            description: 'Predict weekly and monthly ticket volume from historical data.',
            url: 'https://desk.doaide.com/tools/ticket-volume-forecaster',
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
