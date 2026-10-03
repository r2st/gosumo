import { render, screen, act } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, THEME_STORAGE_KEY, useTheme } from './theme-provider';

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

let matchMediaListeners: Array<(e: { matches: boolean }) => void> = [];
let prefersDark = false;

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new LocalStorageMock(),
    configurable: true,
    writable: true,
  });

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' || query === '(prefers-color-scheme:dark)'
        ? prefersDark
        : false,
      media: query,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
        matchMediaListeners.push(fn);
      },
      removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => {
        matchMediaListeners = matchMediaListeners.filter((l) => l !== fn);
      },
    })),
  });
});

function ThemeProbe() {
  const { theme, resolved, toggleTheme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolved}</span>
      <button onClick={toggleTheme}>toggle</button>
      <button onClick={() => setTheme('dark')}>go-dark</button>
      <button onClick={() => setTheme('system')}>go-system</button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    prefersDark = false;
    matchMediaListeners = [];
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

  it('toggles light → dark → system → light and persists', () => {
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    act(() => screen.getByText('toggle').click());
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    act(() => screen.getByText('toggle').click());
    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');

    act(() => screen.getByText('toggle').click());
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
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
});

describe('system theme mode', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    prefersDark = false;
    matchMediaListeners = [];
  });

  it('resolves to light when OS prefers light', () => {
    prefersDark = false;
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('resolves to dark when OS prefers dark', () => {
    prefersDark = true;
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(screen.getByTestId('resolved').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('reacts to OS theme changes when in system mode', () => {
    prefersDark = false;
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    act(() => screen.getByText('go-system').click());
    expect(screen.getByTestId('theme').textContent).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => {
      prefersDark = true;
      matchMediaListeners.forEach((fn) => fn({ matches: true }));
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('ThemeProvider initialisation edge cases', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    prefersDark = false;
    matchMediaListeners = [];
  });

  it('honours an explicitly stored light preference over the <html> class', () => {
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
