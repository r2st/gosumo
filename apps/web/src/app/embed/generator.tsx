'use client';

import { useState } from 'react';
import { ShareButtons } from '@/components/share-buttons';

const POSITIONS = ['bottom-right', 'bottom-left'] as const;
const THEMES = ['dark', 'light', 'auto'] as const;

export function EmbedGenerator() {
  const [position, setPosition] = useState<(typeof POSITIONS)[number]>('bottom-right');
  const [theme, setTheme] = useState<(typeof THEMES)[number]>('dark');
  const [brandColor, setBrandColor] = useState('#F0B429');
  const [greeting, setGreeting] = useState('Hi! How can we help?');
  const [copied, setCopied] = useState(false);

  const snippet = `<script
  src="https://gosumo.aiknol.com/widget.js"
  data-position="${position}"
  data-theme="${theme}"
  data-color="${brandColor}"
  data-greeting="${greeting}"
  async
><\/script>`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-[var(--doaide-text)] mb-2" style={{ fontFamily: 'var(--doaide-font-display)' }}>
        Embed Widget Generator
      </h1>
      <p className="text-[var(--doaide-text-secondary)] mb-8">
        Add AI-powered customer support to your website. Customize the widget below and copy the code snippet.
      </p>

      <div className="space-y-6">
        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)] space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--doaide-text-secondary)] mb-2">Position</label>
            <div className="flex gap-2">
              {POSITIONS.map((p) => (
                <button key={p} onClick={() => setPosition(p)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${position === p ? 'bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)]' : 'bg-[var(--doaide-bg)] text-[var(--doaide-text-secondary)] border border-[var(--doaide-border)]'}`}>
                  {p.replace('-', ' ')}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--doaide-text-secondary)] mb-2">Theme</label>
            <div className="flex gap-2">
              {THEMES.map((t) => (
                <button key={t} onClick={() => setTheme(t)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${theme === t ? 'bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)]' : 'bg-[var(--doaide-bg)] text-[var(--doaide-text-secondary)] border border-[var(--doaide-border)]'}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--doaide-text-secondary)] mb-2">Brand Color</label>
            <div className="flex items-center gap-3">
              <input type="color" value={brandColor} onChange={(e) => setBrandColor(e.target.value)} className="w-10 h-10 rounded cursor-pointer border-0 p-0" />
              <input type="text" value={brandColor} onChange={(e) => setBrandColor(e.target.value)} className="w-28 px-3 py-2 rounded-md text-sm font-mono" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--doaide-text-secondary)] mb-2">Greeting Message</label>
            <input type="text" value={greeting} onChange={(e) => setGreeting(e.target.value)} className="w-full px-3 py-2 rounded-md text-sm" />
          </div>
        </div>

        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)]">Embed Code</h2>
            <button onClick={copy} className="px-3 py-1.5 rounded-md text-sm font-medium bg-[var(--doaide-gold)] text-[var(--doaide-text-on-gold)] hover:bg-[var(--doaide-gold-hover)]">
              {copied ? 'Copied!' : 'Copy Code'}
            </button>
          </div>
          <pre className="p-4 rounded-lg bg-[var(--doaide-bg)] text-sm text-[var(--doaide-text-secondary)] overflow-x-auto font-mono whitespace-pre-wrap">{snippet}</pre>
        </div>

        <div className="p-6 rounded-xl border border-[var(--doaide-border)] bg-[var(--doaide-surface)]">
          <h2 className="text-sm font-medium text-[var(--doaide-text-secondary)] mb-3">Preview</h2>
          <div className="relative h-64 rounded-lg bg-[var(--doaide-bg)] border border-[var(--doaide-border)] overflow-hidden">
            <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--doaide-text-muted)]">Your website content</div>
            <div className={`absolute ${position === 'bottom-right' ? 'right-4' : 'left-4'} bottom-4`}>
              <div className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg cursor-pointer" style={{ backgroundColor: brandColor }}>
                <svg viewBox="0 0 24 24" width="24" height="24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>
              </div>
            </div>
          </div>
        </div>

        <ShareButtons url="https://gosumo.aiknol.com/embed" title="GoSumo Realty Embed Widget Generator" />
      </div>
    </div>
  );
}
