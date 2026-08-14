import { render, screen, act } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, THEME_STORAGE_KEY, useTheme } from './theme-provider';

// This jsdom environment runs on an opaque origin, where `localStorage` is not
// exposed. Install a minimal in-memory stand-in so the provider (and these
// tests) can exercise persistence.
class LocalStorageMock {
  private store: Record<string, string> = {};
  clear() {
    this.store = {};
  }
  getItem(key: string) {
    return this.store[key] ?? null;
  }
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  }
  removeItem(key: string) {
    delete this.store[key];
  }
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new LocalStorageMock(),
    configurable: true,
    writable: true,
  });
});

function ThemeProbe() {
  const { theme, toggleTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={toggleTheme}>toggle</button>
      <button onClick={() => setTheme('dark')}>go-dark</button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('defaults to light when nothing is stored', () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggles to dark, applies the class to <html>, and persists the choice', () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    act(() => {
      screen.getByText('toggle').click();
    });

    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('initialises from a stored preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggles back to light and removes the class', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    act(() => {
      screen.getByText('toggle').click();
    });
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('ThemeProvider initialisation edge cases', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('honours an explicitly stored light preference over the <html> class', () => {
    // The pre-hydration script may already have set `dark` on <html>. A stored
    // 'light' has to win, or a user who deliberately switched back to light
    // sees the page flip to dark on every reload.
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    document.documentElement.classList.add('dark');

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('ignores a stored value that is not a theme', () => {
    // Anything else in that key — a stale format, another app on the same
    // origin — must fall through to the <html> class rather than be trusted.
    localStorage.setItem(THEME_STORAGE_KEY, 'solarized');
    document.documentElement.classList.add('dark');

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('theme').textContent).toBe('dark');
  });
});

describe('useTheme outside a provider', () => {
  it('throws a named error rather than returning undefined', () => {
    // Without the guard the hook returns undefined and the caller crashes on
    // `theme` — a stack trace pointing at the consumer, not the missing
    // provider that actually caused it.
    const consoleError = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<ThemeProbe />)).toThrow(
        'useTheme must be used within a ThemeProvider',
      );
    } finally {
      console.error = consoleError;
    }
  });
});
