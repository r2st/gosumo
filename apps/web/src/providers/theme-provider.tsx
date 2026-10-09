'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'desk-theme';
const LEGACY_THEME_KEY = 'gosumo-theme';

function migrateThemeKey(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const old = window.localStorage.getItem(LEGACY_THEME_KEY);
  if (old && !window.localStorage.getItem(THEME_STORAGE_KEY)) {
    window.localStorage.setItem(THEME_STORAGE_KEY, old);
    window.localStorage.removeItem(LEGACY_THEME_KEY);
  }
}
migrateThemeKey();

const VALID_THEMES: Theme[] = ['light', 'dark', 'system'];

interface ThemeContextValue {
  theme: Theme;
  resolved: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    if (typeof window === 'undefined') return 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

function applyTheme(resolved: 'light' | 'dark'): void {
  const el = document.documentElement;
  if (resolved === 'dark') {
    el.classList.add('dark');
    el.style.colorScheme = 'dark';
  } else {
    el.classList.remove('dark');
    el.style.colorScheme = 'light';
  }
}

function readStored(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v && VALID_THEMES.includes(v as Theme)) return v as Theme;
  } catch {
    // localStorage unavailable
  }
  return null;
}

function persist(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable
  }
}

export const themeInitScript = `(function(){
  try{
    var t=localStorage.getItem('${THEME_STORAGE_KEY}');
    var d=document.documentElement;
    if(t==='light'){d.classList.remove('dark');d.style.colorScheme='light'}
    else if(t==='system'){
      var m=window.matchMedia('(prefers-color-scheme:dark)').matches;
      if(m){d.classList.add('dark');d.style.colorScheme='dark'}
      else{d.classList.remove('dark');d.style.colorScheme='light'}
    }else{d.classList.add('dark');d.style.colorScheme='dark'}
  }catch(e){d.classList.add('dark');d.style.colorScheme='dark'}
})();`;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const stored = readStored();
    if (stored) return stored;
    const htmlHasDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    return htmlHasDark ? 'dark' : 'light';
  });

  const resolved = resolveTheme(theme);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme(resolveTheme('system'));
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    persist(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const order: Theme[] = ['light', 'dark', 'system'];
      const idx = order.indexOf(prev);
      const next = order[(idx + 1) % order.length];
      persist(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
