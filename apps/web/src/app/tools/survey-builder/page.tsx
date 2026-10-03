import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { SurveyBuilder } from './builder';

export const metadata: Metadata = {
  title: 'Customer Satisfaction Survey Builder',
  description: 'Build customer satisfaction surveys with pre-written questions and rating scales. Free tool by DoAide Desk.',
  openGraph: {
    title: 'Survey Builder — DoAide Desk',
    description: 'Build customer satisfaction surveys with pre-written questions and rating scales.',
    url: 'https://desk.doaide.com/tools/survey-builder',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <SurveyBuilder />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Customer Satisfaction Survey Builder',
            description: 'Build customer satisfaction surveys with pre-written questions and rating scales.',
            url: 'https://desk.doaide.com/tools/survey-builder',
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
