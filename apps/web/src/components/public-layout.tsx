import Link from 'next/link';

export function PublicNav() {
  return (
    <nav className="border-b border-[var(--da-border)] bg-[var(--da-bg)]">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 min-h-14 flex items-center justify-between gap-2">
        <Link href="/" className="flex items-center gap-2 font-bold text-[var(--da-primary)] no-underline">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="24" height="24">
            <rect width="32" height="32" rx="8" fill="#0D9488" />
            <text x="16" y="22" textAnchor="middle" fill="#FFFFFF" fontSize="18" fontWeight="700" fontFamily="Inter, system-ui, sans-serif">D</text>
          </svg>
          <span><span className="text-[var(--da-primary)]">DoAide</span> <span className="text-[var(--da-text-muted)] font-light">|</span> Desk</span>
        </Link>
        <div className="flex items-center gap-1 sm:gap-6 text-sm">
          <Link href="/about" className="hidden sm:inline text-[var(--da-text-secondary)] hover:text-[var(--da-primary)] no-underline transition-colors">About</Link>
          <Link href="/tools" className="inline-flex min-h-12 items-center px-2 sm:px-0 sm:min-h-0 text-[var(--da-text-secondary)] hover:text-[var(--da-primary)] no-underline transition-colors">Free Tools</Link>
          <Link href="/blog" className="hidden sm:inline text-[var(--da-text-secondary)] hover:text-[var(--da-primary)] no-underline transition-colors">Blog</Link>
          <Link href="/embed" className="hidden sm:inline text-[var(--da-text-secondary)] hover:text-[var(--da-primary)] no-underline transition-colors">Embed</Link>
          <Link href="/support" className="inline-flex min-h-12 items-center px-2 sm:px-0 sm:min-h-0 text-[var(--da-text-secondary)] hover:text-[var(--da-primary)] no-underline transition-colors">Support</Link>
          <Link href="/" className="inline-flex min-h-12 sm:min-h-0 items-center px-4 py-1.5 rounded-md text-sm font-medium bg-[var(--da-primary)] text-[var(--da-text-on-primary)] hover:bg-[var(--da-primary-hover)] no-underline transition-colors">Get Started</Link>
        </div>
      </div>
    </nav>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-[var(--da-border)] mt-16 py-8">
      <div className="max-w-5xl mx-auto px-6">
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 mb-6 text-xs uppercase tracking-wider text-[var(--da-text-muted)]">
          <a href="https://desk.doaide.com" className="text-[var(--da-primary)] no-underline">Desk</a>
          <a href="https://job.doaide.com" className="hover:text-[var(--da-primary)] no-underline transition-colors">Jobs</a>
          <a href="https://409.doaide.com" className="hover:text-[var(--da-primary)] no-underline transition-colors">409A</a>
          <a href="https://gst.doaide.com" className="hover:text-[var(--da-primary)] no-underline transition-colors">GST</a>
          <a href="https://pulse.doaide.com" className="hover:text-[var(--da-primary)] no-underline transition-colors">Pulse</a>
          <a href="https://med.doaide.com" className="hover:text-[var(--da-primary)] no-underline transition-colors">Med</a>
          <a href="https://realty.doaide.com" className="hover:text-[var(--da-primary)] no-underline transition-colors">Realty</a>
        </div>
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[var(--da-text-muted)]">
          <p>A DoAide Product · &copy; {new Date().getFullYear()} Apprend Technologies</p>
          <div className="flex items-center gap-6">
            <Link href="/about" className="hover:text-[var(--da-primary)] no-underline transition-colors">About</Link>
            <Link href="/tools" className="hover:text-[var(--da-primary)] no-underline transition-colors">Free Tools</Link>
            <Link href="/blog" className="hover:text-[var(--da-primary)] no-underline transition-colors">Blog</Link>
            <Link href="/embed" className="hover:text-[var(--da-primary)] no-underline transition-colors">Widget</Link>
            <a href="https://doaide.com" className="hover:text-[var(--da-primary)] no-underline transition-colors">DoAide</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
