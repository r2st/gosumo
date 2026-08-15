'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { LANG_STORAGE_KEY, translate, type UiLang } from '@/lib/i18n';
import { writePreferenceCookie } from '@/lib/preference-cookie';

interface LanguageContextValue {
  /** Current dashboard UI language. */
  lang: UiLang;
  setLang: (lang: UiLang) => void;
  toggleLang: () => void;
  /** Translate a dot-namespaced key into the current language. */
  t: (key: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

/**
 * Render-blocking script that applies the saved UI language to <html lang> before
 * first paint. Kept dependency-free and stringified — mirrors the theme init script.
 */
export const langInitScript = `(function(){try{var k='${LANG_STORAGE_KEY}';var l=localStorage.getItem(k);if(l==='hi'||l==='en'){document.documentElement.lang=l;}}catch(e){}})();`;

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // Start from 'en' so the server render and first client render agree (no hydration
  // mismatch); the saved preference is applied in an effect right after mount.
  const [lang, setLangState] = useState<UiLang>('en');

  useEffect(() => {
    try {
      const stored = localStorage.getItem(LANG_STORAGE_KEY);
      if (stored === 'en' || stored === 'hi') setLangState(stored);
    } catch {
      /* localStorage unavailable — keep English */
    }
  }, []);

  const setLang = useCallback((next: UiLang) => {
    setLangState(next);
    document.documentElement.lang = next;
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      /* ignore persistence failures (private mode, etc.) */
    }
    // Mirror to a cookie so an SSR pass can read the preference too.
    writePreferenceCookie(LANG_STORAGE_KEY, next);
  }, []);

  const toggleLang = useCallback(() => {
    setLang(lang === 'en' ? 'hi' : 'en');
  }, [lang, setLang]);

  const t = useCallback((key: string) => translate(lang, key), [lang]);

  const value = useMemo(
    () => ({ lang, setLang, toggleLang, t }),
    [lang, setLang, toggleLang, t],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider');
  return ctx;
}

/** Shorthand for components that only need the translator. */
export function useT(): (key: string) => string {
  return useLanguage().t;
}
