import type { Metadata } from 'next';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { KBEditor } from './editor';

export const metadata: Metadata = {
  alternates: { canonical: '/tools/kb-editor' },
  title: 'Knowledge Base Editor',
  description: 'Free knowledge base article editor for support teams. Write in Markdown, organize by category, preview, and export articles.',
  openGraph: {
    title: 'Knowledge Base Editor — DoAide Desk',
    description: 'Create and manage knowledge base articles with Markdown.',
    url: 'https://desk.doaide.com/tools/kb-editor',
  },
};

export default function Page() {
  return (
    <div className="min-h-screen bg-[var(--da-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <KBEditor />
      </main>
      <PublicFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            name: 'Knowledge Base Editor',
            description: 'Free knowledge base article editor for support teams.',
            url: 'https://desk.doaide.com/tools/kb-editor',
            applicationCategory: 'BusinessApplication',
            operatingSystem: 'Web',
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          }),
        }}
      />
    </div>
  );
}
