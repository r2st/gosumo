import Link from 'next/link';

export function PublicNav() {
  return (
    <nav className="border-b border-[var(--doaide-border)] bg-[var(--doaide-bg)]">
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-semibold text-[var(--doaide-gold)] no-underline">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="24" height="24">
            <rect x="5" y="6" width="22" height="17" rx="5" fill="#F0B429" />
            <ellipse cx="11" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
            <ellipse cx="21" cy="13" rx="2.5" ry="3" fill="#0A0A0B" />
            <path d="M12 19Q16 22 20 19" stroke="#0A0A0B" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          </svg>
          GoSumo Realty
        </Link>
        <div className="flex items-center gap-6 text-sm">
          <Link href="/about" className="text-[var(--doaide-text-secondary)] hover:text-[var(--doaide-gold)] no-underline transition-colors">About</Link>
          <Link href="/tools" className="text-[var(--doaide-text-secondary)] hover:text-[var(--doaide-gold)] no-underline transition-colors">Free Tools</Link>
          <Link href="/blog" className="text-[var(--doaide-text-secondary)] hover:text-[var(--doaide-gold)] no-underline transition-colors">Blog</Link>
          <Link href="/embed" className="text-[var(--doaide-text-secondary)] hover:text-[var(--doaide-gold)] no-underline transition-colors">Embed</Link>
          <Link href="/" className="px-4 py-1.5 rounded-md text-sm font-medium bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)] hover:bg-[var(--doaide-gold-hover)] no-underline transition-colors">Get Started</Link>
        </div>
      </div>
    </nav>
  );
}

export function PublicFooter() {
  return (
    <footer className="border-t border-[var(--doaide-border)] mt-16 py-8">
      <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[var(--doaide-text-muted)]">
        <p>&copy; {new Date().getFullYear()} Apprend Technologies. All rights reserved.</p>
        <div className="flex items-center gap-6">
          <Link href="/about" className="hover:text-[var(--doaide-gold)] no-underline transition-colors">About</Link>
          <Link href="/tools" className="hover:text-[var(--doaide-gold)] no-underline transition-colors">Free Tools</Link>
          <Link href="/blog" className="hover:text-[var(--doaide-gold)] no-underline transition-colors">Blog</Link>
          <Link href="/embed" className="hover:text-[var(--doaide-gold)] no-underline transition-colors">Widget</Link>
          <a href="https://doaide.com" className="hover:text-[var(--doaide-gold)] no-underline transition-colors">DoAide</a>
        </div>
      </div>
    </footer>
  );
}
