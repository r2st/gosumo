'use client';

import { createContext, useCallback, useContext, useState } from 'react';

export type Theme = 'dark';

export const THEME_STORAGE_KEY = 'gosumo-theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const themeInitScript = `(function(){document.documentElement.classList.add('dark');document.documentElement.style.colorScheme='dark';})();`;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme] = useState<Theme>('dark');

  const setTheme = useCallback((_next: Theme) => {
    // Dark-only — no-op
  }, []);

  const toggleTheme = useCallback(() => {
    // Dark-only — no-op
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
