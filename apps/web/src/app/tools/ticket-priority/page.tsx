import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { TicketPriority } from './calculator';

export const metadata: Metadata = {
  alternates: { canonical: '/tools/ticket-priority' },
  title: 'Ticket Priority System',
  description: 'Free ticket priority calculator for support teams. Score tickets by impact, urgency, customer tier, and age using a weighted matrix.',
  openGraph: {
    title: 'Ticket Priority System — DoAide Desk',
    description: 'Automatically prioritize support tickets with weighted scoring.',
    url: 'https://desk.doaide.com/tools/ticket-priority',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--da-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <TicketPriority />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Ticket Priority System',
            description: 'Free ticket priority calculator for support teams.',
            url: 'https://desk.doaide.com/tools/ticket-priority',
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          }),
        }}
      />
    </div>
  );
}
