'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { GoogleButton } from '@/components/google-button';
import { useAuth } from '@/providers/auth-provider';
import { friendlyError } from '@/lib/errors';

const TYPEWRITER_PHRASES = [
  'Unified inbox',
  'AI-powered responses',
  'Smart client routing',
  'Omnichannel support',
];

const TESTIMONIALS = [
  {
    quote: 'We used to miss WhatsApp messages all the time. DoAide Desk pulled everything into one inbox — response time dropped from 4 hours to under 10 minutes.',
    name: 'Meera Joshi',
    role: 'Founder, Joshi Design Studio',
    location: 'Mumbai',
  },
  {
    quote: 'Managing 50 clients across WhatsApp, email, and Instagram was chaos. Now my team of 3 handles it all from one screen. We have not lost a client to missed messages since.',
    name: 'Arjun Reddy',
    role: 'Managing Director, Reddy Consulting',
    location: 'Hyderabad',
  },
  {
    quote: 'The AI reply suggestions save me at least an hour every day. It learns my tone and my pricing — I just review and send. Game changer for a solo freelancer.',
    name: 'Kavitha Nair',
    role: 'Independent Tax Consultant',
    location: 'Kochi',
  },
  {
    quote: 'We switched from Zoho because it was built for sales teams, not service businesses. DoAide Desk understands how we actually work — conversations, not pipelines.',
    name: 'Rohit Sharma',
    role: 'Co-founder, BrightPath Tutoring',
    location: 'Pune',
  },
] as const;

const FAQ_ITEMS = [
  {
    q: 'What is DoAide Desk?',
    a: 'DoAide Desk is an AI-powered client management platform that unifies your conversations across WhatsApp, Instagram, SMS, Web Chat, and Email into a single inbox. Built for small businesses and freelancers in India.',
  },
  {
    q: 'Which messaging channels are supported?',
    a: 'DoAide Desk supports WhatsApp Business, Instagram DMs, SMS, Web Chat (embeddable widget), and Email. All conversations appear in one unified inbox.',
  },
  {
    q: 'How does the AI help with responses?',
    a: 'The AI analyzes incoming messages for intent and urgency, suggests contextual replies based on your conversation history and business context, and can auto-respond to common questions. You always review before sending.',
  },
  {
    q: 'Is DoAide Desk suitable for freelancers?',
    a: 'Yes. DoAide Desk is designed for freelancers, small agencies, and service businesses. No complex setup, no enterprise-only pricing. Connect your channels and start managing clients in minutes.',
  },
  {
    q: 'How much does it cost?',
    a: 'DoAide Desk offers a free tier to get started. Paid plans are priced for Indian businesses — significantly more affordable than enterprise CRM tools like Salesforce or HubSpot.',
  },
  {
    q: 'Can my team use it together?',
    a: 'Yes. DoAide Desk supports team collaboration with smart routing — incoming messages are automatically assigned to the right team member based on expertise, availability, and client history.',
  },
  {
    q: 'Is my data secure?',
    a: 'Yes. All data is encrypted in transit and at rest. DoAide Desk complies with Indian data protection regulations and your data stays within secure infrastructure.',
  },
  {
    q: 'How do I get started?',
    a: 'Create an account, connect your first messaging channel (usually WhatsApp Business), and start managing conversations. The entire setup takes under 10 minutes.',
  },
] as const;

const DOAIDE_PRODUCTS = [
  { name: 'Desk', url: 'https://desk.doaide.com', active: true },
  { name: 'Jobs', url: 'https://job.doaide.com' },
  { name: '409A', url: 'https://409a.doaide.com' },
  { name: 'GST', url: 'https://gst.doaide.com' },
  { name: 'Pulse', url: 'https://pulse.doaide.com' },
  { name: 'Med', url: 'https://med.doaide.com' },
  { name: 'Realty', url: 'https://realty.doaide.com' },
  { name: 'Reach', url: 'https://reach.doaide.com' },
  { name: 'Trade', url: 'https://trade.doaide.com' },
] as const;

const PIPELINE_STAGES = [
  { label: 'Receive', icon: 'inbox' },
  { label: 'Route', icon: 'filter' },
  { label: 'Respond', icon: 'send' },
  { label: 'Resolve', icon: 'check' },
] as const;

function RobotIcon({ size = 28 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width={size} height={size}>
      <line x1="16" y1="6" x2="16" y2="2" stroke="#F0B429" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="1.5" r="1.5" fill="#F0B429" />
      <rect x="5" y="6" width="22" height="17" rx="5" fill="#F0B429" />
      <ellipse cx="11" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
      <ellipse cx="21" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
      <circle cx="11.5" cy="12.5" r="1" fill="#F7CC5F" />
      <circle cx="21.5" cy="12.5" r="1" fill="#F7CC5F" />
      <path d="M12 19Q16 22 20 19" stroke="#0A0A0B" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <rect x="1" y="10" width="4" height="5" rx="2" fill="#D4A017" />
      <rect x="27" y="10" width="4" height="5" rx="2" fill="#D4A017" />
    </svg>
  );
}

function HeroRobot() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 320" className="split-hero-robot" aria-hidden="true">
      <defs>
        <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F0B429" />
          <stop offset="100%" stopColor="#D4A017" />
        </linearGradient>
      </defs>
      <line x1="200" y1="45" x2="200" y2="20" stroke="#F0B429" strokeWidth="6" strokeLinecap="round" />
      <circle cx="200" cy="14" r="10" fill="#F0B429" className="split-antenna-glow" />
      <circle cx="200" cy="14" r="5" fill="#F7CC5F" />
      <rect x="110" y="50" width="180" height="140" rx="35" fill="url(#rg)" />
      <rect x="130" y="68" width="140" height="105" rx="25" fill="#D4A017" opacity="0.4" />
      <ellipse cx="165" cy="115" rx="18" ry="20" fill="#0A0A0B" />
      <ellipse cx="235" cy="115" rx="18" ry="20" fill="#0A0A0B" />
      <circle cx="170" cy="113" r="8" fill="#F7CC5F" />
      <circle cx="240" cy="113" r="8" fill="#F7CC5F" />
      <circle cx="174" cy="109" r="3" fill="white" opacity="0.7" />
      <circle cx="244" cy="109" r="3" fill="white" opacity="0.7" />
      <path d="M170 155Q200 178 230 155" stroke="#0A0A0B" strokeWidth="4" fill="none" strokeLinecap="round" />
      <rect x="92" y="95" width="22" height="45" rx="8" fill="#D4A017" />
      <rect x="286" y="95" width="22" height="45" rx="8" fill="#D4A017" />
      <rect x="175" y="190" width="50" height="14" rx="5" fill="#D4A017" />
      <rect x="145" y="204" width="110" height="55" rx="18" fill="url(#rg)" />
      <circle cx="200" cy="228" r="7" fill="#0A0A0B" />
      <circle cx="200" cy="228" r="3.5" fill="#0A0A0B" />
      <path d="M145 218Q118 223 113 240Q108 257 120 262" stroke="#D4A017" strokeWidth="9" fill="none" strokeLinecap="round" />
      <circle cx="120" cy="265" r="7" fill="#D4A017" />
      <path d="M255 218Q282 223 287 240Q292 257 280 262" stroke="#D4A017" strokeWidth="9" fill="none" strokeLinecap="round" />
      <circle cx="280" cy="265" r="7" fill="#D4A017" />
    </svg>
  );
}

function PipelineStageIcon({ icon }: { icon: string }) {
  const paths: Record<string, JSX.Element> = {
    inbox: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M3 7l9 5 9-5" stroke="currentColor" strokeWidth="1.5" fill="none" />
      </>
    ),
    filter: (
      <>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M8 9h8M9 12h6M10 15h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </>
    ),
    send: (
      <>
        <path d="M22 2L11 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" />
      </>
    ),
    check: (
      <>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M8 12l3 3 5-6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" className="split-pipeline-icon">
      {paths[icon]}
    </svg>
  );
}

function PipelineGraphic() {
  return (
    <div className="split-pipeline">
      {PIPELINE_STAGES.map((stage, i) => (
        <div key={stage.label} className="split-pipeline-step" style={{ animationDelay: `${0.8 + i * 0.15}s` }}>
          <div className="split-pipeline-node">
            <PipelineStageIcon icon={stage.icon} />
          </div>
          <span className="split-pipeline-label">{stage.label}</span>
          {i < PIPELINE_STAGES.length - 1 && (
            <div className="split-pipeline-connector" style={{ animationDelay: `${1.2 + i * 0.15}s` }}>
              <div className="split-pipeline-line" />
              <div className="split-pipeline-particle" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TypewriterText() {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const phrase = TYPEWRITER_PHRASES[phraseIndex];
    const timeout = deleting ? 30 : 60;

    if (!deleting && charIndex === phrase.length) {
      const pause = setTimeout(() => setDeleting(true), 2000);
      return () => clearTimeout(pause);
    }

    if (deleting && charIndex === 0) {
      setDeleting(false);
      setPhraseIndex((i) => (i + 1) % TYPEWRITER_PHRASES.length);
      return;
    }

    const timer = setTimeout(() => {
      setCharIndex((c) => c + (deleting ? -1 : 1));
    }, timeout);
    return () => clearTimeout(timer);
  }, [charIndex, deleting, phraseIndex]);

  return (
    <span className="split-typewriter">
      {TYPEWRITER_PHRASES[phraseIndex].slice(0, charIndex)}
      <span className="split-typewriter-cursor" />
    </span>
  );
}

function ParticleBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const particles: { x: number; y: number; vx: number; vy: number; r: number; o: number }[] = [];

    function resize() {
      canvas!.width = window.innerWidth;
      canvas!.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < 40; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5,
        o: Math.random() * 0.4 + 0.1,
      });
    }

    function draw() {
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = canvas!.width;
        if (p.x > canvas!.width) p.x = 0;
        if (p.y < 0) p.y = canvas!.height;
        if (p.y > canvas!.height) p.y = 0;
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(240, 180, 41, ${p.o})`;
        ctx!.fill();
      }
      animId = requestAnimationFrame(draw);
    }
    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="split-particles" />;
}

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: 'var(--doaide-surface)', border: '1px solid var(--doaide-border)', borderRadius: 'var(--doaide-radius-lg)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--doaide-text)', fontWeight: 500, fontSize: '0.9rem', textAlign: 'left',
          fontFamily: 'var(--doaide-font)',
        }}
        aria-expanded={open}
      >
        <span style={{ paddingRight: 16 }}>{question}</span>
        <span style={{ color: 'var(--doaide-gold)', fontSize: '1.2rem', flexShrink: 0 }}>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 20px 16px', color: 'var(--doaide-text-secondary)', fontSize: '0.85rem', lineHeight: 1.6, borderTop: '1px solid var(--doaide-border)' }}>
          <p style={{ marginTop: 12 }}>{answer}</p>
        </div>
      )}
    </div>
  );
}

function AuthTabs({ tab, onTabChange }: { tab: 'signin' | 'register'; onTabChange: (t: 'signin' | 'register') => void }) {
  return (
    <div className="split-auth-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'signin'}
        className={`split-auth-tab ${tab === 'signin' ? 'split-auth-tab-active' : ''}`}
        onClick={() => onTabChange('signin')}
      >
        Sign in
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'register'}
        className={`split-auth-tab ${tab === 'register' ? 'split-auth-tab-active' : ''}`}
        onClick={() => onTabChange('register')}
      >
        Create account
      </button>
    </div>
  );
}

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const ok = await login(email, password);
      if (ok) {
        router.replace(params?.get('next') ?? '/dashboard');
      } else {
        setError('Two-factor authentication is required for this account.');
      }
    } catch (err) {
      setError(friendlyError(err, 'Unable to sign in. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="split-auth-form">
      <div className="split-auth-field">
        <label htmlFor="signin-email" className="split-auth-label">Email</label>
        <input
          id="signin-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@business.com"
          className="split-auth-input"
        />
      </div>
      <div className="split-auth-field">
        <div className="split-auth-label-row">
          <label htmlFor="signin-password" className="split-auth-label">Password</label>
          <a href="/forgot-password" className="split-auth-forgot">Forgot?</a>
        </div>
        <input
          id="signin-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="split-auth-input"
        />
      </div>

      {error && <p className="split-auth-error">{error}</p>}

      <button type="submit" disabled={submitting} className="split-auth-submit">
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>

      <div className="split-auth-divider"><span>OR</span></div>

      <GoogleButton />
    </form>
  );
}

function RegisterForm() {
  const router = useRouter();
  const { register } = useAuth();
  const [form, setForm] = useState({ businessName: '', name: '', email: '', phone: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const ok = await register({
        businessName: form.businessName,
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone || undefined,
      });
      router.replace(ok ? '/dashboard' : '/login');
    } catch (err) {
      setError(friendlyError(err, 'Unable to create your account. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="split-auth-form">
      <div className="split-auth-field">
        <label htmlFor="reg-business" className="split-auth-label">Business name</label>
        <input id="reg-business" required value={form.businessName} onChange={update('businessName')} placeholder="Sharma Realty" className="split-auth-input" />
      </div>
      <div className="split-auth-field">
        <label htmlFor="reg-name" className="split-auth-label">Your name</label>
        <input id="reg-name" required value={form.name} onChange={update('name')} placeholder="Priya Sharma" className="split-auth-input" />
      </div>
      <div className="split-auth-row">
        <div className="split-auth-field">
          <label htmlFor="reg-email" className="split-auth-label">Email</label>
          <input id="reg-email" type="email" required value={form.email} onChange={update('email')} placeholder="you@business.com" className="split-auth-input" />
        </div>
        <div className="split-auth-field">
          <label htmlFor="reg-phone" className="split-auth-label">Phone</label>
          <input id="reg-phone" type="tel" value={form.phone} onChange={update('phone')} placeholder="+91 98765 43210" className="split-auth-input" />
        </div>
      </div>
      <div className="split-auth-field">
        <label htmlFor="reg-password" className="split-auth-label">Password</label>
        <input id="reg-password" type="password" required minLength={8} value={form.password} onChange={update('password')} placeholder="At least 8 characters" className="split-auth-input" />
      </div>

      {error && <p className="split-auth-error">{error}</p>}

      <button type="submit" disabled={submitting} className="split-auth-submit">
        {submitting ? 'Creating account…' : 'Create account'}
      </button>

      <div className="split-auth-divider"><span>OR</span></div>

      <GoogleButton label="Sign up with Google" />
    </form>
  );
}

function AuthPanel() {
  const [tab, setTab] = useState<'signin' | 'register'>('signin');

  return (
    <div className="split-auth-card">
      <AuthTabs tab={tab} onTabChange={setTab} />
      <div className="split-auth-card-body">
        {tab === 'signin' ? (
          <Suspense fallback={null}><SignInForm /></Suspense>
        ) : (
          <RegisterForm />
        )}
      </div>
    </div>
  );
}

export function LandingPage() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  return (
    <div className="split-root">
      <ParticleBackground />

      {/* Header */}
      <header className={`split-header ${visible ? 'split-visible' : ''}`}>
        <a href="https://doaide.com" className="split-brand">
          <RobotIcon size={28} />
          <span className="split-brand-text">
            DoAide <em>Desk</em>
          </span>
        </a>
      </header>

      {/* Main split layout */}
      <main className={`split-main ${visible ? 'split-visible' : ''}`}>
        {/* Left panel — product info */}
        <div className="split-left">
          <div className="split-left-content">
            <div className="split-hero-robot-wrap">
              <HeroRobot />
            </div>

            <h1 className="split-headline">
              Client conversations, unified.
            </h1>

            <p className="split-subtitle">
              AI-powered client management across WhatsApp, Instagram, SMS, Web Chat, and Email.
            </p>

            <div className="split-typewriter-wrap">
              <TypewriterText />
            </div>

            <PipelineGraphic />
          </div>
        </div>

        {/* Right panel — auth form */}
        <div className="split-right">
          <AuthPanel />
        </div>
      </main>

      {/* Social Proof — Testimonials */}
      <section className="split-below-fold" style={{ background: 'var(--doaide-bg-alt)', padding: '64px 24px' }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <h2 style={{ fontFamily: 'var(--doaide-font-display)', fontSize: '2rem', color: 'var(--doaide-text)', textAlign: 'center', marginBottom: 8 }}>
            Trusted by businesses across India
          </h2>
          <p style={{ textAlign: 'center', color: 'var(--doaide-text-muted)', marginBottom: 40, fontSize: '0.95rem' }}>
            Freelancers, agencies, and service businesses managing clients with DoAide Desk.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
            {TESTIMONIALS.map((t) => (
              <div key={t.name} style={{ background: 'var(--doaide-surface)', border: '1px solid var(--doaide-border)', borderRadius: 'var(--doaide-radius-lg)', padding: 24 }}>
                <p style={{ color: 'var(--doaide-text-secondary)', fontSize: '0.9rem', lineHeight: 1.6, fontStyle: 'italic', marginBottom: 16 }}>
                  &ldquo;{t.quote}&rdquo;
                </p>
                <p style={{ color: 'var(--doaide-text)', fontWeight: 600, fontSize: '0.85rem', marginBottom: 2 }}>{t.name}</p>
                <p style={{ color: 'var(--doaide-text-muted)', fontSize: '0.8rem' }}>{t.role} · {t.location}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ with JSON-LD */}
      <section style={{ padding: '64px 24px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h2 style={{ fontFamily: 'var(--doaide-font-display)', fontSize: '2rem', color: 'var(--doaide-text)', textAlign: 'center', marginBottom: 8 }}>
            Frequently asked questions
          </h2>
          <p style={{ textAlign: 'center', color: 'var(--doaide-text-muted)', marginBottom: 40, fontSize: '0.95rem' }}>
            Everything you need to know about DoAide Desk.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {FAQ_ITEMS.map((item, i) => (
              <FAQItem key={i} question={item.q} answer={item.a} />
            ))}
          </div>
        </div>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: FAQ_ITEMS.map((item) => ({
                '@type': 'Question',
                name: item.q,
                acceptedAnswer: { '@type': 'Answer', text: item.a },
              })),
            }),
          }}
        />
      </section>

      {/* CTA */}
      <section style={{ background: 'var(--doaide-bg-alt)', padding: '64px 24px', textAlign: 'center' }}>
        <h2 style={{ fontFamily: 'var(--doaide-font-display)', fontSize: '2rem', color: 'var(--doaide-text)', marginBottom: 12 }}>
          Stop losing clients to missed messages
        </h2>
        <p style={{ color: 'var(--doaide-text-secondary)', maxWidth: 480, margin: '0 auto 24px', fontSize: '0.95rem' }}>
          Unify every conversation. Let AI handle the routine. Focus on what matters — your clients.
        </p>
        <a
          href="/"
          style={{
            display: 'inline-block',
            padding: '12px 32px',
            background: 'var(--doaide-gold)',
            color: 'var(--doaide-text-on-gold)',
            borderRadius: 'var(--doaide-radius-md)',
            fontWeight: 600,
            fontSize: '0.95rem',
            textDecoration: 'none',
          }}
        >
          Start Free — No Credit Card Required
        </a>
      </section>

      {/* Footer */}
      <footer className="split-footer">
        <div className="doaide-footer-products">
          {DOAIDE_PRODUCTS.map((p) => (
            <a
              key={p.name}
              href={p.url}
              className={p.active ? 'doaide-footer-active' : ''}
            >
              {p.name}
            </a>
          ))}
        </div>
        <div className="doaide-footer-copy">
          <a href="https://doaide.com" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <RobotIcon size={14} />
            doaide.com
          </a>
          {' · '}
          © {new Date().getFullYear()} DoAide
        </div>
      </footer>
    </div>
  );
}
