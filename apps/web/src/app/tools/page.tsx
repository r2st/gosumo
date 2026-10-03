import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/public-layout';

export const metadata: Metadata = {
  title: 'Free Customer Support Tools',
  description: 'Free calculators for support teams: response time calculator, ticket volume forecaster, and CSAT calculator.',
};

const TOOLS = [
  {
    slug: 'response-time-calculator',
    title: 'Response Time Calculator',
    description: 'Calculate average support response times and SLA compliance across your team.',
    icon: '⏱️',
  },
  {
    slug: 'ticket-volume-forecaster',
    title: 'Ticket Volume Forecaster',
    description: 'Predict weekly and monthly ticket volume from historical data.',
    icon: '📊',
  },
  {
    slug: 'csat-calculator',
    title: 'CSAT Calculator',
    description: 'Calculate Customer Satisfaction Score from survey responses.',
    icon: '⭐',
  },
] as const;

export default function ToolsIndex() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-5xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>
          Free Customer Support Tools
        </h1>
        <p className="text-[var(--doaide-text-secondary)] mb-10 max-w-2xl">
          Practical calculators to help support teams measure performance, plan capacity, and track customer satisfaction — no sign-up required.
        </p>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map((tool) => (
            <Link
              key={tool.slug}
              href={`/tools/${tool.slug}`}
              className="block p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] hover:border-[var(--doaide-gold)] hover:shadow-[var(--doaide-shadow-gold)] transition-all no-underline group"
            >
              <div className="text-3xl mb-3">{tool.icon}</div>
              <h2 className="text-lg font-semibold text-[var(--doaide-text)] group-hover:text-[var(--doaide-gold)] transition-colors mb-2">
                {tool.title}
              </h2>
              <p className="text-sm text-[var(--doaide-text-secondary)]">{tool.description}</p>
            </Link>
          ))}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
