import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { TicketTemplateGenerator } from './generator';

export const metadata: Metadata = {
  title: 'Ticket Template Generator',
  description: 'Generate structured support ticket templates for bug reports, feature requests, and more. Free tool by GoSumo Realty.',
  openGraph: {
    title: 'Ticket Template Generator — GoSumo Realty',
    description: 'Generate structured support ticket templates for common categories.',
    url: 'https://gosumo.aiknol.com/tools/ticket-template-generator',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <TicketTemplateGenerator />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Ticket Template Generator',
            description: 'Generate structured support ticket templates for common categories.',
            url: 'https://gosumo.aiknol.com/tools/ticket-template-generator',
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
            author: { '@type': 'Organization', name: 'Apprend Technologies', url: 'https://gosumo.aiknol.com' },
          }),
        }}
      />
    </div>
  );
}
