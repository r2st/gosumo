import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { GratuityCalculator } from './calculator';

export const metadata: Metadata = {
  alternates: { canonical: '/tools/gratuity-calculator' },
  title: 'Gratuity Calculator India',
  description: 'Calculate gratuity under the Payment of Gratuity Act, 1972 — amount payable, tax-free limit, and eligibility. Free tool by DoAide Desk.',
  openGraph: {
    title: 'Gratuity Calculator India — DoAide Desk',
    description: 'Calculate gratuity payable, the ₹20 lakh tax-free limit, and eligibility from your salary and years of service.',
    url: 'https://desk.doaide.com/tools/gratuity-calculator',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--da-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <GratuityCalculator />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Gratuity Calculator India',
            description: 'Calculate gratuity payable under the Payment of Gratuity Act, 1972 from last drawn salary and years of service.',
            url: 'https://desk.doaide.com/tools/gratuity-calculator',
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
