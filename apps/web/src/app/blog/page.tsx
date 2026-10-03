import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/public-layout';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Insights on AI-powered customer support, team metrics, and automation strategies.',
};

const POSTS = [
  {
    slug: 'ai-transforms-customer-support-response-times',
    title: 'How AI Transforms Customer Support Response Times',
    excerpt: 'Discover how artificial intelligence is revolutionizing support workflows, cutting response times by up to 70%, and keeping customers happier.',
    date: '2026-09-15',
    readTime: '6 min read',
  },
  {
    slug: '5-metrics-every-support-team-should-track',
    title: '5 Metrics Every Support Team Should Track',
    excerpt: 'From first response time to CSAT, these five KPIs give support leaders the visibility they need to drive continuous improvement.',
    date: '2026-09-22',
    readTime: '5 min read',
  },
  {
    slug: 'complete-guide-automated-ticket-routing',
    title: 'The Complete Guide to Automated Ticket Routing',
    excerpt: 'Learn how rule-based and AI-driven routing works, when to use each approach, and how to set up routing that scales with your team.',
    date: '2026-09-29',
    readTime: '7 min read',
  },
] as const;

export default function BlogIndex() {
  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>Blog</h1>
        <p className="text-[var(--doaide-text-secondary)] mb-10">Insights on AI-powered customer support, team metrics, and automation.</p>
        <div className="space-y-8">
          {POSTS.map((post) => (
            <Link key={post.slug} href={`/blog/${post.slug}`} className="block p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] hover:border-[var(--doaide-gold)] transition-colors no-underline group">
              <div className="flex items-center gap-3 mb-2 text-xs text-[var(--doaide-text-muted)]">
                <time>{post.date}</time>
                <span>&middot;</span>
                <span>{post.readTime}</span>
              </div>
              <h2 className="text-lg font-semibold text-[var(--doaide-text)] group-hover:text-[var(--doaide-gold)] transition-colors mb-2">{post.title}</h2>
              <p className="text-sm text-[var(--doaide-text-secondary)]">{post.excerpt}</p>
            </Link>
          ))}
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
