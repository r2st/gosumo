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
  title: 'GoSumo Realty — AI lead manager for real estate',
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
    <div className="min-h-screen bg-white text-slate-900">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
          <Logo className="[&_span]:text-slate-900" />
          <nav className="hidden items-center gap-8 text-sm font-medium text-slate-600 md:flex">
            <a href="#features" className="transition-colors hover:text-slate-900">
              Features
            </a>
            <a href="#how" className="transition-colors hover:text-slate-900">
              How it works
            </a>
            <a href="#pricing" className="transition-colors hover:text-slate-900">
              Pricing
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="hidden rounded-md px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-900 sm:inline-flex"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500"
            >
              Start free trial
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-32 -top-40 h-96 w-96 rounded-full bg-indigo-200/40 blur-3xl" />
        <div className="pointer-events-none absolute -left-32 top-32 h-96 w-96 rounded-full bg-violet-200/40 blur-3xl" />
        <div className="mx-auto max-w-6xl px-5 pb-20 pt-20 sm:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3.5 py-1.5 text-xs font-semibold text-indigo-700">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
              WhatsApp-native AI for Indian real estate
            </span>
            <h1 className="mt-6 text-4xl font-extrabold leading-[1.1] tracking-tight text-slate-900 sm:text-5xl md:text-6xl">
              Every lead answered in 30 seconds.
              <br className="hidden sm:block" />
              <span className="bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">
                {' '}
                Every buyer qualified. Every follow-up kept.
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-slate-600">
              GoSumo Realty is the AI lead manager that replies instantly, qualifies buyers on
              Budget-Location-Timeline-Configuration, books site visits and nurtures every prospect
              for 90 days — so you never lose a deal to a slow follow-up again.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/register"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-7 py-3.5 text-base font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 sm:w-auto"
              >
                Start free trial
                <ArrowRight className="h-5 w-5" />
              </Link>
              <a
                href="#how"
                className="inline-flex w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-7 py-3.5 text-base font-semibold text-slate-700 transition-colors hover:bg-slate-50 sm:w-auto"
              >
                See how it works
              </a>
            </div>
            <p className="mt-4 text-sm text-slate-400">No credit card required · Live in minutes</p>
          </div>
        </div>
      </section>

      {/* Features — the Five Jobs */}
      <section id="features" className="border-t border-slate-100 bg-slate-50/60 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              Five jobs, done for you
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              GoSumo handles the work that costs brokers deals — the speed, the qualifying, the
              chasing — so you can focus on closing.
            </p>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-sm">
                  <f.icon className="h-5 w-5" />
                </div>
                <div className="mt-5 flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-slate-900">{f.title}</h3>
                  <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                    {f.tag}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              How it works
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              From first ping to signed deal — three steps, most of them automatic.
            </p>
          </div>
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <div key={s.step} className="relative">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-lg font-bold text-white shadow-sm">
                  {s.step}
                </div>
                {i < STEPS.length - 1 && (
                  <ArrowRight className="absolute right-6 top-3 hidden h-6 w-6 text-slate-300 md:block lg:right-4" />
                )}
                <h3 className="mt-5 text-lg font-semibold text-slate-900">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-slate-100 bg-slate-50/60 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              Simple, transparent pricing
            </h2>
            <p className="mt-4 text-lg text-slate-600">
              Pick a plan that matches your pipeline. Upgrade or downgrade any time.
            </p>
          </div>
          <div className="mt-14 grid items-start gap-6 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={
                  plan.featured
                    ? 'relative rounded-2xl border-2 border-indigo-600 bg-white p-8 shadow-lg'
                    : 'relative rounded-2xl border border-slate-200 bg-white p-8 shadow-sm'
                }
              >
                {plan.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white">
                    Most popular
                  </span>
                )}
                <h3 className="text-lg font-semibold text-slate-900">{plan.name}</h3>
                <p className="mt-1 text-sm text-slate-500">{plan.tagline}</p>
                <div className="mt-5 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold tracking-tight text-slate-900">
                    ₹{plan.price}
                  </span>
                  <span className="text-sm font-medium text-slate-500">/mo</span>
                </div>
                <Link
                  href="/register"
                  className={
                    plan.featured
                      ? 'mt-6 inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500'
                      : 'mt-6 inline-flex w-full items-center justify-center rounded-lg border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50'
                  }
                >
                  Start free trial
                </Link>
                <ul className="mt-7 space-y-3">
                  {plan.features.map((feat) => (
                    <li key={feat} className="flex items-start gap-2.5 text-sm text-slate-600">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
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
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-800 px-8 py-14 text-center shadow-lg">
            <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/10 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-20 -left-12 h-64 w-64 rounded-full bg-violet-400/20 blur-3xl" />
            <h2 className="relative text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Stop losing deals to slow follow-ups.
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-lg text-indigo-100">
              Let GoSumo answer, qualify and nurture every lead — while you close.
            </p>
            <Link
              href="/register"
              className="relative mt-8 inline-flex items-center gap-2 rounded-lg bg-white px-7 py-3.5 text-base font-semibold text-indigo-700 shadow-sm transition-colors hover:bg-indigo-50"
            >
              Start free trial
              <ArrowRight className="h-5 w-5" />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-5 py-10 sm:flex-row">
          <Logo className="[&_span]:text-slate-900" />
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-slate-500">
            <a href="#features" className="transition-colors hover:text-slate-900">
              Features
            </a>
            <a href="#how" className="transition-colors hover:text-slate-900">
              How it works
            </a>
            <a href="#pricing" className="transition-colors hover:text-slate-900">
              Pricing
            </a>
            <Link href="/login" className="transition-colors hover:text-slate-900">
              Sign in
            </Link>
            <Link href="/register" className="transition-colors hover:text-slate-900">
              Start free trial
            </Link>
          </nav>
          <p className="text-sm text-slate-400">
            © {year} GoSumo. All rights reserved.
            <span className="mx-1.5">·</span>
            A{' '}
            <a
              href="https://doaide.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium transition-colors hover:text-slate-900"
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
