'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

const DESK_CONFIG = {
  name: 'Desk',
  tagline: 'All your conversations, one inbox.',
  accentColor: '#F0B429',
  accentColorDark: '#D4A017',
  loginPath: '/login',
  registerPath: '/register',
  features: [
    { icon: '\u{1F4AC}', title: 'Unified Inbox' },
    { icon: '\u{1F916}', title: 'AI Replies' },
    { icon: '\u{1F4F1}', title: 'All Channels' },
    { icon: '\u{1F4C8}', title: 'Insights' },
  ],
} as const;

const DOAIDE_PRODUCTS = [
  { name: 'Desk', url: 'https://desk.doaide.com' },
  { name: 'Jobs', url: 'https://job.doaide.com' },
  { name: '409A', url: 'https://409a.doaide.com' },
  { name: 'GST', url: 'https://gst.doaide.com' },
  { name: 'Pulse', url: 'https://pulse.doaide.com' },
  { name: 'Med', url: 'https://med.doaide.com' },
  { name: 'Realty', url: 'https://realty.doaide.com' },
  { name: 'Reach', url: 'https://reach.doaide.com' },
  { name: 'Trade', url: 'https://trade.doaide.com' },
] as const;

function RobotFace({ size = 32, color }: { size?: number; color: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width={size} height={size}>
      <line x1="16" y1="6" x2="16" y2="2" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="16" cy="1.5" r="1.5" fill={color} />
      <rect x="5" y="6" width="22" height="17" rx="5" fill={color} />
      <ellipse cx="11" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
      <ellipse cx="21" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
      <circle cx="11.5" cy="12.5" r="1" fill={color} opacity="0.6" />
      <circle cx="21.5" cy="12.5" r="1" fill={color} opacity="0.6" />
      <path d="M12 19Q16 22 20 19" stroke="#0A0A0B" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <rect x="1" y="10" width="4" height="5" rx="2" fill={color} opacity="0.8" />
      <rect x="27" y="10" width="4" height="5" rx="2" fill={color} opacity="0.8" />
    </svg>
  );
}

function HeroRobot({ color }: { color: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100" width="120" height="100" className="landing-hero-robot">
      <line x1="60" y1="18" x2="60" y2="6" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="60" cy="4" r="3" fill={color} className="landing-antenna-glow" />
      <rect x="25" y="18" width="70" height="55" rx="16" fill={color} />
      <ellipse cx="42" cy="40" rx="8" ry="10" fill="#0A0A0B" />
      <ellipse cx="78" cy="40" rx="8" ry="10" fill="#0A0A0B" />
      <circle cx="44" cy="38" r="3" fill={color} opacity="0.5" />
      <circle cx="80" cy="38" r="3" fill={color} opacity="0.5" />
      <path d="M45 60 Q60 72 75 60" stroke="#0A0A0B" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <rect x="5" y="30" width="16" height="18" rx="6" fill={color} opacity="0.8" />
      <rect x="99" y="30" width="16" height="18" rx="6" fill={color} opacity="0.8" />
    </svg>
  );
}

export function LandingPage() {
  const [visible, setVisible] = useState(false);
  const c = DESK_CONFIG;

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  return (
    <div
      className="landing-root"
      style={{ '--accent': c.accentColor, '--accent-dark': c.accentColorDark } as React.CSSProperties}
    >
      <div className="landing-bg">
        <div className="landing-orb landing-orb-1" />
        <div className="landing-orb landing-orb-2" />
        <div className="landing-orb landing-orb-3" />
      </div>

      <header className={`landing-header ${visible ? 'landing-visible' : ''}`}>
        <a href="https://doaide.com" className="landing-brand">
          <RobotFace size={28} color={c.accentColor} />
          <span className="landing-brand-text">
            Do<em>Aide</em> {c.name}
          </span>
        </a>
        <div className="landing-header-actions">
          <Link href={c.loginPath} className="landing-btn-ghost">Sign in</Link>
          <Link href={c.registerPath} className="landing-btn-primary">Get started</Link>
        </div>
      </header>

      <main className={`landing-hero ${visible ? 'landing-visible' : ''}`}>
        <div className="landing-hero-robot-wrap">
          <HeroRobot color={c.accentColor} />
        </div>
        <h1 className="landing-title">{c.tagline}</h1>
        <div className="landing-cta-group">
          <Link href={c.registerPath} className="landing-btn-primary landing-btn-lg">Get started free</Link>
          <Link href={c.loginPath} className="landing-btn-ghost landing-btn-lg">Sign in</Link>
        </div>
      </main>

      <section className={`landing-features ${visible ? 'landing-visible' : ''}`}>
        {c.features.map((f, i) => (
          <div
            key={f.title}
            className="landing-feature-card"
            style={{ animationDelay: `${0.3 + i * 0.1}s` }}
          >
            <span className="landing-feature-icon">{f.icon}</span>
            <span className="landing-feature-title">{f.title}</span>
          </div>
        ))}
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-products">
          {DOAIDE_PRODUCTS.map((p) => (
            <a key={p.name} href={p.url} className="landing-footer-link">
              {p.name}
            </a>
          ))}
        </div>
        <div className="landing-footer-bottom">
          <a href="https://doaide.com" className="landing-footer-home">
            <RobotFace size={16} color={c.accentColor} />
            doaide.com
          </a>
          <span className="landing-footer-copy">© {new Date().getFullYear()} DoAide</span>
        </div>
      </footer>
    </div>
  );
}
