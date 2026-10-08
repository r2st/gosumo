import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/public-layout';

export const metadata: Metadata = {
  title: 'Blog',
  description: 'Insights on AI-powered customer support, team metrics, and automation strategies.',
};

const POSTS = [
  {
    slug: 'best-crm-for-freelancers-india',
    title: 'Best CRM for Freelancers in India: What Actually Works in 2026',
    excerpt: 'Why generic CRMs fail freelancers, and how AI-powered client management tools built for the Indian market help you retain clients and grow revenue.',
    date: '2026-10-08',
    readTime: '7 min read',
  },
  {
    slug: 'ai-client-management-small-business',
    title: 'AI Client Management: How Small Businesses Are Winning with Automation',
    excerpt: 'From auto-replies to smart routing, AI client management is no longer enterprise-only. Here is how small businesses are using it to compete.',
    date: '2026-10-08',
    readTime: '6 min read',
  },
  {
    slug: 'client-retention-strategies-service-businesses',
    title: '7 Client Retention Strategies That Actually Work for Service Businesses',
    excerpt: 'Acquiring a new client costs 5x more than retaining one. These seven strategies help service businesses in India keep clients coming back.',
    date: '2026-10-08',
    readTime: '8 min read',
  },
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
  {
    slug: 'ai-helpdesk-revolution-indian-smbs',
    title: 'The AI Helpdesk Revolution: Why Indian SMBs Are Switching Now',
    excerpt: 'From Jaipur textile exporters to Bengaluru SaaS startups, Indian SMBs are adopting AI helpdesks to handle multilingual support at scale — without hiring large teams.',
    date: '2026-10-06',
    readTime: '7 min read',
  },
  {
    slug: 'customer-support-automation-reduce-costs',
    title: 'Customer Support Automation: Cut Costs by 50% Without Losing the Human Touch',
    excerpt: 'Automation does not mean robotic replies. Learn how to automate the repetitive work while keeping high-touch interactions personal and empathetic.',
    date: '2026-10-08',
    readTime: '6 min read',
  },
  {
    slug: 'ticketing-best-practices-indian-smbs',
    title: 'Ticketing Best Practices for Indian SMBs: A Practical Guide',
    excerpt: 'From WhatsApp-first workflows to festival-season surge planning, here are the ticketing strategies that work for Indian small and medium businesses.',
    date: '2026-10-10',
    readTime: '8 min read',
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
