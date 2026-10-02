'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { GoogleButton } from '@/components/google-button';
import { useAuth } from '@/providers/auth-provider';
import { ApiError } from '@/lib/api-client';

/* ── Channel badges ── */

const CHANNELS = [
  { name: 'WhatsApp', color: '#25D366' },
  { name: 'Instagram', color: '#E1306C' },
  { name: 'SMS', color: '#5B6ABF' },
  { name: 'Web Chat', color: '#F0B429' },
  { name: 'Email', color: '#4A90D9' },
] as const;

/* ── Feature highlights ── */

const FEATURES = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    label: '30s response',
    desc: 'Every lead answered instantly',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />
      </svg>
    ),
    label: 'BLTC scoring',
    desc: 'Budget, Location, Timeline, Config',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /><path d="M8 14h.01" /><path d="M12 14h.01" /><path d="M16 14h.01" /><path d="M8 18h.01" /><path d="M12 18h.01" />
      </svg>
    ),
    label: 'Auto site visits',
    desc: 'Booked, confirmed & reminded',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
        <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    ),
    label: '90-day nurture',
    desc: 'No lead ever goes cold',
  },
] as const;

/* ── Wave decoration ── */

function WaveDecoration() {
  return (
    <div className="landing-wave" aria-hidden="true">
      <svg viewBox="0 0 1440 200" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M0,120 C240,180 480,60 720,120 C960,180 1200,60 1440,120 L1440,200 L0,200Z"
          fill="rgba(240,180,41,0.06)"
        />
        <path
          d="M0,150 C360,90 720,200 1080,140 C1260,110 1380,170 1440,160 L1440,200 L0,200Z"
          fill="rgba(240,180,41,0.04)"
        />
      </svg>
    </div>
  );
}

/* ── Floating robot SVG ── */

function FloatingRobot() {
  return (
    <div className="landing-robot-wrap" aria-hidden="true">
      <div className="landing-robot-glow" />
      <svg viewBox="0 0 200 200" className="landing-robot">
        <defs>
          <linearGradient id="lr-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#F0B429" />
            <stop offset="100%" stopColor="#D4A017" />
          </linearGradient>
          <filter id="lr-glow">
            <feGaussianBlur stdDeviation="2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <line x1="100" y1="42" x2="100" y2="27" stroke="#F0B429" strokeWidth="3" strokeLinecap="round" />
        <circle cx="100" cy="24" r="5" fill="#F0B429" filter="url(#lr-glow)">
          <animate attributeName="opacity" values="1;0.5;1" dur="2s" repeatCount="indefinite" />
        </circle>
        <circle cx="100" cy="24" r="2.5" fill="#F7CC5F" />
        <rect x="55" y="45" width="90" height="75" rx="18" fill="url(#lr-bg)" />
        <rect x="65" y="54" width="70" height="58" rx="13" fill="#D4A017" opacity="0.4" />
        <ellipse cx="82" cy="78" rx="9" ry="10" fill="#1A1A2E" />
        <ellipse cx="118" cy="78" rx="9" ry="10" fill="#1A1A2E" />
        <circle cx="85" cy="76" r="4" fill="#F7CC5F" />
        <circle cx="121" cy="76" r="4" fill="#F7CC5F" />
        <circle cx="87" cy="74" r="1.5" fill="white" opacity="0.8" />
        <circle cx="123" cy="74" r="1.5" fill="white" opacity="0.8" />
        <path d="M85 98Q100 112 115 98" stroke="#1A1A2E" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        <rect x="46" y="68" width="11" height="23" rx="4" fill="#D4A017" />
        <rect x="143" y="68" width="11" height="23" rx="4" fill="#D4A017" />
        <rect x="88" y="120" width="25" height="8" rx="3" fill="#D4A017" />
        <rect x="70" y="128" width="60" height="30" rx="10" fill="url(#lr-bg)" />
        <circle cx="100" cy="141" r="4" fill="#1A1A2E" />
        <circle cx="100" cy="141" r="2" fill="#1A1A2E" />
        <path d="M70 136Q55 139 52 148Q49 157 57 160" stroke="#D4A017" strokeWidth="5" fill="none" strokeLinecap="round" />
        <circle cx="57" cy="162" r="4" fill="#D4A017" />
        <path d="M130 136Q145 139 148 148Q151 157 143 160" stroke="#D4A017" strokeWidth="5" fill="none" strokeLinecap="round" />
        <circle cx="143" cy="162" r="4" fill="#D4A017" />
        <rect x="138" y="148" width="32" height="22" rx="6" fill="#F0B429" stroke="#1A1A2E" strokeWidth="1.5" />
        <path d="M145 170L142 177L150 170" fill="#F0B429" stroke="#1A1A2E" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="148" cy="157" r="2" fill="#1A1A2E" />
        <circle cx="154" cy="157" r="2" fill="#1A1A2E" />
        <circle cx="160" cy="157" r="2" fill="#1A1A2E" />
      </svg>
    </div>
  );
}

/* ── Auth form (embedded) ── */

type AuthTab = 'signup' | 'login';

function AuthCard() {
  const router = useRouter();
  const { login, register, status } = useAuth();
  const [tab, setTab] = useState<AuthTab>('signup');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [businessName, setBusinessName] = useState('');
  const [name, setName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
  }, [status, router]);

  const switchTab = useCallback((t: AuthTab) => {
    setTab(t);
    setError(null);
  }, []);

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const ok = await register({
        businessName,
        name,
        email: signupEmail,
        password: signupPassword,
      });
      router.replace(ok ? '/dashboard' : '/login');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to create your account. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const ok = await login(loginEmail, loginPassword);
      if (ok) {
        router.replace('/dashboard');
      } else {
        setError('Two-factor authentication is required for this account.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Unable to sign in. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="landing-auth-card">
      <div className="landing-auth-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'signup'}
          className={`landing-auth-tab ${tab === 'signup' ? 'landing-auth-tab--active' : ''}`}
          onClick={() => switchTab('signup')}
          type="button"
        >
          Sign Up
        </button>
        <button
          role="tab"
          aria-selected={tab === 'login'}
          className={`landing-auth-tab ${tab === 'login' ? 'landing-auth-tab--active' : ''}`}
          onClick={() => switchTab('login')}
          type="button"
        >
          Log In
        </button>
      </div>

      {tab === 'signup' && (
        <form onSubmit={handleSignup} className="doaide-auth-form landing-auth-fade" key="signup">
          <div className="doaide-auth-field">
            <label htmlFor="landing-biz" className="doaide-auth-label">Business name</label>
            <input id="landing-biz" required value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Sharma Realty" className="doaide-auth-input" />
          </div>
          <div className="doaide-auth-field">
            <label htmlFor="landing-name" className="doaide-auth-label">Your name</label>
            <input id="landing-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Priya Sharma" className="doaide-auth-input" />
          </div>
          <div className="doaide-auth-field">
            <label htmlFor="landing-signup-email" className="doaide-auth-label">Email</label>
            <input id="landing-signup-email" type="email" autoComplete="email" required value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} placeholder="you@business.com" className="doaide-auth-input" />
          </div>
          <div className="doaide-auth-field">
            <label htmlFor="landing-signup-pw" className="doaide-auth-label">Password</label>
            <input id="landing-signup-pw" type="password" autoComplete="new-password" required minLength={8} value={signupPassword} onChange={(e) => setSignupPassword(e.target.value)} placeholder="At least 8 characters" className="doaide-auth-input" />
          </div>

          {error && <p className="doaide-auth-error" role="alert">{error}</p>}

          <button type="submit" disabled={submitting} className="doaide-auth-button">
            {submitting ? 'Creating account…' : 'Create Account'}
          </button>
        </form>
      )}

      {tab === 'login' && (
        <form onSubmit={handleLogin} className="doaide-auth-form landing-auth-fade" key="login">
          <div className="doaide-auth-field">
            <label htmlFor="landing-login-email" className="doaide-auth-label">Email</label>
            <input id="landing-login-email" type="email" autoComplete="email" required value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="you@business.com" className="doaide-auth-input" />
          </div>
          <div className="doaide-auth-field">
            <div className="doaide-auth-label-row">
              <label htmlFor="landing-login-pw" className="doaide-auth-label">Password</label>
              <Link href="/forgot-password" className="doaide-auth-link-small">Forgot?</Link>
            </div>
            <input id="landing-login-pw" type="password" autoComplete="current-password" required value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="••••••••" className="doaide-auth-input" />
          </div>

          {error && <p className="doaide-auth-error" role="alert">{error}</p>}

          <button type="submit" disabled={submitting} className="doaide-auth-button">
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      )}

      <div className="doaide-auth-divider"><span>OR</span></div>
      <GoogleButton label={tab === 'signup' ? 'Sign up with Google' : 'Continue with Google'} />
    </div>
  );
}

/* ── Landing page component ── */

export function LandingPage() {
  const year = new Date().getFullYear();

  return (
    <div className="landing-page">
      <div className="landing-orb landing-orb--gold" aria-hidden="true" />
      <div className="landing-orb landing-orb--blue" aria-hidden="true" />

      <div className="landing-layout">
        {/* Left: showcase (md+ only) */}
        <div className="landing-showcase">
          <FloatingRobot />

          <h1 className="landing-title">
            <span className="landing-title-brand">DoAide</span>{' '}
            <span className="landing-title-product">Desk</span>
          </h1>
          <p className="landing-tagline">AI-powered client management across every channel</p>
          <p className="landing-hero-desc">
            Manage customer conversations across WhatsApp, Instagram, SMS, Web Chat, and Email through a single AI-driven interface.
          </p>

          <div className="landing-channels">
            {CHANNELS.map((ch, i) => (
              <div
                key={ch.name}
                className="landing-channel"
                style={{ animationDelay: `${0.7 + i * 0.1}s` }}
              >
                <span className="landing-channel-dot" style={{ backgroundColor: ch.color }} />
                {ch.name}
              </div>
            ))}
          </div>

          <div className="landing-features">
            {FEATURES.map((f, i) => (
              <div
                key={f.label}
                className="landing-feature"
                style={{ animationDelay: `${1.2 + i * 0.15}s` }}
              >
                <div className="landing-feature-icon">{f.icon}</div>
                <div>
                  <p className="landing-feature-label">{f.label}</p>
                  <p className="landing-feature-desc">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: auth form */}
        <div className="landing-auth-side">
          {/* Mobile-only compact header */}
          <div className="landing-mobile-header">
            <svg viewBox="0 0 32 32" className="landing-mobile-robot" aria-hidden="true">
              <line x1="16" y1="6" x2="16" y2="2" stroke="#F0B429" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="16" cy="1.5" r="1.5" fill="#F0B429" />
              <rect x="5" y="6" width="22" height="17" rx="5" fill="#F0B429" />
              <ellipse cx="11" cy="13" rx="2.5" ry="3" fill="#1A1A2E" />
              <ellipse cx="21" cy="13" rx="2.5" ry="3" fill="#1A1A2E" />
              <circle cx="11.5" cy="12.5" r="1" fill="#F7CC5F" />
              <circle cx="21.5" cy="12.5" r="1" fill="#F7CC5F" />
              <path d="M12 19Q16 22 20 19" stroke="#1A1A2E" strokeWidth="1.2" fill="none" strokeLinecap="round" />
              <rect x="1" y="10" width="4" height="5" rx="2" fill="#D4A017" />
              <rect x="27" y="10" width="4" height="5" rx="2" fill="#D4A017" />
            </svg>
            <div>
              <h1 className="landing-mobile-title">
                <span className="landing-title-brand">DoAide</span>{' '}
                <span className="landing-title-product">Desk</span>
              </h1>
              <p className="landing-mobile-tagline">AI-powered client management across every channel</p>
            </div>
          </div>

          {/* Mobile-only channel badges */}
          <div className="landing-mobile-channels">
            {CHANNELS.map((ch) => (
              <div key={ch.name} className="landing-channel landing-channel--mobile">
                <span className="landing-channel-dot" style={{ backgroundColor: ch.color }} />
                {ch.name}
              </div>
            ))}
          </div>

          <AuthCard />

          {/* Mobile-only features below the fold */}
          <div className="landing-mobile-features">
            {FEATURES.map((f) => (
              <div key={f.label} className="landing-mobile-feat">
                <div className="landing-feature-icon">{f.icon}</div>
                <div>
                  <p className="landing-feature-label">{f.label}</p>
                  <p className="landing-feature-desc">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <WaveDecoration />

      <footer className="doaide-footer">
        <div className="doaide-footer-products">
          <a href="https://desk.doaide.com" className="doaide-footer-active">Desk</a>
          <a href="https://herald.doaide.com" target="_blank" rel="noopener noreferrer">Herald</a>
          <a href="https://409.doaide.com" target="_blank" rel="noopener noreferrer">409A</a>
          <a href="https://job.doaide.com" target="_blank" rel="noopener noreferrer">AutoApply</a>
          <a href="https://homenex.doaide.com" target="_blank" rel="noopener noreferrer">Realty</a>
        </div>
        <p className="doaide-footer-copy">
          © {year} DoAide Desk · AI tools for small businesses
        </p>
      </footer>
    </div>
  );
}
