import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/public-layout';

export const metadata: Metadata = {
  title: 'About DoAide Desk — AI Helpdesk for Indian SMBs',
  description:
    'DoAide Desk is an AI-powered customer support platform built for Indian SMBs. Unified inbox across WhatsApp, email, and Instagram with smart ticket routing.',
  openGraph: {
    title: 'About DoAide Desk — AI Helpdesk for Indian SMBs',
    description:
      'AI-powered customer support platform with unified inbox, smart routing, and multilingual support for Indian businesses.',
    url: 'https://desk.doaide.com/about',
  },
};

const TESTIMONIALS = [
  {
    quote:
      'We went from 4-hour response times to under 15 minutes. Our 3-person team now handles 200+ daily queries across WhatsApp and email without breaking a sweat.',
    name: 'Rajesh Mehta',
    role: 'Founder, Mehta Textiles',
    location: 'Surat',
  },
  {
    quote:
      'The AI auto-replies handle 60% of our routine questions — order tracking, return status, payment confirmations. Our agents finally have time for the conversations that matter.',
    name: 'Priya Nair',
    role: 'Head of CX, ShopKart',
    location: 'Bengaluru',
  },
  {
    quote:
      'During Diwali, our ticket volume tripled overnight. DoAide Desk\'s smart routing kept our SLAs intact without emergency hiring. That alone paid for the entire year.',
    name: 'Amit Choudhary',
    role: 'Operations Manager, GiftBox India',
    location: 'Jaipur',
  },
  {
    quote:
      'Our customers message us in Hindi, English, and Gujarati — sometimes all in one conversation. The multilingual AI handles it seamlessly and suggests replies in the right language.',
    name: 'Sneha Patel',
    role: 'Co-founder, UrbanCraft Studio',
    location: 'Ahmedabad',
  },
];

const FAQ_ITEMS = [
  {
    question: 'What is DoAide Desk?',
    answer:
      'DoAide Desk is an AI-powered customer support platform that unifies your conversations across WhatsApp, email, Instagram, SMS, and web chat into a single intelligent inbox. It uses AI to auto-categorize tickets, suggest replies, and route conversations to the right agent.',
  },
  {
    question: 'Is DoAide Desk suitable for small businesses?',
    answer:
      'Yes. DoAide Desk is designed specifically for Indian SMBs. Our pricing starts at affordable tiers, and teams as small as 2-3 agents see immediate improvements in response time and customer satisfaction.',
  },
  {
    question: 'Does DoAide Desk support WhatsApp?',
    answer:
      'Yes. DoAide Desk integrates with the WhatsApp Business API. Every WhatsApp message automatically creates a trackable ticket, preserves conversation history, and supports media attachments like photos and documents.',
  },
  {
    question: 'What languages does the AI support?',
    answer:
      'The AI supports English, Hindi, and other major Indian languages. It can detect the language of incoming messages automatically and suggest replies in the customer\'s preferred language, including code-switched conversations.',
  },
  {
    question: 'Can I try DoAide Desk for free?',
    answer:
      'Yes. We offer free tools including a Response Time Calculator, Ticket Volume Forecaster, and CSAT Calculator. You can also sign up for a free trial of the full platform to see the AI helpdesk in action with your team.',
  },
  {
    question: 'How does AI ticket routing work?',
    answer:
      'DoAide Desk\'s AI reads the content of incoming messages, identifies the topic and urgency, and routes the ticket to the agent or team best equipped to handle it. This happens in under a second, eliminating manual triage and reducing transfer rates.',
  },
  {
    question: 'Is my customer data secure?',
    answer:
      'Yes. DoAide Desk uses industry-standard encryption for data in transit and at rest. We do not share customer data with third parties, and our infrastructure is hosted on secure cloud servers with regular security audits.',
  },
  {
    question: 'How long does it take to set up?',
    answer:
      'Most teams are up and running within a day. Connect your WhatsApp Business account and email, invite your agents, and the AI starts learning from your conversations immediately. No complex integrations or IT support required.',
  },
];

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-4xl mx-auto px-6 py-16">
        {/* Hero */}
        <section className="text-center mb-20">
          <h1
            className="text-4xl font-bold text-[var(--doaide-text)] mb-4"
            style={{ fontFamily: 'var(--doaide-font-display)' }}
          >
            AI-Powered Customer Support for Indian Businesses
          </h1>
          <p className="text-lg text-[var(--doaide-text-secondary)] max-w-2xl mx-auto mb-8">
            DoAide Desk unifies WhatsApp, email, Instagram, and web chat into one intelligent inbox.
            AI handles the routine — your team handles what matters.
          </p>
          <Link
            href="/"
            className="inline-block px-6 py-3 rounded-lg text-sm font-semibold bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)] hover:bg-[var(--doaide-gold-hover)] no-underline transition-colors"
          >
            Start Free Trial
          </Link>
        </section>

        {/* Testimonials */}
        <section className="mb-20">
          <h2
            className="text-2xl font-bold text-[var(--doaide-text)] text-center mb-10"
            style={{ fontFamily: 'var(--doaide-font-display)' }}
          >
            Trusted by Indian Businesses
          </h2>
          <div className="grid gap-6 sm:grid-cols-2">
            {TESTIMONIALS.map((t) => (
              <div
                key={t.name}
                className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]"
              >
                <p className="text-[var(--doaide-text-secondary)] text-sm leading-relaxed mb-4 italic">
                  &ldquo;{t.quote}&rdquo;
                </p>
                <div>
                  <p className="text-sm font-semibold text-[var(--doaide-text)]">{t.name}</p>
                  <p className="text-xs text-[var(--doaide-text-muted)]">
                    {t.role} &middot; {t.location}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section className="mb-16">
          <h2
            className="text-2xl font-bold text-[var(--doaide-text)] text-center mb-10"
            style={{ fontFamily: 'var(--doaide-font-display)' }}
          >
            Frequently Asked Questions
          </h2>
          <div className="space-y-4">
            {FAQ_ITEMS.map((faq) => (
              <details
                key={faq.question}
                className="group rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] overflow-hidden"
              >
                <summary className="cursor-pointer px-6 py-4 text-sm font-semibold text-[var(--doaide-text)] list-none flex items-center justify-between gap-4">
                  {faq.question}
                  <span className="text-[var(--doaide-text-muted)] text-xs transition-transform group-open:rotate-45">
                    +
                  </span>
                </summary>
                <div className="px-6 pb-4 text-sm text-[var(--doaide-text-secondary)] leading-relaxed">
                  {faq.answer}
                </div>
              </details>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="text-center py-12 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <h2 className="text-xl font-bold text-[var(--doaide-text)] mb-3" style={{ fontFamily: 'var(--doaide-font-display)' }}>
            Ready to transform your support?
          </h2>
          <p className="text-sm text-[var(--doaide-text-secondary)] mb-6">
            Join hundreds of Indian businesses using DoAide Desk to deliver faster, smarter support.
          </p>
          <Link
            href="/"
            className="inline-block px-6 py-3 rounded-lg text-sm font-semibold bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)] hover:bg-[var(--doaide-gold-hover)] no-underline transition-colors"
          >
            Get Started Free
          </Link>
        </section>

        {/* JSON-LD FAQPage Schema */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: FAQ_ITEMS.map((faq) => ({
                '@type': 'Question',
                name: faq.question,
                acceptedAnswer: {
                  '@type': 'Answer',
                  text: faq.answer,
                },
              })),
            }),
          }}
        />
      </main>
      <PublicFooter />
    </div>
  );
}
