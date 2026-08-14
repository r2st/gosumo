import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider, langInitScript, useLanguage, useT } from './language-provider';
import { LANG_STORAGE_KEY, translate } from '@/lib/i18n';

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

function LangProbe() {
  const { lang, setLang, toggleLang, t } = useLanguage();
  return (
    <div>
      <span data-testid="lang">{lang}</span>
      <span data-testid="label">{t('nav.leads')}</span>
      <button onClick={toggleLang}>toggle</button>
      <button onClick={() => setLang('hi')}>go-hi</button>
      <button onClick={() => setLang('en')}>go-en</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <LanguageProvider>
      <LangProbe />
    </LanguageProvider>,
  );
}

describe('LanguageProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = '';
    document.cookie = `${LANG_STORAGE_KEY}=; path=/; max-age=0`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in English so the server and first client render agree', () => {
    // Reading localStorage during render would produce different markup on the
    // server than on the client and trip a hydration mismatch.
    renderProvider();
    expect(screen.getByTestId('lang')).toHaveTextContent('en');
    expect(screen.getByTestId('label')).toHaveTextContent('Leads');
  });

  it('applies a saved Hindi preference after mount', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'hi');
    renderProvider();
    expect(screen.getByTestId('lang')).toHaveTextContent('hi');
    expect(screen.getByTestId('label')).toHaveTextContent(translate('hi', 'nav.leads'));
  });

  it('ignores a stored value that is not a supported language', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'fr');
    renderProvider();
    expect(screen.getByTestId('lang')).toHaveTextContent('en');
  });

  it('falls back to English when localStorage throws', () => {
    // Safari private mode throws on access rather than returning null.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => renderProvider()).not.toThrow();
    expect(screen.getByTestId('lang')).toHaveTextContent('en');
  });

  it('switches language, re-translating every consumer', () => {
    renderProvider();
    act(() => {
      screen.getByText('go-hi').click();
    });
    expect(screen.getByTestId('lang')).toHaveTextContent('hi');
    expect(screen.getByTestId('label')).toHaveTextContent(translate('hi', 'nav.leads'));
  });

  it('persists the choice to localStorage', () => {
    renderProvider();
    act(() => {
      screen.getByText('go-hi').click();
    });
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe('hi');
  });

  it('mirrors the choice to a cookie so an SSR pass can read it', () => {
    renderProvider();
    act(() => {
      screen.getByText('go-hi').click();
    });
    expect(document.cookie).toContain(`${LANG_STORAGE_KEY}=hi`);
  });

  it('sets <html lang> so screen readers and fonts pick the right language', () => {
    renderProvider();
    act(() => {
      screen.getByText('go-hi').click();
    });
    expect(document.documentElement.lang).toBe('hi');
    act(() => {
      screen.getByText('go-en').click();
    });
    expect(document.documentElement.lang).toBe('en');
  });

  it('still switches when persistence fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    renderProvider();
    act(() => {
      screen.getByText('go-hi').click();
    });
    // The preference is lost on reload, but the current session must not break.
    expect(screen.getByTestId('lang')).toHaveTextContent('hi');
  });

  it('toggles between the two languages', () => {
    renderProvider();
    act(() => {
      screen.getByText('toggle').click();
    });
    expect(screen.getByTestId('lang')).toHaveTextContent('hi');
    act(() => {
      screen.getByText('toggle').click();
    });
    expect(screen.getByTestId('lang')).toHaveTextContent('en');
  });
});

describe('useT', () => {
  it('translates in the current language', () => {
    function TProbe() {
      const t = useT();
      const { toggleLang } = useLanguage();
      return (
        <div>
          <span data-testid="t">{t('nav.settings')}</span>
          <button onClick={toggleLang}>toggle</button>
        </div>
      );
    }
    render(
      <LanguageProvider>
        <TProbe />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('t')).toHaveTextContent('Settings');
    act(() => {
      screen.getByText('toggle').click();
    });
    expect(screen.getByTestId('t')).toHaveTextContent(translate('hi', 'nav.settings'));
  });
});

describe('useLanguage outside a provider', () => {
  it('throws, so a misplaced consumer fails loudly instead of rendering English forever', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Orphan() {
      useLanguage();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow(/must be used within a LanguageProvider/);
    spy.mockRestore();
  });
});

describe('langInitScript', () => {
  it('references the same storage key the provider writes', () => {
    expect(langInitScript).toContain(LANG_STORAGE_KEY);
  });

  it('applies a saved language to <html lang> before first paint', () => {
    // The script runs inline in <head>, ahead of React, to stop a flash of the
    // wrong language. Evaluating it here proves it actually does that.
    localStorage.setItem(LANG_STORAGE_KEY, 'hi');
    document.documentElement.lang = '';
    act(() => {
      // eslint-disable-next-line no-eval
      (0, eval)(langInitScript);
    });
    expect(document.documentElement.lang).toBe('hi');
  });

  it('leaves <html lang> alone when nothing is stored', () => {
    localStorage.clear();
    document.documentElement.lang = 'en';
    (0, eval)(langInitScript);
    expect(document.documentElement.lang).toBe('en');
  });

  it('ignores an unsupported stored value', () => {
    localStorage.setItem(LANG_STORAGE_KEY, 'de');
    document.documentElement.lang = 'en';
    (0, eval)(langInitScript);
    expect(document.documentElement.lang).toBe('en');
  });

  it('swallows a localStorage failure rather than blocking first paint', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => (0, eval)(langInitScript)).not.toThrow();
    vi.restoreAllMocks();
  });
});
