import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { CannedResponses } from './templates';

export const metadata: Metadata = {
  alternates: { canonical: '/tools/canned-responses' },
  title: 'Canned Response Templates',
  description: 'Free canned response templates for customer support teams. Ready-to-use replies for acknowledgements, updates, resolutions, and apologies.',
  openGraph: {
    title: 'Canned Response Templates — DoAide Desk',
    description: 'Ready-to-use support response templates. Click to copy.',
    url: 'https://desk.doaide.com/tools/canned-responses',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--da-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <CannedResponses />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Canned Response Templates',
            description: 'Free canned response templates for customer support teams.',
            url: 'https://desk.doaide.com/tools/canned-responses',
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          }),
        }}
      />
    </div>
  );
}
