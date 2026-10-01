import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  Brain,
  CalendarCheck,
  Check,
  RefreshCw,
  Target,
  Zap,
} from 'lucide-react';
import { Logo } from '@/components/logo';

// Rendered per request (not statically prerendered). A poisoned static prerender
// of this route once took the site down; rendering per request keeps it safe.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'DoAide Inbox — AI lead manager for real estate',
  description:
    'Every lead answered in 30 seconds. Every buyer qualified on Budget-Location-Timeline-Configuration. Every follow-up kept for 90 days. WhatsApp-native AI for Indian real estate brokers.',
};

const FEATURES = [
  {
    icon: Zap,
    title: 'Speed',
    tag: '24/7 response',
    body: 'Every inbound lead gets a personal reply within 30 seconds — day or night, portal or WhatsApp. No lead ever goes cold waiting for a callback.',
  },
  {
    icon: Target,
    title: 'Qualification',
    tag: 'BLTC scoring',
    body: 'The AI qualifies each buyer on Budget, Location, Timeline and Configuration, then matches them against your live inventory in real time.',
  },
  {
    icon: CalendarCheck,
    title: 'Site visits',
    tag: 'Auto-booking',
    body: 'Interested buyers are offered slots, booked, confirmed and reminded automatically — so your calendar fills itself without the back-and-forth.',
  },
  {
    icon: RefreshCw,
    title: 'Follow-up',
    tag: '90-day cadences',
    body: 'Automated 90-day nurture sequences keep every prospect warm across no-response, post-visit and dormant triggers. Nothing slips through.',
  },
  {
    icon: Brain,
    title: 'Memory',
    tag: 'Permanent history',
    body: 'A permanent record of every buyer — their preferences, conversations and visits — so you pick up exactly where you left off, months later.',
  },
];

const STEPS = [
  {
    step: '1',
    title: 'Capture leads from any source',
    body: 'Housing.com, 99acres, MagicBricks, IVR missed calls, website forms and WhatsApp all flow into one inbox, normalized and de-duplicated.',
  },
  {
    step: '2',
    title: 'AI qualifies and matches inventory',
    body: 'Each buyer is scored on BLTC, matched to the right projects and units, and routed by confidence — auto-handled, drafted for review, or escalated to you.',
  },
  {
    step: '3',
    title: 'Broker closes deals',
    body: 'You walk into every conversation with the buyer already qualified, visits booked and history at hand — so you spend your time closing, not chasing.',
  },
];

const PLANS = [
  {
    name: 'Solo',
    price: '3,999',
    tagline: 'For the independent broker running their own pipeline.',
    features: [
      '1 agent seat',
      'Up to 500 leads / month',
      'WhatsApp + portal capture',
      'BLTC qualification & inventory match',
      '90-day follow-up cadences',
    ],
    featured: false,
  },
  {
    name: 'Team',
    price: '9,999',
    tagline: 'For growing brokerages that need to route and track a team.',
    features: [
      'Up to 5 agent seats',
      'Up to 2,500 leads / month',
      'Lead assignment & round-robin',
      'Site-visit auto-booking',
      'Team performance analytics',
      'Priority support',
    ],
    featured: true,
  },
  {
    name: 'Developer',
    price: '24,999',
    tagline: 'For developers and large agencies running at scale.',
    features: [
      'Unlimited agent seats',
      'Unlimited leads',
      'Multi-project inventory & co-broking exchange',
      'Custom cadences & autonomy controls',
      'API access & integrations',
      'Dedicated success manager',
    ],
    featured: false,
  },
];

export default function Home() {
  const year = new Date().getFullYear();

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Logo />
          <nav className="hidden items-center gap-8 text-sm font-medium text-muted-foreground md:flex">
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#how" className="transition-colors hover:text-foreground">
              How it works
            </a>
            <a href="#pricing" className="transition-colors hover:text-foreground">
              Pricing
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="hidden rounded-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              Start free trial
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-32 -top-40 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -left-32 top-32 h-96 w-96 rounded-full bg-primary/5 blur-3xl" />
        <div className="mx-auto max-w-6xl px-5 pb-20 pt-20 sm:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3.5 py-1.5 text-xs font-semibold text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              WhatsApp-native AI for Indian real estate
            </span>
            <h1 className="mt-6 font-heading text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl md:text-6xl">
              Every lead answered in 30 seconds.
              <br className="hidden sm:block" />
              <span className="text-primary">
                {' '}
                Every buyer qualified. Every follow-up kept.
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              DoAide Inbox is the AI lead manager that replies instantly, qualifies buyers on
              Budget-Location-Timeline-Configuration, books site visits and nurtures every prospect
              for 90 days — so you never lose a deal to a slow follow-up again.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/register"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-7 py-3.5 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 sm:w-auto"
              >
                Start free trial
                <ArrowRight className="h-5 w-5" />
              </Link>
              <a
                href="#how"
                className="inline-flex w-full items-center justify-center rounded-lg border border-border bg-card px-7 py-3.5 text-base font-semibold text-foreground transition-colors hover:bg-muted sm:w-auto"
              >
                See how it works
              </a>
            </div>
            <p className="mt-4 text-sm text-muted-foreground/60">No credit card required · Live in minutes</p>
          </div>
        </div>
      </section>

      {/* Features — the Five Jobs */}
      <section id="features" className="border-t border-border bg-card/60 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-heading text-3xl font-bold tracking-tight sm:text-4xl">
              Five jobs, done for you
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              DoAide Inbox handles the work that costs brokers deals — the speed, the qualifying, the
              chasing — so you can focus on closing.
            </p>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-border bg-card p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                  <f.icon className="h-5 w-5" />
                </div>
                <div className="mt-5 flex items-center gap-2">
                  <h3 className="text-lg font-semibold">{f.title}</h3>
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                    {f.tag}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-heading text-3xl font-bold tracking-tight sm:text-4xl">
              How it works
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              From first ping to signed deal — three steps, most of them automatic.
            </p>
          </div>
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <div key={s.step} className="relative">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground shadow-sm">
                  {s.step}
                </div>
                {i < STEPS.length - 1 && (
                  <ArrowRight className="absolute right-6 top-3 hidden h-6 w-6 text-muted-foreground/40 md:block lg:right-4" />
                )}
                <h3 className="mt-5 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-border bg-card/60 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="font-heading text-3xl font-bold tracking-tight sm:text-4xl">
              Simple, transparent pricing
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Pick a plan that matches your pipeline. Upgrade or downgrade any time.
            </p>
          </div>
          <div className="mt-14 grid items-start gap-6 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={
                  plan.featured
                    ? 'relative rounded-2xl border-2 border-primary bg-card p-8 shadow-lg'
                    : 'relative rounded-2xl border border-border bg-card p-8 shadow-sm'
                }
              >
                {plan.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                    Most popular
                  </span>
                )}
                <h3 className="text-lg font-semibold">{plan.name}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
                <div className="mt-5 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold tracking-tight">
                    ₹{plan.price}
                  </span>
                  <span className="text-sm font-medium text-muted-foreground">/mo</span>
                </div>
                <Link
                  href="/register"
                  className={
                    plan.featured
                      ? 'mt-6 inline-flex w-full items-center justify-center rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90'
                      : 'mt-6 inline-flex w-full items-center justify-center rounded-lg border border-border bg-card px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-muted'
                  }
                >
                  Start free trial
                </Link>
                <ul className="mt-7 space-y-3">
                  {plan.features.map((feat) => (
                    <li key={feat} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      {feat}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA banner */}
      <section className="py-20">
        <div className="mx-auto max-w-5xl px-5">
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary/20 via-primary/10 to-card px-8 py-14 text-center shadow-lg border border-primary/30">
            <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-20 -left-12 h-64 w-64 rounded-full bg-primary/5 blur-3xl" />
            <h2 className="relative font-heading text-3xl font-bold tracking-tight sm:text-4xl">
              Stop losing deals to slow follow-ups.
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-lg text-muted-foreground">
              Let DoAide Inbox answer, qualify and nurture every lead — while you close.
            </p>
            <Link
              href="/register"
              className="relative mt-8 inline-flex items-center gap-2 rounded-lg bg-primary px-7 py-3.5 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              Start free trial
              <ArrowRight className="h-5 w-5" />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-5 py-10 sm:flex-row">
          <Logo />
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#how" className="transition-colors hover:text-foreground">
              How it works
            </a>
            <a href="#pricing" className="transition-colors hover:text-foreground">
              Pricing
            </a>
            <Link href="/login" className="transition-colors hover:text-foreground">
              Sign in
            </Link>
            <Link href="/register" className="transition-colors hover:text-foreground">
              Start free trial
            </Link>
          </nav>
          <p className="text-sm text-muted-foreground/60">
            © {year} DoAide Inbox. All rights reserved.
            <span className="mx-1.5">·</span>
            A{' '}
            <a
              href="https://doaide.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium transition-colors hover:text-foreground"
            >
              DoAide
            </a>{' '}
            product
          </p>
        </div>
      </footer>
    </div>
  );
}
