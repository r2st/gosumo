export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="doaide-auth-page">
      <div className="doaide-auth-container">
        {/* Logo mark */}
        <svg viewBox="0 0 32 32" style={{ width: 64, height: 64, margin: '0 auto 20px' }} aria-hidden="true">
          <rect width="32" height="32" rx="8" fill="#0D9488" />
          <text x="16" y="22" textAnchor="middle" fill="#FFFFFF" fontSize="18" fontWeight="700" fontFamily="Inter, system-ui, sans-serif">D</text>
        </svg>

        {/* Title */}
        <h1 className="doaide-auth-title">
          <span className="doaide-auth-title-brand">DoAide</span>
          <span style={{ color: 'rgba(255,255,255,0.3)', margin: '0 8px', fontWeight: 300 }}>|</span>
          <span className="doaide-auth-title-product">Desk</span>
        </h1>
        <p className="doaide-auth-subtitle">
          AI-powered lead management for real estate
        </p>

        {/* Card */}
        <div className="doaide-auth-card">
          {children}
        </div>

        <p className="doaide-auth-footer">
          A DoAide Product · © {new Date().getFullYear()}{' '}
          <a href="https://doaide.com" target="_blank" rel="noopener noreferrer">DoAide</a>
        </p>
      </div>
    </div>
  );
}
