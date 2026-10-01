export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="doaide-auth-page">
      <div className="doaide-auth-container">
        {/* Robot logo */}
        <svg viewBox="0 0 400 320" className="doaide-auth-robot" aria-hidden="true">
          <defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#F0B429"/><stop offset="100%" stopColor="#D4A017"/></linearGradient></defs>
          <line x1="200" y1="45" x2="200" y2="20" stroke="#F0B429" strokeWidth="6" strokeLinecap="round"/>
          <circle cx="200" cy="14" r="10" fill="#F0B429"/><circle cx="200" cy="14" r="5" fill="#F7CC5F"/>
          <rect x="110" y="50" width="180" height="140" rx="35" fill="url(#hg)"/>
          <rect x="130" y="68" width="140" height="105" rx="25" fill="#D4A017" opacity="0.4"/>
          <ellipse cx="165" cy="115" rx="18" ry="20" fill="#0A0A0B"/><ellipse cx="235" cy="115" rx="18" ry="20" fill="#0A0A0B"/>
          <circle cx="170" cy="113" r="8" fill="#F7CC5F"/><circle cx="240" cy="113" r="8" fill="#F7CC5F"/>
          <circle cx="174" cy="109" r="3" fill="white" opacity="0.7"/><circle cx="244" cy="109" r="3" fill="white" opacity="0.7"/>
          <path d="M170 155Q200 178 230 155" stroke="#0A0A0B" strokeWidth="4" fill="none" strokeLinecap="round"/>
          <rect x="92" y="95" width="22" height="45" rx="8" fill="#D4A017"/><rect x="286" y="95" width="22" height="45" rx="8" fill="#D4A017"/>
          <rect x="175" y="190" width="50" height="14" rx="5" fill="#D4A017"/>
          <rect x="145" y="204" width="110" height="55" rx="18" fill="url(#hg)"/>
          <circle cx="200" cy="228" r="7" fill="#0A0A0B"/><circle cx="200" cy="228" r="3.5" fill="#0A0A0B"/>
          <path d="M145 218Q118 223 113 240Q108 257 120 262" stroke="#D4A017" strokeWidth="9" fill="none" strokeLinecap="round"/><circle cx="120" cy="265" r="7" fill="#D4A017"/>
          <path d="M255 218Q282 223 287 240Q292 257 280 262" stroke="#D4A017" strokeWidth="9" fill="none" strokeLinecap="round"/><circle cx="280" cy="265" r="7" fill="#D4A017"/>
        </svg>

        {/* Title */}
        <h1 className="doaide-auth-title">
          <span className="doaide-auth-title-brand">DoAide</span>{' '}
          <span className="doaide-auth-title-product">Desk</span>
        </h1>
        <p className="doaide-auth-subtitle">
          AI-powered client management across every channel
        </p>

        {/* Card */}
        <div className="doaide-auth-card">
          {children}
        </div>

        <p className="doaide-auth-footer">
          © {new Date().getFullYear()} DoAide Desk · A{' '}
          <a href="https://doaide.com" target="_blank" rel="noopener noreferrer">DoAide</a>{' '}
          product
        </p>
      </div>
    </div>
  );
}
