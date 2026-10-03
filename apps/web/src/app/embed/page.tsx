import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { EmbedGenerator } from './generator';

export const metadata: Metadata = {
  title: 'Embed Widget Generator',
  description: 'Generate an embeddable DoAide Desk support widget for your website.',
  openGraph: {
    title: 'Embed Widget Generator — DoAide Desk',
    description: 'Add AI-powered customer support to your website in minutes.',
    url: 'https://desk.doaide.com/embed',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <EmbedGenerator />
      </main>
      <PublicFooter />
    </div>
  );
}
