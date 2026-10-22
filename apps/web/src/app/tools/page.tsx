import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/public-layout';

export const metadata: Metadata = {
  alternates: { canonical: '/tools' },
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
  {
    slug: 'ticket-template-generator',
    title: 'Ticket Template Generator',
    description: 'Generate structured ticket templates for bug reports, feature requests, and more.',
    icon: '📝',
  },
  {
    slug: 'sla-calculator',
    title: 'SLA Calculator',
    description: 'Calculate uptime targets, allowed downtime, and staffing needs from your SLA.',
    icon: '📐',
  },
  {
    slug: 'survey-builder',
    title: 'Survey Builder',
    description: 'Build customer satisfaction surveys with pre-written questions and rating scales.',
    icon: '📋',
  },
  {
    slug: 'leave-calculator',
    title: 'Leave Encashment Calculator',
    description: 'Calculate earned leave accrual and the cash value of unused leave for Indian employees.',
    icon: '🏖️',
  },
  {
    slug: 'gratuity-calculator',
    title: 'Gratuity Calculator',
    description: 'Calculate gratuity under the Payment of Gratuity Act with the ₹20 lakh tax-free limit.',
    icon: '💰',
  },
  {
    slug: 'tds-calculator',
    title: 'TDS on Salary Calculator',
    description: 'Estimate monthly TDS on salary for FY 2025-26 under the new and old tax regimes.',
    icon: '🧾',
  },
] as const;

export default function ToolsIndex() {
  return (
    <div className="min-h-screen bg-[var(--da-bg)]">
      <PublicNav />
      <main className="max-w-5xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold text-[var(--da-text)] mb-2" style={{ fontFamily: 'var(--da-font-display)' }}>
          Free Customer Support Tools
        </h1>
        <p className="text-[var(--da-text-secondary)] mb-10 max-w-2xl">
          Practical calculators to help support teams measure performance, plan capacity, and track customer satisfaction — no sign-up required.
        </p>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map((tool) => (
            <Link
              key={tool.slug}
              href={`/tools/${tool.slug}`}
              className="block p-6 rounded-xl border border-[var(--da-border)] bg-[var(--da-surface)] hover:border-[var(--da-gold)] hover:shadow-[var(--da-shadow-gold)] transition-all no-underline group"
            >
              <div className="text-3xl mb-3">{tool.icon}</div>
              <h2 className="text-lg font-semibold text-[var(--da-text)] group-hover:text-[var(--da-gold)] transition-colors mb-2">
                {tool.title}
              </h2>
              <p className="text-sm text-[var(--da-text-secondary)]">{tool.description}</p>
            </Link>
          ))}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
