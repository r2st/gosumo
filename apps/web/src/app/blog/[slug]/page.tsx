import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { PublicNav, PublicFooter } from '@/components/public-layout';
import { ShareButtons } from '@/components/share-buttons';

const POSTS: Record<string, { title: string; date: string; readTime: string; content: string }> = {
  'ai-transforms-customer-support-response-times': {
    title: 'How AI Transforms Customer Support Response Times',
    date: '2026-09-15',
    readTime: '6 min read',
    content: `
Customer support teams face growing pressure to respond faster while handling more tickets than ever. AI is changing the game — not by replacing agents, but by giving them superpowers.

## The Response Time Problem

Studies show that 90% of customers rate an "immediate" response as important when they have a support question. Yet the average first response time across industries sits at over 12 hours. This gap costs businesses real revenue — 60% of customers have switched brands due to poor service.

## How AI Closes the Gap

### 1. Instant Triage and Routing

AI can analyze incoming tickets in milliseconds, categorizing them by topic, urgency, and required expertise. Instead of a human dispatcher reading each ticket, AI routes it to the right agent or team instantly. This alone cuts response time by 30-40%.

### 2. Smart Reply Suggestions

When an agent opens a ticket, AI suggests contextual responses based on the customer's issue, account history, and what has worked for similar cases. Agents can send a well-crafted reply in seconds instead of minutes.

### 3. Auto-Resolution for Common Questions

Between 40-60% of support tickets are repetitive — password resets, order tracking, return policies. AI handles these autonomously, freeing agents to focus on complex issues that need a human touch.

### 4. Proactive Outreach

AI can detect patterns that predict customer frustration — a failed payment, a shipping delay, a bug encounter — and trigger proactive outreach before the customer even contacts support.

## Real-World Impact

Companies using AI in their support stack report:

- **68% reduction** in first response time
- **45% fewer** escalations to senior agents
- **22% increase** in customer satisfaction scores
- **3x more** tickets handled per agent per day

## Getting Started

Start small: implement AI triage for routing, then add suggested replies. Once your team is comfortable, enable auto-resolution for your top 10 most common ticket types. The key is augmenting your team, not replacing them.

DoAide Desk provides all of these AI capabilities out of the box — try our [free tools](/tools) to see the impact on your metrics.
    `.trim(),
  },
  '5-metrics-every-support-team-should-track': {
    title: '5 Metrics Every Support Team Should Track',
    date: '2026-09-22',
    readTime: '5 min read',
    content: `
If you can't measure it, you can't improve it. Here are the five metrics that separate great support teams from the rest.

## 1. First Response Time (FRT)

**What it measures:** How quickly your team sends the first human reply after a customer reaches out.

**Why it matters:** FRT is the single biggest driver of customer satisfaction. A reply within 5 minutes makes 70% of customers feel valued, while waiting more than an hour drops satisfaction by 50%.

**Benchmark:** Under 1 hour for email, under 5 minutes for chat and messaging channels.

Use our [Response Time Calculator](/tools/response-time-calculator) to measure your team's FRT.

## 2. Ticket Volume and Trends

**What it measures:** The total number of support requests over time, broken down by channel, category, and day of week.

**Why it matters:** Volume trends drive staffing decisions. A 20% spike you didn't see coming means missed SLAs and burned-out agents. A steady decline might mean your product is improving — or that customers have given up.

**Benchmark:** Track week-over-week and month-over-month. Flag any change above 15% for investigation.

Try our [Ticket Volume Forecaster](/tools/ticket-volume-forecaster) to predict upcoming demand.

## 3. Customer Satisfaction (CSAT)

**What it measures:** The percentage of customers who rate their experience as "Satisfied" or "Very Satisfied" in post-interaction surveys.

**Why it matters:** CSAT is the voice of the customer. It catches quality issues that volume metrics miss — you can close tickets fast but still leave customers unhappy.

**Benchmark:** 75-85% is good, above 90% is excellent.

Calculate yours with our [CSAT Calculator](/tools/csat-calculator).

## 4. Resolution Rate

**What it measures:** The percentage of tickets that are fully resolved (not just responded to) within a given timeframe.

**Why it matters:** Response time means nothing if the issue isn't actually solved. A high FRT with a low resolution rate signals that agents are rushing replies without addressing root causes.

**Benchmark:** Aim for 80%+ same-day resolution for non-complex issues.

## 5. Agent Utilization

**What it measures:** The proportion of an agent's available time spent actively handling tickets versus waiting or doing administrative work.

**Why it matters:** Too low means you're overstaffed. Too high means agents are headed for burnout. The sweet spot balances throughput with quality.

**Benchmark:** 70-80% utilization is optimal. Above 85% risks burnout and quality drops.

## Putting It All Together

Track these five metrics on a weekly dashboard. Look for correlations: does FRT spike when volume rises? Does CSAT drop when utilization crosses 85%? These patterns reveal where to invest — whether that's more agents, better tooling, or AI automation.
    `.trim(),
  },
  'complete-guide-automated-ticket-routing': {
    title: 'The Complete Guide to Automated Ticket Routing',
    date: '2026-09-29',
    readTime: '7 min read',
    content: `
Ticket routing is the invisible backbone of customer support. Get it wrong, and tickets bounce between agents, response times spike, and customers get frustrated. Get it right, and your team becomes dramatically more efficient.

## What Is Ticket Routing?

Ticket routing is the process of assigning an incoming support request to the right agent or team. Manual routing relies on a dispatcher reading each ticket and deciding where it goes. Automated routing uses rules or AI to make this decision instantly.

## Rule-Based vs. AI-Driven Routing

### Rule-Based Routing

How it works: you define conditions (if subject contains "billing" → assign to Finance team). Simple, predictable, and easy to audit.

**Best for:** Teams with clear-cut categories and stable ticket types.

**Limitations:** Rules break when edge cases appear. A ticket about "billing for a cancelled order" could match both Finance and Orders — without priority rules, it gets stuck.

### AI-Driven Routing

How it works: a machine learning model reads the ticket content, analyzes sentiment and intent, considers agent availability and expertise, and picks the best match.

**Best for:** Teams handling diverse, nuanced requests across multiple channels.

**Advantages:**
- Handles ambiguous tickets that stump rule-based systems
- Learns from outcomes — if a routing decision led to a transfer, it adjusts
- Considers load balancing automatically
- Improves over time without manual rule updates

## Building Your Routing Strategy

### Step 1: Map Your Support Taxonomy

List every type of issue your team handles. Group them into categories (billing, technical, shipping, account) and subcategories. This taxonomy becomes the foundation for both rules and AI training.

### Step 2: Define Your Teams and Skills

Document which agents or teams handle which categories. Note expertise levels — a junior agent can handle password resets, but billing disputes need a senior agent.

### Step 3: Set Priority Rules

Not all tickets are equal. VIP customers, security issues, and service outages should jump the queue. Define priority levels and the criteria that trigger each one.

### Step 4: Implement Round-Robin with Load Balancing

Within a team, distribute tickets evenly. But go beyond simple round-robin: factor in each agent's current queue depth, average handle time, and skill match.

### Step 5: Add Escalation Paths

Define when and how a ticket escalates. Time-based (no response in 30 minutes → escalate to team lead) and complexity-based (3+ replies without resolution → escalate to senior agent) rules catch tickets that are falling through the cracks.

## Measuring Routing Effectiveness

Track these metrics to know if your routing is working:

- **Transfer rate:** What percentage of tickets get reassigned after initial routing? Below 10% is good.
- **Time to right agent:** How long until the ticket reaches someone who can actually solve it?
- **Routing accuracy:** What percentage of tickets are correctly routed on the first try?

## Common Pitfalls

1. **Over-routing to specialists.** If 80% of tickets go to your senior team, your routing is too conservative.
2. **Ignoring channel context.** A WhatsApp message needs different handling than an email — routing should account for this.
3. **Not updating rules.** When you launch a new product or change a policy, update your routing rules the same day.

DoAide Desk combines AI-driven routing with customizable rules, giving you the best of both approaches — automatic intelligence with manual overrides when you need them.
    `.trim(),
  },
};

interface Props {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = POSTS[slug];
  if (!post) return {};
  return {
    title: post.title,
    description: post.content.slice(0, 155).replace(/\n/g, ' '),
    openGraph: {
      title: `${post.title} — DoAide Desk Blog`,
      description: post.content.slice(0, 155).replace(/\n/g, ' '),
      url: `https://desk.doaide.com/blog/${slug}`,
      type: 'article',
      publishedTime: post.date,
    },
  };
}

export function generateStaticParams() {
  return Object.keys(POSTS).map((slug) => ({ slug }));
}

export default async function BlogPost({ params }: Props) {
  const { slug } = await params;
  const post = POSTS[slug];
  if (!post) notFound();

  return (
    <div className="min-h-screen bg-[var(--doaide-bg)]">
      <PublicNav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <Link href="/blog" className="text-sm text-[var(--doaide-text-muted)] hover:text-[var(--doaide-gold)] no-underline mb-6 inline-block">&larr; Back to Blog</Link>
        <article>
          <div className="flex items-center gap-3 mb-3 text-xs text-[var(--doaide-text-muted)]">
            <time>{post.date}</time>
            <span>&middot;</span>
            <span>{post.readTime}</span>
          </div>
          <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-8" style={{ fontFamily: 'var(--doaide-font-display)' }}>{post.title}</h1>
          <div className="prose prose-invert max-w-none text-[var(--doaide-text-secondary)] [&_h2]:text-[var(--doaide-text)] [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-8 [&_h2]:mb-4 [&_h3]:text-[var(--doaide-text)] [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-6 [&_h3]:mb-3 [&_p]:mb-4 [&_p]:leading-relaxed [&_ul]:mb-4 [&_ul]:space-y-1 [&_li]:text-[var(--doaide-text-secondary)] [&_strong]:text-[var(--doaide-text)] [&_a]:text-[var(--doaide-gold)] [&_a]:no-underline [&_a:hover]:underline">
            {post.content.split('\n\n').map((block, i) => {
              if (block.startsWith('### ')) return <h3 key={i}>{block.slice(4)}</h3>;
              if (block.startsWith('## ')) return <h2 key={i}>{block.slice(3)}</h2>;
              if (block.startsWith('- ')) {
                return (
                  <ul key={i} className="list-disc pl-5">
                    {block.split('\n').map((line, j) => (
                      <li key={j}>{line.replace(/^- \*\*/, '').replace(/\*\*/, ' — ').replace(/\*\*/g, '')}</li>
                    ))}
                  </ul>
                );
              }
              return <p key={i}>{block}</p>;
            })}
          </div>
          <hr className="my-8 border-[var(--doaide-border)]" />
          <ShareButtons url={`https://desk.doaide.com/blog/${slug}`} title={`${post.title} — DoAide Desk`} />
        </article>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'BlogPosting',
              headline: post.title,
              datePublished: post.date,
              author: { '@type': 'Organization', name: 'Apprend Technologies', url: 'https://doaide.com' },
              publisher: { '@type': 'Organization', name: 'DoAide Desk', url: 'https://desk.doaide.com' },
              url: `https://desk.doaide.com/blog/${slug}`,
            }),
          }}
        />
      </main>
      <PublicFooter />
    </div>
  );
}
